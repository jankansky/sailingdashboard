#pragma once
#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>

#include "can_frame.hpp"

// Logs every frame from the bus to the SD card in candump format
// ("(1730470000.123456) can0 09F80102#0102030405060708"), so recordings can be
// replayed here or read by other NMEA 2000 tools. Readings from the Pi's IMU are
// stored as "imu" lines.
//
// A new file starts at each power-up and after the bus has been quiet for 10
// minutes, so each outing usually ends up in one file. The oldest files are
// deleted to stay under the size limit and keep space free on the card.
class Recorder {
public:
    Recorder(std::string dir, double maxGb);
    ~Recorder();

    void write(const CanFrame& frame);  // any thread
    // Call about once a second: flushes to the card and closes idle files.
    void tick();

    std::string statusJson();  // {enabled, file, bytes, active, free}

private:
    void openFile(int64_t epochUs);  // caller holds mu_
    void closeFile();
    void prune();

    std::mutex mu_;
    std::string dir_;
    uint64_t maxBytes_;
    FILE* file_ = nullptr;
    std::string name_;
    uint64_t bytes_ = 0;
    int64_t startUs_ = 0, lastWriteUs_ = 0, lastSyncUs_ = 0, lastOpenUs_ = 0, lastPruneUs_ = 0;
    bool dirty_ = false;
};

int64_t wallClockUs();
