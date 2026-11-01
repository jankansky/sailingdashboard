#pragma once
#include <cstdint>

// A single extended (29-bit) CAN frame. NMEA 2000 only uses extended frames.
struct CanFrame {
    uint32_t id = 0;
    uint8_t len = 0;
    uint8_t data[8] = {};
};
