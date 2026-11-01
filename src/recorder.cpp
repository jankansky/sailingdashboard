#include "recorder.hpp"

#include <dirent.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
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

uint64_t freeBytes(const std::string& dir) {
    struct statvfs v{};
    if (statvfs(dir.c_str(), &v) != 0) return 0;
    return static_cast<uint64_t>(v.f_bavail) * v.f_frsize;
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
    std::lock_guard lock(mu_);
    closeFile();
}

void Recorder::write(const CanFrame& f) {
    int64_t now = wallClockUs();
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
    if (file_ && (now - lastWriteUs_ > kIdleUs || now - startUs_ > kMaxFileUs)) closeFile();
    if (!file_) {
        if (now - lastOpenUs_ < 30 * kSecond) return;  // failed recently; don't retry for every frame
        openFile(now);
        if (!file_) return;
    }
    if (std::fwrite(line, 1, static_cast<size_t>(n), file_) != static_cast<size_t>(n)) {
        std::fprintf(stderr, "recording %s: write failed (%s)\n", name_.c_str(), std::strerror(errno));
        closeFile();
        return;
    }
    bytes_ += static_cast<uint64_t>(n);
    lastWriteUs_ = now;
    dirty_ = true;
}

void Recorder::tick() {
    int64_t now = wallClockUs();
    bool pruneNow = false;
    {
        std::lock_guard lock(mu_);
        if (file_ && dirty_) {
            std::fflush(file_);
            dirty_ = false;
            if (now - lastSyncUs_ > kSyncUs) {  // so a power cut loses seconds, not minutes
                fdatasync(fileno(file_));
                lastSyncUs_ = now;
            }
        }
        if (file_ && now - lastWriteUs_ > kIdleUs) closeFile();
        if (now - lastPruneUs_ > 60 * kSecond) {
            lastPruneUs_ = now;
            pruneNow = true;
        }
    }
    if (pruneNow) prune();
}

void Recorder::openFile(int64_t epochUs) {
    lastOpenUs_ = epochUs;
    time_t secs = static_cast<time_t>(epochUs / kSecond);
    tm local{};
    localtime_r(&secs, &local);
    char name[64];
    std::strftime(name, sizeof name, "%Y-%m-%d_%H%M%S.log", &local);
    std::string path = dir_ + "/" + name;
    file_ = std::fopen(path.c_str(), "a");
    if (!file_) {
        std::fprintf(stderr, "cannot record to %s: %s\n", path.c_str(), std::strerror(errno));
        return;
    }
    std::setvbuf(file_, nullptr, _IOFBF, 1 << 16);
    name_ = name;
    bytes_ = 0;
    startUs_ = lastWriteUs_ = lastSyncUs_ = epochUs;
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
    std::string current;
    {
        std::lock_guard lock(mu_);
        if (file_) current = name_;
    }
    uint64_t free = freeBytes(dir_);
    for (const Entry& e : files) {
        if (total <= maxBytes_ && free >= kMinFreeBytes) break;
        if (e.name == current) continue;
        if (unlink((dir_ + "/" + e.name).c_str()) == 0) {
            std::printf("deleted old recording %s to make room\n", e.name.c_str());
            total -= e.bytes;
            free += e.bytes;
        }
    }
}

std::string Recorder::statusJson() {
    int64_t now = wallClockUs();
    std::lock_guard lock(mu_);
    JsonWriter j;
    j.beginObj();
    j.boolean("enabled", true);
    j.str("file", file_ ? name_ : "");
    j.integer("bytes", file_ ? static_cast<int64_t>(bytes_) : 0);
    j.boolean("active", file_ && now - lastWriteUs_ < 5 * kSecond);
    j.integer("free", static_cast<int64_t>(freeBytes(dir_)));
    j.endObj();
    return j.out;
}
