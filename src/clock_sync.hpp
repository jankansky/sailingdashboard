#pragma once
#include <cstdint>
#include <limits>

#include "boat_state.hpp"

// Keeps the Pi's clock right on a boat without internet. Unless a HAT adds a
// battery-backed clock, the Pi starts each day at the time it last shut down.

// Sets the system clock from GPS time when they differ by more than 2 s.
// Needs CAP_SYS_TIME (the service grants it).
class ClockSync {
public:
    void tick(BoatState& state);  // about once a second

private:
    int agree_ = 0;  // readings in a row that agree on the error
    int64_t lastErrorMs_ = 0;
    bool gaveUp_ = false;
};

// Notices steps of the system clock, whether made by ClockSync or by internet
// time sync, so data already timestamped can be moved to match.
class ClockWatch {
public:
    int64_t tick();  // how far the clock stepped since the last call (us), or 0

private:
    int64_t offsetUs_ = std::numeric_limits<int64_t>::min();  // system clock minus steady clock
};
