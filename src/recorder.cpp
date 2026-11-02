#include "recorder.hpp"

#include <dirent.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <vector>

#include "json.hpp"

#ifdef __APPLE__
#define fdatasync fsync  // macOS (development) has no fdatasync
#endif

namespace {

constexpr int64_t kSecond = 1000000;
constexpr int64_t kIdleUs = 10 * 60 * kSecond;  // quiet bus: start a new file next time
constexpr int64_t kMaxFileUs = 12 * 3600 * kSecond;
constexpr int64_t kSyncUs = 10 * kSecond;  // force data onto the card this often
constexpr uint64_t kMinFreeBytes = 1ull << 30;  // leave 1 GB for the system

constexpr size_t kMaxPending = 16 << 20;  // frames held while a file is copied

std::string fileName(int64_t epochUs) {
    time_t secs = static_cast<time_t>(epochUs / kSecond);
    tm local{};
    localtime_r(&secs, &local);
    char name[64];
    std::strftime(name, sizeof name, "%Y-%m-%d_%H%M%S.log", &local);
    return name;
}

// Time of a candump line, "(1730470000.123456) can0 ...", and where its ")" is.
bool lineTime(const char* line, int64_t& us, const char*& close) {
    if (line[0] != '(') return false;
    char* dot;
    char* end;
    long long sec = std::strtoll(line + 1, &dot, 10);
    if (*dot != '.') return false;
    long long usec = std::strtoll(dot + 1, &end, 10);
    if (*end != ')' || end - dot != 7) return false;
    us = sec * kSecond + usec;
    close = end;
    return true;
}

uint64_t freeBytes(const std::string& dir) {
    struct statvfs v{};
    if (statvfs(dir.c_str(), &v) != 0) return 0;
    return static_cast<uint64_t>(v.f_bavail) * v.f_frsize;
}

int64_t steadyUs() {
    using namespace std::chrono;
    return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

}  // namespace

int64_t wallClockUs() {
    using namespace std::chrono;
    return duration_cast<microseconds>(system_clock::now().time_since_epoch()).count();
}

Recorder::Recorder(std::string dir, double maxGb)
    : dir_(std::move(dir)), maxBytes_(static_cast<uint64_t>(maxGb * (1ull << 30))) {
    if (mkdir(dir_.c_str(), 0755) != 0 && errno != EEXIST)
        std::fprintf(stderr, "cannot create recording directory %s: %s\n", dir_.c_str(), std::strerror(errno));
    else
        std::printf("recording the bus to %s\n", dir_.c_str());
}

Recorder::~Recorder() {
    if (copier_.joinable()) copier_.join();
    std::lock_guard lock(mu_);
    closeFile();
}

void Recorder::write(const CanFrame& f) {
    int64_t now = wallClockUs(), at = steadyUs();
    char line[96];
    int n;
    if (f.id == kImuFrameId) {
        n = std::snprintf(line, sizeof line, "(%lld.%06lld) imu 00000000#",
                          static_cast<long long>(now / kSecond), static_cast<long long>(now % kSecond));
    } else {
        n = std::snprintf(line, sizeof line, "(%lld.%06lld) can0 %08X#",
                          static_cast<long long>(now / kSecond), static_cast<long long>(now % kSecond), f.id);
    }
    for (int i = 0; i < f.len && i < 8; ++i) n += std::snprintf(line + n, sizeof line - n, "%02X", f.data[i]);
    line[n++] = '\n';

    std::lock_guard lock(mu_);
    if (copying_) {
        if (pending_.size() < kMaxPending) pending_.append(line, static_cast<size_t>(n));
        lastWriteAt_ = at;
        return;
    }
    if (file_ && (at - lastWriteAt_ > kIdleUs || at - openedAt_ > kMaxFileUs)) closeFile();
    if (!file_) {
        if (at - lastOpenAt_ < 30 * kSecond) return;  // failed recently; don't retry for every frame
        openFile(now);
        if (!file_) return;
    }
    if (std::fwrite(line, 1, static_cast<size_t>(n), file_) != static_cast<size_t>(n)) {
        std::fprintf(stderr, "recording %s: write failed (%s)\n", name_.c_str(), std::strerror(errno));
        closeFile();
        return;
    }
    bytes_ += static_cast<uint64_t>(n);
    lastWriteAt_ = at;
    dirty_ = true;
}

void Recorder::tick() {
    int64_t at = steadyUs();
    bool pruneNow = false;
    {
        std::lock_guard lock(mu_);
        if (file_ && dirty_) {
            std::fflush(file_);
            dirty_ = false;
            if (at - lastSyncAt_ > kSyncUs) {  // so a power cut loses seconds, not minutes
                fdatasync(fileno(file_));
                lastSyncAt_ = at;
            }
        }
        if (file_ && at - lastWriteAt_ > kIdleUs) closeFile();
        if (at - lastPruneAt_ > 60 * kSecond) {
            lastPruneAt_ = at;
            pruneNow = true;
        }
    }
    if (pruneNow) prune();
}

void Recorder::openFile(int64_t epochUs) {
    lastOpenAt_ = steadyUs();
    std::string name = fileName(epochUs);
    std::string path = dir_ + "/" + name;
    file_ = std::fopen(path.c_str(), "a");
    if (!file_) {
        std::fprintf(stderr, "cannot record to %s: %s\n", path.c_str(), std::strerror(errno));
        return;
    }
    std::setvbuf(file_, nullptr, _IOFBF, 1 << 16);
    name_ = name;
    bytes_ = 0;
    startUs_ = epochUs;
    openedAt_ = lastWriteAt_ = lastSyncAt_ = lastOpenAt_;
    std::printf("recording to %s\n", path.c_str());
}

void Recorder::closeFile() {
    if (!file_) return;
    std::fflush(file_);
    fdatasync(fileno(file_));
    std::fclose(file_);
    file_ = nullptr;
    dirty_ = false;
}

// Deletes the oldest recordings until they fit the size limit and the card has room.
void Recorder::prune() {
    struct Entry {
        std::string name;
        uint64_t bytes;
    };
    std::vector<Entry> files;
    uint64_t total = 0;
    if (DIR* d = opendir(dir_.c_str())) {
        while (dirent* e = readdir(d)) {
            std::string n = e->d_name;
            if (n.size() < 5 || n.compare(n.size() - 4, 4, ".log") != 0) continue;
            struct stat st{};
            if (stat((dir_ + "/" + n).c_str(), &st) != 0 || !S_ISREG(st.st_mode)) continue;
            files.push_back({n, static_cast<uint64_t>(st.st_size)});
            total += static_cast<uint64_t>(st.st_size);
        }
        closedir(d);
    }
    std::sort(files.begin(), files.end(), [](const Entry& a, const Entry& b) { return a.name < b.name; });
    std::string current, source;
    {
        std::lock_guard lock(mu_);
        if (file_ || copying_) current = name_;
        source = copyFrom_;
    }
    uint64_t free = freeBytes(dir_);
    for (const Entry& e : files) {
        if (total <= maxBytes_ && free >= kMinFreeBytes) break;
        if (e.name == current || e.name == source) continue;
        if (unlink((dir_ + "/" + e.name).c_str()) == 0) {
            std::printf("deleted old recording %s to make room\n", e.name.c_str());
            total -= e.bytes;
            free += e.bytes;
        }
    }
}

std::string Recorder::statusJson() {
    int64_t at = steadyUs();
    std::lock_guard lock(mu_);
    JsonWriter j;
    j.beginObj();
    j.boolean("enabled", true);
    j.str("file", file_ || copying_ ? name_ : "");
    j.integer("bytes", file_ ? static_cast<int64_t>(bytes_) : 0);
    j.boolean("active", (file_ || copying_) && at - lastWriteAt_ < 5 * kSecond);
    j.integer("free", static_cast<int64_t>(freeBytes(dir_)));
    j.endObj();
    return j.out;
}

void Recorder::clockStepped(int64_t deltaUs) {
    std::lock_guard lock(mu_);
    if (copying_ || !file_) return;
    std::string from = name_, to = fileName(startUs_ + deltaUs);
    struct stat st{};
    if (stat((dir_ + "/" + to).c_str(), &st) == 0) return;  // name taken: leave this file as it is
    closeFile();
    startUs_ += deltaUs;
    name_ = to;
    copyFrom_ = from;
    copying_ = true;
    if (copier_.joinable()) copier_.join();
    copier_ = std::thread(&Recorder::copyShifted, this, from, to, deltaUs);
}

void Recorder::copyShifted(std::string from, std::string to, int64_t deltaUs) {
    FILE* in = std::fopen((dir_ + "/" + from).c_str(), "r");
    FILE* out = std::fopen((dir_ + "/" + to).c_str(), "w");
    if (out) std::setvbuf(out, nullptr, _IOFBF, 1 << 16);
    uint64_t bytes = 0;
    bool ok = in && out;
    if (ok) {
        // Lines written after the step (between it and this call) already have the
        // new time: they start where the times jump by about deltaUs.
        char line[256];
        int64_t prev = -1;
        bool after = false;
        while (std::fgets(line, sizeof line, in)) {
            int64_t t;
            const char* close;
            if (!lineTime(line, t, close)) {
                bytes += std::fwrite(line, 1, std::strlen(line), out);
                continue;
            }
            if (!after && prev >= 0 && (deltaUs > 0 ? t - prev > deltaUs / 2 : t - prev < deltaUs / 2)) after = true;
            prev = t;
            if (!after) t += deltaUs;
            bytes += static_cast<uint64_t>(std::fprintf(out, "(%lld.%06lld%s", static_cast<long long>(t / kSecond),
                                                        static_cast<long long>(t % kSecond), close));
        }
        ok = !std::ferror(in) && !std::ferror(out);
    }
    if (in) std::fclose(in);

    std::lock_guard lock(mu_);
    copying_ = false;
    copyFrom_.clear();
    if (!ok) {
        std::fprintf(stderr, "could not correct the times in recording %s; left as it was\n", from.c_str());
        if (out) {
            std::fclose(out);
            unlink((dir_ + "/" + to).c_str());
        }
        pending_.clear();  // the next frame starts a new file
        lastOpenAt_ = std::numeric_limits<int64_t>::min() / 2;
        return;
    }
    bytes += std::fwrite(pending_.data(), 1, pending_.size(), out);
    std::string().swap(pending_);
    unlink((dir_ + "/" + from).c_str());
    file_ = out;
    bytes_ = bytes;
    dirty_ = true;
    std::printf("clock set: recording %s is now %s, with its times corrected\n", from.c_str(), to.c_str());
}
