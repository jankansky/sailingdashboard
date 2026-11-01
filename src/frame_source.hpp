#pragma once
#include <memory>
#include <string>
#include <string_view>

#include "can_frame.hpp"

// Somewhere CAN frames come from: a SocketCAN interface, an SLCAN serial
// adapter, a recorded candump log, or the built-in simulator.
class FrameSource {
public:
    virtual ~FrameSource() = default;
    virtual bool open() = 0;
    // 1 = frame read, 0 = timeout, -1 = error (caller closes and reopens).
    virtual int read(CanFrame& frame, int timeoutMs) = 0;
    virtual void close() {}
    virtual std::string describe() const = 0;
};

std::unique_ptr<FrameSource> makeSocketCanSource(const std::string& interface);
std::unique_ptr<FrameSource> makeSlcanSource(const std::string& device);
std::unique_ptr<FrameSource> makeReplaySource(const std::string& path, bool loop);
// Simulated boat starting at the given position (degrees).
std::unique_ptr<FrameSource> makeSimulatorSource(double lat, double lon);

// Parses one line of a candump log: "(1730470000.123456) can0 09F80102#0102..." or
// "can0  09F80102   [8]  01 02 ...". tsSec is NaN when the line has no timestamp.
// "imu" lines (see Recorder) become kImuFrameId frames.
bool parseLogLine(std::string_view line, CanFrame& frame, double& tsSec);
