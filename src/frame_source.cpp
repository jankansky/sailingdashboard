#include "frame_source.hpp"
#include "serial_port.hpp"

#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <optional>
#include <sstream>
#include <thread>

#ifdef __linux__
#include <linux/can.h>
#include <linux/can/raw.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#endif

namespace {

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Parses n hex digits; false if any is invalid.
bool parseHex(const char* s, size_t n, uint32_t& out) {
    out = 0;
    for (size_t i = 0; i < n; ++i) {
        int v = hexValue(s[i]);
        if (v < 0) return false;
        out = out << 4 | static_cast<uint32_t>(v);
    }
    return true;
}

bool parseHexBytes(const std::string& s, CanFrame& f) {
    if (s.size() % 2 || s.size() > 16) return false;
    f.len = static_cast<uint8_t>(s.size() / 2);
    for (size_t i = 0; i < f.len; ++i) {
        uint32_t b;
        if (!parseHex(s.data() + 2 * i, 2, b)) return false;
        f.data[i] = static_cast<uint8_t>(b);
    }
    return true;
}

// ---------------------------------------------------------------- SocketCAN

#ifdef __linux__
class SocketCanSource : public FrameSource {
public:
    explicit SocketCanSource(std::string interface) : interface_(std::move(interface)) {}
    ~SocketCanSource() override { close(); }

    bool open() override {
        fd_ = socket(PF_CAN, SOCK_RAW, CAN_RAW);
        if (fd_ < 0) {
            std::perror("socket(PF_CAN)");
            return false;
        }
        ifreq ifr{};
        std::strncpy(ifr.ifr_name, interface_.c_str(), IFNAMSIZ - 1);
        if (ioctl(fd_, SIOCGIFINDEX, &ifr) < 0) {
            std::fprintf(stderr, "CAN interface %s not found (is the adapter plugged in?)\n", interface_.c_str());
            close();
            return false;
        }
        sockaddr_can addr{};
        addr.can_family = AF_CAN;
        addr.can_ifindex = ifr.ifr_ifindex;
        if (bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
            std::perror("bind(can)");
            close();
            return false;
        }
        return true;
    }

    int read(CanFrame& f, int timeoutMs) override {
        pollfd p{fd_, POLLIN, 0};
        int r = poll(&p, 1, timeoutMs);
        if (r < 0) return errno == EINTR ? 0 : -1;
        if (r == 0) return 0;
        if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
        can_frame cf{};
        ssize_t n = ::read(fd_, &cf, sizeof cf);
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN) return 0;
            std::fprintf(stderr, "CAN read on %s: %s\n", interface_.c_str(), std::strerror(errno));
            return -1;
        }
        if (n != sizeof cf || !(cf.can_id & CAN_EFF_FLAG) || (cf.can_id & (CAN_RTR_FLAG | CAN_ERR_FLAG)))
            return 0;
        f.id = cf.can_id & CAN_EFF_MASK;
        f.len = cf.can_dlc > 8 ? 8 : cf.can_dlc;
        std::memcpy(f.data, cf.data, f.len);
        return 1;
    }

    void close() override {
        if (fd_ >= 0) ::close(fd_);
        fd_ = -1;
    }

    std::string describe() const override { return "socketcan:" + interface_; }

private:
    std::string interface_;
    int fd_ = -1;
};
#endif

// ---------------------------------------------------------------- SLCAN (serial)

// CANable adapters running the "slcan" firmware show up as /dev/ttyACM0
// instead of can0. This talks the ASCII protocol directly.
class SlcanSource : public FrameSource {
public:
    explicit SlcanSource(std::string device) : device_(std::move(device)) {}
    ~SlcanSource() override { close(); }

    bool open() override {
        fd_ = openSerialPort(device_);
        if (fd_ < 0) return false;
        // Close (in case it was left open), 250 kbit/s, open.
        for (const char* cmd : {"C\r", "S5\r", "O\r"}) {
            if (::write(fd_, cmd, std::strlen(cmd)) < 0) {
                std::fprintf(stderr, "write %s: %s\n", device_.c_str(), std::strerror(errno));
                close();
                return false;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        buf_.clear();
        return true;
    }

    int read(CanFrame& f, int timeoutMs) override {
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
        for (;;) {
            // Consume complete lines already buffered.
            size_t end;
            while ((end = buf_.find_first_of("\r\a")) != std::string::npos) {
                std::string line = buf_.substr(0, end);
                buf_.erase(0, end + 1);
                if (parseLine(line, f)) return 1;
            }
            if (buf_.size() > 4096) buf_.clear();

            int remaining = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                                 deadline - std::chrono::steady_clock::now()).count());
            if (remaining <= 0) return 0;
            pollfd p{fd_, POLLIN, 0};
            int r = poll(&p, 1, remaining);
            if (r < 0) return errno == EINTR ? 0 : -1;
            if (r == 0) return 0;
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) return -1;
            char tmp[512];
            ssize_t n = ::read(fd_, tmp, sizeof tmp);
            if (n < 0) {
                if (errno == EAGAIN || errno == EINTR) continue;
                return -1;
            }
            if (n == 0) return -1;  // device went away
            buf_.append(tmp, static_cast<size_t>(n));
        }
    }

    void close() override {
        if (fd_ >= 0) {
            (void)::write(fd_, "C\r", 2);
            ::close(fd_);
        }
        fd_ = -1;
    }

    std::string describe() const override { return "slcan:" + device_; }

private:
    // Extended data frame: Tiiiiiiiil<data hex>[timestamp]
    static bool parseLine(const std::string& line, CanFrame& f) {
        if (line.size() < 10 || line[0] != 'T') return false;
        uint32_t id, len;
        if (!parseHex(line.data() + 1, 8, id) || !parseHex(line.data() + 9, 1, len) || len > 8) return false;
        if (line.size() < 10 + 2 * len) return false;
        f.id = id & 0x1FFFFFFF;
        return parseHexBytes(line.substr(10, 2 * len), f);
    }

    std::string device_;
    int fd_ = -1;
    std::string buf_;
};

// ---------------------------------------------------------------- candump log replay

// Replays logs from `candump -l can0` ("(ts) can0 ID#DATA") or plain
// `candump can0` output ("can0  ID   [8]  01 02 ..."), paced in real time.
class ReplaySource : public FrameSource {
public:
    ReplaySource(std::string path, bool loop) : path_(std::move(path)), loop_(loop) {}

    bool open() override {
        in_.close();
        in_.clear();
        in_.open(path_);
        if (!in_) {
            std::fprintf(stderr, "cannot open replay file %s\n", path_.c_str());
            return false;
        }
        firstTs_.reset();
        start_ = std::chrono::steady_clock::now();
        pending_.reset();
        lineNo_ = 0;
        return true;
    }

    int read(CanFrame& f, int timeoutMs) override {
        auto now = std::chrono::steady_clock::now();
        if (!pending_) {
            if (!nextFrame()) {
                if (loop_ && lineNo_ > 0) {
                    open();
                    return 0;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
                return 0;
            }
        }
        if (pending_->due > now + std::chrono::milliseconds(timeoutMs)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
            return 0;
        }
        std::this_thread::sleep_until(pending_->due);
        f = pending_->frame;
        pending_.reset();
        return 1;
    }

    std::string describe() const override { return "replay:" + path_; }

private:
    struct Pending {
        CanFrame frame;
        std::chrono::steady_clock::time_point due;
    };

    bool nextFrame() {
        std::string line;
        while (std::getline(in_, line)) {
            ++lineNo_;
            CanFrame f;
            std::optional<double> ts;
            if (!parse(line, f, ts)) continue;
            auto due = start_ + std::chrono::milliseconds(5 * lineNo_);
            if (ts) {
                if (!firstTs_) firstTs_ = *ts;
                due = start_ + std::chrono::microseconds(static_cast<int64_t>((*ts - *firstTs_) * 1e6));
            }
            pending_ = Pending{f, due};
            return true;
        }
        return false;
    }

    static bool parse(const std::string& line, CanFrame& f, std::optional<double>& ts) {
        std::istringstream ss(line);
        std::string tok;
        if (!(ss >> tok)) return false;
        if (tok.front() == '(') {
            ts = std::strtod(tok.c_str() + 1, nullptr);
            std::string iface, frame;
            if (!(ss >> iface >> frame)) return false;
            auto hash = frame.find('#');
            if (hash == std::string::npos || hash > 8) return false;
            uint32_t id;
            if (!parseHex(frame.data(), hash, id)) return false;
            f.id = id & 0x1FFFFFFF;
            return parseHexBytes(frame.substr(hash + 1), f);
        }
        // tok is the interface name
        std::string idStr, lenStr;
        if (!(ss >> idStr >> lenStr) || idStr.size() > 8 || lenStr.size() < 3 || lenStr[0] != '[') return false;
        uint32_t id;
        if (!parseHex(idStr.data(), idStr.size(), id)) return false;
        f.id = id & 0x1FFFFFFF;
        int len = std::atoi(lenStr.c_str() + 1);
        if (len < 0 || len > 8) return false;
        f.len = static_cast<uint8_t>(len);
        for (int i = 0; i < len; ++i) {
            std::string b;
            uint32_t v;
            if (!(ss >> b) || b.size() != 2 || !parseHex(b.data(), 2, v)) return false;
            f.data[i] = static_cast<uint8_t>(v);
        }
        return true;
    }

    std::string path_;
    bool loop_;
    std::ifstream in_;
    std::optional<double> firstTs_;
    std::chrono::steady_clock::time_point start_;
    std::optional<Pending> pending_;
    size_t lineNo_ = 0;
};

#ifndef __linux__
class UnsupportedSource : public FrameSource {
public:
    explicit UnsupportedSource(std::string interface) : interface_(std::move(interface)) {}
    bool open() override {
        std::fprintf(stderr, "SocketCAN is only available on Linux; use --sim, --replay or --slcan here\n");
        return false;
    }
    int read(CanFrame&, int) override { return -1; }
    std::string describe() const override { return "socketcan:" + interface_ + " (unsupported)"; }

private:
    std::string interface_;
};
#endif

}  // namespace

std::unique_ptr<FrameSource> makeSocketCanSource(const std::string& interface) {
#ifdef __linux__
    return std::make_unique<SocketCanSource>(interface);
#else
    return std::make_unique<UnsupportedSource>(interface);
#endif
}

std::unique_ptr<FrameSource> makeSlcanSource(const std::string& device) {
    return std::make_unique<SlcanSource>(device);
}

std::unique_ptr<FrameSource> makeReplaySource(const std::string& path, bool loop) {
    return std::make_unique<ReplaySource>(path, loop);
}
