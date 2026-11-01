#include "imu_rvc.hpp"

#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <thread>
#include <vector>

#include "serial_port.hpp"

namespace {

constexpr double kRad = 3.14159265358979323846 / 180.0;

// RVC packet: AA AA, index, yaw, pitch, roll (int16 LE, 0.01 deg),
// accel x/y/z (int16, mg), 3 reserved bytes, checksum (sum of bytes 2..17).
constexpr size_t kPacketLen = 19;

int16_t i16(const uint8_t* p) { return static_cast<int16_t>(p[0] | p[1] << 8); }

// Consumes complete packets from buf; returns true if any valid one was found.
bool parse(std::vector<uint8_t>& buf, double& pitchDeg, double& rollDeg) {
    bool found = false;
    size_t i = 0;
    while (buf.size() - i >= kPacketLen) {
        const uint8_t* p = buf.data() + i;
        if (p[0] != 0xAA || p[1] != 0xAA) {
            ++i;
            continue;
        }
        uint8_t sum = 0;
        for (size_t k = 2; k < 18; ++k) sum = static_cast<uint8_t>(sum + p[k]);
        if (sum != p[18]) {
            ++i;  // false header inside data; resync
            continue;
        }
        pitchDeg = i16(p + 5) * 0.01;
        rollDeg = i16(p + 7) * 0.01;
        found = true;
        i += kPacketLen;
    }
    buf.erase(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(i));
    return found;
}

}  // namespace

void runImuRvc(const std::string& device, BoatState& state, const std::atomic<bool>& stop,
               const std::function<void(const CanFrame&)>& record) {
    auto lastRecord = std::chrono::steady_clock::time_point{};
    while (!stop) {
        int fd = openSerialPort(device);
        if (fd < 0) {
            for (int i = 0; i < 20 && !stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        std::printf("reading BNO085 heel/pitch from %s\n", device.c_str());
        std::vector<uint8_t> buf;
        int silentMs = 0;
        while (!stop) {
            pollfd p{fd, POLLIN, 0};
            int r = poll(&p, 1, 500);
            if (r < 0 && errno != EINTR) break;
            if (r <= 0) {
                if ((silentMs += 500) == 3000)
                    std::fprintf(stderr, "no data from IMU on %s (wiring? P0 pin high for RVC mode?)\n", device.c_str());
                continue;
            }
            if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) break;
            uint8_t tmp[256];
            ssize_t n = ::read(fd, tmp, sizeof tmp);
            if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
            if (n <= 0) break;
            buf.insert(buf.end(), tmp, tmp + n);
            double pitch, roll;
            if (parse(buf, pitch, roll)) {
                silentMs = 0;
                {
                    std::lock_guard lock(state.mu);
                    state.imuPitch = pitch * kRad;
                    state.imuRoll = roll * kRad;
                    state.imuT.touch(state.now());
                }
                auto now = std::chrono::steady_clock::now();
                if (record && now - lastRecord >= std::chrono::milliseconds(100)) {
                    lastRecord = now;
                    CanFrame f;
                    f.id = kImuFrameId;
                    f.len = 4;
                    auto put = [&](int at, double rad) {
                        auto v = static_cast<int16_t>(std::lround(std::clamp(rad, -3.2, 3.2) * 1e4));
                        f.data[at] = static_cast<uint8_t>(v & 0xFF);
                        f.data[at + 1] = static_cast<uint8_t>((v >> 8) & 0xFF);
                    };
                    put(0, pitch * kRad);
                    put(2, roll * kRad);
                    record(f);
                }
            }
            if (buf.size() > 4096) buf.clear();
        }
        ::close(fd);
        if (!stop) std::fprintf(stderr, "lost IMU on %s, retrying\n", device.c_str());
    }
}
