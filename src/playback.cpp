#include "playback.hpp"

#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstring>

#include "frame_source.hpp"
#include "json.hpp"

namespace {

constexpr int64_t kSecond = 1000000;
constexpr int64_t kPrerollUs = 7 * 60 * kSecond;  // replayed before a jump: AIS names come every 6 min
constexpr int64_t kHistoryUs = 30 * 60 * kSecond;
constexpr int64_t kMaxGapUs = 10 * 60 * kSecond;  // longer gaps inside a file are clock steps
constexpr size_t kOverviewPoints = 600;

int64_t toUs(double tsSec) { return std::llround(tsSec * 1e6); }

// Timestamp of the first and last frame in a recording.
bool timeSpan(const std::string& path, int64_t& firstUs, int64_t& lastUs) {
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) return false;
    char line[256];
    CanFrame frame;
    double ts;
    bool haveFirst = false;
    for (int i = 0; i < 50 && std::fgets(line, sizeof line, f); ++i) {
        if (parseLogLine(line, frame, ts) && std::isfinite(ts)) {
            firstUs = toUs(ts);
            haveFirst = true;
            break;
        }
    }
    bool haveLast = false;
    if (haveFirst) {
        std::fseek(f, 0, SEEK_END);
        long size = std::ftell(f);
        std::string tail(static_cast<size_t>(std::min(size, 8192L)), '\0');
        std::fseek(f, size - static_cast<long>(tail.size()), SEEK_SET);
        tail.resize(std::fread(tail.data(), 1, tail.size(), f));
        size_t end = tail.size();
        while (!haveLast && end > 0) {
            size_t start = tail.rfind('\n', end - 1);
            start = start == std::string::npos ? 0 : start + 1;
            if (parseLogLine(std::string_view(tail).substr(start, end - start), frame, ts) && std::isfinite(ts)) {
                lastUs = toUs(ts);
                haveLast = true;
            }
            end = start ? start - 1 : 0;
        }
    }
    std::fclose(f);
    return haveFirst && haveLast;
}

}  // namespace

bool validRecordingName(const std::string& name) {
    if (name.size() < 5 || name.size() > 128 || name.compare(name.size() - 4, 4, ".log") != 0 || name[0] == '.')
        return false;
    return std::all_of(name.begin(), name.end(),
                       [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.'; });
}

std::vector<RecordingInfo> listRecordings(const std::string& dir) {
    std::vector<RecordingInfo> files;
    DIR* d = opendir(dir.c_str());
    if (!d) return files;
    while (dirent* e = readdir(d)) {
        RecordingInfo r;
        r.name = e->d_name;
        if (!validRecordingName(r.name)) continue;
        std::string path = dir + "/" + r.name;
        struct stat st{};
        if (stat(path.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) continue;
        r.bytes = static_cast<uint64_t>(st.st_size);
        int64_t first, last;
        if (!timeSpan(path, first, last)) continue;
        r.startMs = first / 1000;
        r.endMs = std::max(first, last) / 1000;
        files.push_back(r);
    }
    closedir(d);
    std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) { return a.startMs > b.startMs; });
    return files;
}

std::string recordingsJson(const std::vector<RecordingInfo>& files) {
    JsonWriter j;
    j.beginArr();
    for (const auto& r : files) {
        j.beginObj();
        j.str("name", r.name);
        j.integer("bytes", static_cast<int64_t>(r.bytes));
        j.integer("start", r.startMs);
        j.integer("end", r.endMs);
        j.endObj();
    }
    j.endArr();
    return j.out;
}

std::unique_ptr<Player> Player::open(const std::string& dir, const std::string& name, const Settings& settings,
                                     std::string& error) {
    if (!validRecordingName(name)) {
        error = "bad recording name";
        return nullptr;
    }
    std::unique_ptr<Player> p(new Player());
    p->name_ = name;
    p->settings_ = settings;
    p->file_ = std::fopen((dir + "/" + name).c_str(), "r");
    if (!p->file_) {
        error = "recording not found";
        return nullptr;
    }

    // One pass through the file: an index for seeking, and the wind history
    // as it would have been sampled live.
    BoatState scratch;
    scratch.settings = settings;
    n2k::Decoder decoder(scratch);
    char line[256];
    long offset = 0;
    int64_t shift = 0, lastUs = -1, nextSample = 0;
    while (std::fgets(line, sizeof line, p->file_)) {
        long at = offset;
        offset += static_cast<long>(std::strlen(line));
        CanFrame frame;
        double ts;
        if (!parseLogLine(line, frame, ts) || !std::isfinite(ts)) continue;
        int64_t us = toUs(ts) + shift;
        if (lastUs < 0) {
            p->startUs_ = us;
            nextSample = (us / kSecond + 1) * kSecond;
        } else if (us - lastUs > kMaxGapUs || us - lastUs < -10 * kSecond) {
            shift += lastUs + kSecond / 10 - us;
            us = lastUs + kSecond / 10;
            p->jumps_.push_back({at, shift});
        } else if (us < lastUs) {
            us = lastUs;
        }
        lastUs = us;
        while (p->startUs_ + static_cast<int64_t>(p->index_.size()) * kSecond <= us) p->index_.push_back(at);
        for (; nextSample <= us; nextSample += kSecond) {
            scratch.setPlaybackTime(nextSample);
            p->samples_.push_back(scratch.sampleHistory());
        }
        scratch.setPlaybackTime(us);
        decoder.handle(frame);
    }
    if (lastUs < 0) {
        error = "no timestamped frames in recording";
        return nullptr;
    }
    p->endUs_ = lastUs;
    if (p->index_.empty()) p->index_.push_back(0);

    {
        std::lock_guard lock(p->mu_);
        p->jump(p->startUs_);
    }
    p->thread_ = std::thread([raw = p.get()] { raw->run(); });
    return p;
}

Player::~Player() {
    stop_ = true;
    if (thread_.joinable()) thread_.join();
    if (file_) std::fclose(file_);
}

std::shared_ptr<BoatState> Player::state() {
    std::lock_guard lock(mu_);
    return state_;
}

void Player::setPlaying(bool on) {
    std::lock_guard lock(mu_);
    if (on && nowUs_ >= endUs_) jump(startUs_);  // play again from the start
    playing_ = on;
}

void Player::setSpeed(double speed) {
    std::lock_guard lock(mu_);
    speed_ = std::clamp(speed, 0.1, 120.0);
}

void Player::seek(int64_t epochMs) {
    std::lock_guard lock(mu_);
    int64_t us = epochMs * 1000;
    jump(us >= endUs_ - 1000 ? endUs_ : us);  // the end, in ms, can fall just short of the last frame
}

void Player::seekFile(int64_t epochUs) {
    int64_t k = std::clamp<int64_t>((epochUs - startUs_) / kSecond, 0, static_cast<int64_t>(index_.size()) - 1);
    offset_ = index_[static_cast<size_t>(k)];
    std::fseek(file_, offset_, SEEK_SET);
    shiftUs_ = 0;
    nextJump_ = 0;
    while (nextJump_ < jumps_.size() && jumps_[nextJump_].at < offset_) shiftUs_ = jumps_[nextJump_++].shiftUs;
    havePending_ = false;
}

bool Player::next(Line& out) {
    char line[256];
    while (std::fgets(line, sizeof line, file_)) {
        long at = offset_;
        offset_ += static_cast<long>(std::strlen(line));
        while (nextJump_ < jumps_.size() && jumps_[nextJump_].at <= at) shiftUs_ = jumps_[nextJump_++].shiftUs;
        double ts;
        if (!parseLogLine(line, out.frame, ts) || !std::isfinite(ts)) continue;
        out.us = toUs(ts) + shiftUs_;
        return true;
    }
    return false;
}

void Player::advance(int64_t epochUs, bool sample) {
    for (;;) {
        if (!havePending_) {
            if (!next(pending_)) break;
            havePending_ = true;
        }
        if (pending_.us > epochUs) break;
        for (; sample && nextSampleUs_ <= pending_.us; nextSampleUs_ += kSecond) {
            state_->setPlaybackTime(nextSampleUs_);
            state_->sampleHistory();
        }
        state_->setPlaybackTime(std::max(pending_.us, nowUs_));
        decoder_->handle(pending_.frame);
        havePending_ = false;
    }
    for (; sample && nextSampleUs_ <= epochUs; nextSampleUs_ += kSecond) {
        state_->setPlaybackTime(nextSampleUs_);
        state_->sampleHistory();
    }
    nowUs_ = epochUs;
    state_->setPlaybackTime(epochUs);
}

// Rebuilds the state at a new position: replays the few minutes before it, and
// takes the wind history from the samples made when the file was opened.
void Player::jump(int64_t epochUs) {
    epochUs = std::clamp(epochUs, startUs_, endUs_);
    auto state = std::make_shared<BoatState>();
    state->settings = settings_;
    state->sourceName = "recording " + name_;
    state->sourceConnected = true;
    state_ = state;
    decoder_ = std::make_unique<n2k::Decoder>(*state);
    nowUs_ = std::max(startUs_, epochUs - kPrerollUs);
    seekFile(nowUs_);
    advance(epochUs, false);

    std::deque<HistorySample> history;
    for (const auto& s : samples_)
        if (s.t * 1000 > epochUs - kHistoryUs && s.t * 1000 <= epochUs) history.push_back(s);
    state->setHistory(std::move(history));
    nextSampleUs_ = (epochUs / kSecond + 1) * kSecond;
}

void Player::run() {
    auto last = std::chrono::steady_clock::now();
    while (!stop_) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        auto now = std::chrono::steady_clock::now();
        double dt = std::chrono::duration<double>(now - last).count();
        last = now;
        std::lock_guard lock(mu_);
        if (!playing_) continue;
        int64_t target = nowUs_ + static_cast<int64_t>(dt * speed_ * kSecond);
        if (target >= endUs_) {
            target = endUs_;
            playing_ = false;
        }
        advance(target, true);
    }
}

std::string Player::statusJson() {
    std::lock_guard lock(mu_);
    JsonWriter j;
    j.beginObj();
    j.str("name", name_);
    j.integer("start", startUs_ / 1000);
    j.integer("end", endUs_ / 1000);
    j.integer("t", nowUs_ / 1000);
    j.boolean("playing", playing_);
    j.num("speed", speed_, 1);
    j.endObj();
    return j.out;
}

std::string Player::overviewJson() {
    JsonWriter j;
    j.beginArr();
    size_t step = std::max<size_t>(1, (samples_.size() + kOverviewPoints - 1) / kOverviewPoints);
    for (size_t i = 0; i < samples_.size(); i += step) {
        double sog = 0, tws = 0;
        int nSog = 0, nTws = 0;
        for (size_t k = i; k < std::min(samples_.size(), i + step); ++k) {
            if (std::isfinite(samples_[k].sog)) sog += samples_[k].sog, ++nSog;
            if (std::isfinite(samples_[k].tws)) tws += samples_[k].tws, ++nTws;
        }
        j.beginArr();
        j.integer(samples_[i].t);
        j.num(nSog ? sog / nSog : NAN);
        j.num(nTws ? tws / nTws : NAN);
        j.endArr();
    }
    j.endArr();
    return j.out;
}
