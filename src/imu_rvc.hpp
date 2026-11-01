#pragma once
#include <atomic>
#include <string>

#include "boat_state.hpp"

// Reads heel and pitch from a BNO085/BNO086 in UART-RVC mode (the chip streams
// yaw/pitch/roll at 100 Hz on its TX pin). Reconnects until `stop` is set.
void runImuRvc(const std::string& device, BoatState& state, const std::atomic<bool>& stop);
