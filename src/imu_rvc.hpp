#pragma once
#include <atomic>
#include <functional>
#include <string>

#include "boat_state.hpp"
#include "can_frame.hpp"

// Reads heel and pitch from a BNO085/BNO086 in UART-RVC mode (the chip streams
// yaw/pitch/roll at 100 Hz on its TX pin). Reconnects until `stop` is set.
// `record`, if set, receives the readings 10 times a second as kImuFrameId frames.
void runImuRvc(const std::string& device, BoatState& state, const std::atomic<bool>& stop,
               const std::function<void(const CanFrame&)>& record);
