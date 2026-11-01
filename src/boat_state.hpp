#pragma once
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>

using Clock = std::chrono::steady_clock;

// Time of the last update of a group of values.
struct Stamp {
    Clock::time_point t{};
    bool valid() const { return t.time_since_epoch().count() != 0; }
    void touch(Clock::time_point now) { t = now; }
    double age(Clock::time_point now) const {
        return std::chrono::duration<double>(now - t).count();
    }
    // Updated within maxAge seconds.
    bool fresh(Clock::time_point now, double maxAge = 5.0) const {
        return valid() && age(now) < maxAge;
    }
};

// Everything learned about one device (source address) on the bus.
struct DeviceInfo {
    Clock::time_point lastSeen{};
    std::set<uint32_t> pgns;
    uint64_t frames = 0;
    int manufacturer = -1;  // from ISO address claim (PGN 60928)
    int deviceClass = -1;
    int deviceFunction = -1;
    std::string model, software, serial;  // from product info (PGN 126996)
};

// A vessel heard over AIS (PGNs 129038/129039/129040 positions, 129794/129809/129810 statics).
struct AisTarget {
    char aisClass = 'A';
    double lat = NAN, lon = NAN;  // deg
    double cog = NAN, sog = NAN, heading = NAN;  // rad, m/s, rad
    double rot = NAN;  // rad/s
    int navStatus = -1, shipType = -1;
    std::string name, callsign;
    double length = NAN, beam = NAN;  // m
    Stamp posT, staticT;
};

struct Settings {
    double variationDeg = NAN;  // fallback magnetic variation if the bus provides none (east +)
    double headingOffsetDeg = 0;  // added to the heading sensor (installation alignment)
    double rollOffsetDeg = 0;  // added to heel after sign correction
    bool invertRoll = false;  // flip if the sensor reports heel to the wrong side
};

// One 1 Hz sample of the history shown in the wind chart.
struct HistorySample {
    int64_t t;  // epoch ms
    double twd, tws, aws, sog, heel;  // deg, m/s, m/s, m/s, deg
};

// Live boat data. Raw values are in SI units and radians as they come off the bus.
// All fields are guarded by `mu`.
class BoatState {
public:
    std::mutex mu;
    Settings settings;

    // Clock for data ages. Live it is the real clock; when replaying a recording
    // it is the recording's time, moved along by the player.
    Clock::time_point now() const {
        int64_t us = playbackUs_.load();
        return us < 0 ? Clock::now() : Clock::time_point(std::chrono::microseconds(us));
    }
    int64_t epochMs() const;  // the same clock as UTC milliseconds
    void setPlaybackTime(int64_t epochUs) { playbackUs_ = epochUs; }

    // Apparent wind (PGN 130306, reference 2)
    double aws = NAN, awa = NAN;  // m/s, rad (-pi..pi, + = starboard)
    Stamp windT;
    // True wind if a device (e.g. GNX Wind with speed input) publishes it
    double devTws = NAN, devTwa = NAN, devTwd = NAN;
    Stamp devTrueT;

    // Heading (PGN 127250)
    double heading = NAN, deviation = NAN, hdgVariation = NAN;
    bool headingIsMag = true;
    Stamp headingT;
    double rot = NAN;  // rad/s (PGN 127251)
    Stamp rotT;
    double yaw = NAN, pitch = NAN, roll = NAN;  // rad (PGN 127257)
    Stamp attT;
    double imuRoll = NAN, imuPitch = NAN;  // rad, from a BNO085 on the Pi (used if the bus has no attitude)
    Stamp imuT;
    double variation = NAN;  // rad (PGN 127258)
    Stamp variationT;

    // GNSS
    double lat = NAN, lon = NAN;  // deg
    Stamp posT;
    Stamp posRapidT;  // last PGN 129025
    double cog = NAN, sog = NAN;  // rad, m/s
    bool cogIsMag = false;
    Stamp cogT;
    int sats = -1, fixMethod = -1;
    double hdop = NAN;
    Stamp gnssT;
    int64_t utcMs = 0;  // UTC (ms since epoch) at utcT
    Stamp utcT;

    // Optional instruments
    double stw = NAN;  // m/s (PGN 128259)
    Stamp stwT;
    double depth = NAN;  // m below transducer + offset (PGN 128267)
    Stamp depthT;

    // Bus
    std::map<uint8_t, DeviceInfo> devices;
    std::map<uint32_t, AisTarget> ais;  // by MMSI
    uint64_t frames = 0;
    std::string sourceName;
    bool sourceConnected = false;

    std::string stateJson();
    std::string devicesJson();
    std::string aisJson();  // drops targets not heard for 20 minutes
    std::string historyJson();
    // Records one history sample and returns it; call at 1 Hz.
    HistorySample sampleHistory();
    // Replaces the history (used when jumping to a point in a recording).
    void setHistory(std::deque<HistorySample> samples);

private:
    struct Derived {
        double hdgTrue = NAN, hdgMag = NAN, var = NAN;
        bool varKnown = false;
        const char* hdgSrc = nullptr;
        double tws = NAN, twa = NAN, twd = NAN;
        const char* twSrc = nullptr;
        double vmg = NAN;
        double heel = NAN, pitch = NAN;
        const char* attSrc = nullptr;  // "n2k" or "imu"
        double attAge = NAN;
    };
    Derived derive(Clock::time_point now);  // caller holds mu

    std::deque<HistorySample> history_;
    std::atomic<int64_t> playbackUs_{-1};  // -1: live

    uint64_t rateFrames_ = 0;
    Clock::time_point rateT_{};
    double frameRate_ = 0;
};
