#include "clock_sync.hpp"

#include <chrono>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "recorder.hpp"

namespace {

constexpr int64_t kEarliestMs = 1735689600000;  // 2025-01-01: anything earlier is a bad GPS date
constexpr int64_t kMaxErrorMs = 2000;

}  // namespace

void ClockSync::tick(BoatState& state) {
    if (gaveUp_) return;
    int64_t gpsMs;
    {
        std::lock_guard lock(state.mu);
        auto now = state.now();
        // GNSS time only, with a fix: other devices' System Time may come from their own clocks.
        if (!state.utcT.fresh(now, 2) || !state.gnssT.fresh(now, 3) || state.fixMethod < 1 || state.fixMethod > 5) {
            agree_ = 0;
            return;
        }
        gpsMs = state.utcMs + static_cast<int64_t>(state.utcT.age(now) * 1000);
    }
    int64_t errorMs = gpsMs - wallClockUs() / 1000;
    if (gpsMs < kEarliestMs || std::llabs(errorMs) <= kMaxErrorMs) {
        agree_ = 0;
        return;
    }
    // Wait for three readings that agree, so one bad message can't set a wild time.
    agree_ = agree_ > 0 && std::llabs(errorMs - lastErrorMs_) < 1000 ? agree_ + 1 : 1;
    lastErrorMs_ = errorMs;
    if (agree_ < 3) return;
    agree_ = 0;

    timespec ts{static_cast<time_t>(gpsMs / 1000), static_cast<long>(gpsMs % 1000) * 1000000};
    if (clock_settime(CLOCK_REALTIME, &ts) != 0) {
        std::fprintf(stderr, "cannot set the clock from GPS (%s); it is %.1f s off\n", std::strerror(errno),
                     errorMs / 1000.0);
        gaveUp_ = true;
        return;
    }
    std::printf("set the clock from GPS: it was %.1f s %s\n", std::llabs(errorMs) / 1000.0,
                errorMs > 0 ? "slow" : "fast");
}

int64_t ClockWatch::tick() {
    using namespace std::chrono;
    int64_t offset = wallClockUs() - duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
    if (offsetUs_ == std::numeric_limits<int64_t>::min()) offsetUs_ = offset;
    int64_t step = offset - offsetUs_;
    offsetUs_ = offset;
    return std::llabs(step) > 1000000 ? step : 0;  // smaller changes are drift and slewing
}
