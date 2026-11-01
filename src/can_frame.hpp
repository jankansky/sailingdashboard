#pragma once
#include <cstdint>

// A single extended (29-bit) CAN frame. NMEA 2000 only uses extended frames.
struct CanFrame {
    uint32_t id = 0;
    uint8_t len = 0;
    uint8_t data[8] = {};
};

// Not a CAN frame: pitch and roll from the Pi's own IMU (int16, 0.0001 rad each),
// kept in recordings next to the bus traffic. Outside the 29-bit CAN ID range.
constexpr uint32_t kImuFrameId = 0x80000000u;
