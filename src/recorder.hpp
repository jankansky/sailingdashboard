#pragma once
#include <cstdint>
#include <cstdio>
#include <limits>
#include <mutex>
#include <string>
#include <thread>

#include "can_frame.hpp"

// Logs every frame from the bus to the SD card in candump format
// ("(1730470000.123456) can0 09F80102#0102030405060708"), so recordings can be
// replayed here or read by other NMEA 2000 tools. Readings from the Pi's IMU are
// stored as "imu" lines.
//
// A new file starts at each power-up and after the bus has been quiet for 10
// minutes, so each outing usually ends up in one file. The oldest files are
// deleted to stay under the size limit and keep space free on the card.
//
// When the system clock is set (from GPS or the internet), the open file's
// times are corrected and it's renamed for its true start; see clockStepped().
class Recorder {
public:
    Recorder(std::string dir, double maxGb);
    ~Recorder();

    void write(const CanFrame& frame);  // any thread
    // Call about once a second: flushes to the card and closes idle files.
    void tick();
    // The system clock moved by deltaUs. Copies the open file, with its times
    // corrected, to one named for the corrected start; new frames wait in memory.
    void clockStepped(int64_t deltaUs);

    std::string statusJson();  // {enabled, file, bytes, active, free}

private:
    void openFile(int64_t epochUs);  // caller holds mu_
    void closeFile();
    void prune();
    void copyShifted(std::string from, std::string to, int64_t deltaUs);  // runs on copier_

    std::mutex mu_;
    std::string dir_;
    uint64_t maxBytes_;
    FILE* file_ = nullptr;
    std::string name_;
    uint64_t bytes_ = 0;
    int64_t startUs_ = 0;  // system clock, for the file name
    // Steady clock, so setting the system clock doesn't look like the bus going quiet.
    int64_t openedAt_ = 0, lastWriteAt_ = 0, lastSyncAt_ = 0, lastPruneAt_ = 0;
    int64_t lastOpenAt_ = std::numeric_limits<int64_t>::min() / 2;
    bool dirty_ = false;
    // While a clock correction copies the file, file_ is null and frames go to pending_.
    bool copying_ = false;
    std::string copyFrom_;
    std::string pending_;
    std::thread copier_;
};

int64_t wallClockUs();
