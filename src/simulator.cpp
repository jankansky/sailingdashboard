// Simulated Potter 19 sailing (Boston Harbor by default). It produces real NMEA 2000
// frames (including fast packets), so the decoder runs exactly as on the boat.

#include <algorithm>
#include <cmath>
#include <deque>
#include <iterator>
#include <random>
#include <thread>
#include <vector>

#include "frame_source.hpp"
#include "n2k.hpp"

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kRad = kPi / 180.0;

constexpr uint8_t kWindSrc = 10;  // GNX Wind
constexpr uint8_t kHeadingSrc = 20;  // SteadyCast heading sensor
constexpr uint8_t kGpsSrc = 30;  // GPS antenna
constexpr uint8_t kAisSrc = 40;  // AIS receiver

double wrap180(double deg) {
    deg = std::fmod(deg + 180.0, 360.0);
    return (deg < 0 ? deg + 360.0 : deg) - 180.0;
}

double wrap2Pi(double a) {
    a = std::fmod(a, 2 * kPi);
    return a < 0 ? a + 2 * kPi : a;
}

class Payload {
public:
    std::vector<uint8_t> b;
    Payload& u8(unsigned v) {
        b.push_back(static_cast<uint8_t>(v));
        return *this;
    }
    Payload& u16(unsigned v) { return u8(v & 0xFF).u8(v >> 8 & 0xFF); }
    Payload& u32(uint32_t v) { return u16(v & 0xFFFF).u16(v >> 16); }
    Payload& u64(uint64_t v) { return u32(static_cast<uint32_t>(v)).u32(static_cast<uint32_t>(v >> 32)); }
    Payload& i16(double v) { return u16(static_cast<uint16_t>(static_cast<int16_t>(std::lround(v)))); }
    Payload& i32(double v) { return u32(static_cast<uint32_t>(static_cast<int32_t>(std::lround(v)))); }
    Payload& i64(double v) { return u64(static_cast<uint64_t>(std::llround(v))); }
    Payload& angle(double rad) { return u16(static_cast<unsigned>(std::lround(wrap2Pi(rad) * 1e4)) % 62832); }
    Payload& str(const std::string& s, size_t n) {
        for (size_t i = 0; i < n; ++i) u8(i < s.size() ? static_cast<unsigned char>(s[i]) : 0xFF);
        return *this;
    }
};

class SimulatorSource : public FrameSource {
public:
    SimulatorSource(double lat, double lon) : lat_(lat), lon_(lon), startLat_(lat), startLon_(lon) {}

    bool open() override {
        next_ = Clock::now();
        return true;
    }

    int read(CanFrame& f, int timeoutMs) override {
        auto deadline = Clock::now() + std::chrono::milliseconds(timeoutMs);
        while (queue_.empty()) {
            auto now = Clock::now();
            if (now >= next_) {
                step(0.1);
                next_ += std::chrono::milliseconds(100);
                continue;
            }
            if (next_ > deadline) {
                std::this_thread::sleep_until(deadline);
                return 0;
            }
            std::this_thread::sleep_until(next_);
        }
        f = queue_.front();
        queue_.pop_front();
        return 1;
    }

    std::string describe() const override { return "simulator"; }

private:
    void send(uint32_t pgn, uint8_t src, uint8_t prio, const Payload& p) {
        for (const CanFrame& f : n2k::encode(pgn, src, prio, p.b, seq_++)) queue_.push_back(f);
    }

    void announce(uint8_t src, unsigned cls, unsigned fn, const std::string& model, uint32_t unique) {
        uint64_t name = unique & 0x1FFFFF;
        name |= static_cast<uint64_t>(229) << 21;  // Garmin
        name |= static_cast<uint64_t>(fn) << 40;
        name |= static_cast<uint64_t>(cls << 1) << 48;
        name |= static_cast<uint64_t>(4) << 60;  // marine industry group
        name |= 1ULL << 63;
        send(60928, src, 6, Payload().u64(name));
        send(126996, src, 6,
             Payload().u16(2100).u16(1000 + src).str(model, 32).str("5.10", 32).str("1", 32)
                 .str(std::to_string(unique), 32).u8(1).u8(1));
    }

    void step(double dt) {
        t_ += dt;
        ++tick_;

        // Weather: oscillating southwesterly with gusts.
        double twd = 220 + 12 * std::sin(2 * kPi * t_ / 300) + 5 * std::sin(2 * kPi * t_ / 53);
        gust_ += (-gust_ * 0.05 + noise_(rng_) * 0.25) * dt * 10;
        double tws = std::max(1.0, 5.5 + 1.2 * std::sin(2 * kPi * t_ / 140) + gust_);

        // Course program: beat, beat, reach, run; the helmsman steers by TWA.
        static constexpr double legs[] = {42, -42, 42, -42, 95, -150, 150, -95};
        legTime_ += dt;
        if (legTime_ > 50) {
            legTime_ = 0;
            leg_ = (leg_ + 1) % std::size(legs);
        }
        double targetHdg = twd - legs[leg_];
        double diff = wrap180(targetHdg - hdg_);
        hdg_ = std::fmod(hdg_ + std::clamp(diff, -8 * dt, 8 * dt) + 360, 360);
        double steer = hdg_ + noise_(rng_) * 0.6;

        // Boat speed: crude Potter 19 polar, capped near hull speed (~5.4 kn).
        double twa = std::abs(wrap180(twd - hdg_));
        double target = std::min(2.75, tws * 0.5 * std::clamp((twa - 28) / 25, 0.0, 1.0));
        bs_ += (target - bs_) * dt / 5;

        double h = steer * kRad;
        double vn = bs_ * std::cos(h) + 0.25 * std::cos(100 * kRad);  // plus 0.5 kn current
        double ve = bs_ * std::sin(h) + 0.25 * std::sin(100 * kRad);
        double sog = std::hypot(vn, ve);
        double cog = std::atan2(ve, vn);

        // Apparent wind = true air motion minus boat motion over ground.
        double an = -tws * std::cos(twd * kRad) - vn;
        double ae = -tws * std::sin(twd * kRad) - ve;
        double aws = std::hypot(an, ae);
        double awa = std::atan2(-ae, -an) - h;

        // Heel to leeward; N2K roll is positive with the starboard side down.
        double awaDeg = wrap180(awa / kRad);
        double heel = std::min(30.0, 24 * std::pow(aws / 7.0, 2) * std::sin(std::min(std::abs(awaDeg), 90.0) * kRad));
        double roll = (awaDeg > 0 ? -heel : heel) + noise_(rng_) * 1.5 + 2 * std::sin(2 * kPi * t_ / 3.7);
        double pitch = 2.5 * std::sin(2 * kPi * t_ / 2.9);
        double rot = wrap180(hdg_ - lastHdg_) / dt;
        lastHdg_ = hdg_;

        lat_ += vn * dt / 111320.0;
        lon_ += ve * dt / (111320.0 * std::cos(lat_ * kRad));

        constexpr double variation = -14.3;  // Boston: 14.3 deg W
        double hdgMag = steer - variation;

        send(130306, kWindSrc, 2, Payload().u8(tick_).u16(std::lround(aws * 100)).angle(awa).u8(0xFA).u16(0xFFFF));
        send(127250, kHeadingSrc, 2,
             Payload().u8(tick_).angle(hdgMag * kRad).u16(0x7FFF).u16(0x7FFF).u8(0xFD));
        send(127251, kHeadingSrc, 2, Payload().u8(tick_).i32(rot * kRad / 3.125e-8).u8(0xFF).u16(0xFFFF));
        send(127257, kHeadingSrc, 3,
             Payload().u8(tick_).u16(0x7FFF).i16(pitch * kRad * 1e4).i16(roll * kRad * 1e4).u8(0xFF));
        send(129025, kGpsSrc, 2, Payload().i32(lat_ * 1e7).i32(lon_ * 1e7));
        send(129026, kGpsSrc, 2,
             Payload().u8(tick_).u8(0xFC).angle(cog).u16(std::lround(sog * 100)).u16(0xFFFF));

        if (tick_ % 10 == 0) {
            using namespace std::chrono;
            auto ms = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
            unsigned days = static_cast<unsigned>(ms / 86400000);
            uint32_t tod = static_cast<uint32_t>(ms % 86400000) * 10;
            send(129029, kGpsSrc, 3,
                 Payload().u8(tick_).u16(days).u32(tod).i64(lat_ * 1e16).i64(lon_ * 1e16).i64(4e6)
                     .u8(0x10 | 0x0).u8(0xFC).u8(11).i16(80).i16(140).i32(-2800).u8(0));
            send(127258, kGpsSrc, 6, Payload().u8(tick_).u8(0xF8 | 6).u16(days).i16(variation * kRad * 1e4).u16(0xFFFF));
            send(126992, kGpsSrc, 3, Payload().u8(tick_).u8(0xF0).u16(days).u32(tod));
        }
        if (tick_ % 100 == 1) {
            announce(kWindSrc, 85, 130, "GNX Wind (sim)", 81234);
            announce(kHeadingSrc, 60, 140, "SteadyCast Heading (sim)", 92345);
            announce(kGpsSrc, 60, 145, "GPS (sim)", 73456);
            announce(kAisSrc, 60, 195, "AIS (sim)", 64567);
        }
        stepAis(dt);
    }

    // ---- AIS traffic: fictional vessels moving around the start position ----

    struct Vessel {
        uint32_t mmsi;
        char cls;
        const char* name;
        unsigned type;  // AIS ship type
        double length, beam;  // m
        double bearing, range;  // start position from the sim start (deg, m)
        double course, knots;
        bool aimAtUs;  // re-aims at our boat each time it resets: a close-quarters test
        double n = 0, e = 0;  // metres north/east of the sim start
        bool placed = false;
    };

    std::vector<Vessel> vessels_ = {
        {366999101, 'A', "FERRY (SIM)", 60, 42, 11, 300, 2200, 125, 12, false},
        {366999102, 'A', "TUG (SIM)", 52, 24, 9, 80, 3200, 265, 7, false},
        {338999103, 'B', "SLOOP (SIM)", 36, 9, 3, 200, 1200, 30, 5, false},
        {338999104, 'A', "LOBSTER (SIM)", 30, 12, 4, 45, 2600, 0, 8, true},
    };

    void stepAis(double dt) {
        constexpr double kMetresPerDegLat = 111320.0;
        const double myN = (lat_ - startLat_) * kMetresPerDegLat;
        const double myE = (lon_ - startLon_) * kMetresPerDegLat * std::cos(startLat_ * kRad);
        for (Vessel& v : vessels_) {
            if (!v.placed || std::hypot(v.n, v.e) > 9000) {  // (re)start the vessel's run
                v.n = myN + v.range * std::cos(v.bearing * kRad);
                v.e = myE + v.range * std::sin(v.bearing * kRad);
                if (v.aimAtUs) v.course = std::fmod(v.bearing + 180, 360);
                v.placed = true;
            }
            double sog = v.knots / 1.943844;
            v.n += sog * std::cos(v.course * kRad) * dt;
            v.e += sog * std::sin(v.course * kRad) * dt;

            double lat = startLat_ + v.n / kMetresPerDegLat;
            double lon = startLon_ + v.e / (kMetresPerDegLat * std::cos(startLat_ * kRad));
            unsigned stamp = static_cast<unsigned>(t_) % 60;
            unsigned period = v.cls == 'A' ? 20 : 50;  // ticks of 0.1 s
            if (tick_ % period == v.mmsi % period) {
                if (v.cls == 'A') {
                    send(129038, kAisSrc, 4,
                         Payload().u8(1).u32(v.mmsi).i32(lon * 1e7).i32(lat * 1e7).u8(1 | stamp << 2)
                             .angle(v.course * kRad).u16(std::lround(sog * 100)).u8(0).u16(0)
                             .angle(v.course * kRad).i16(0).u8(0xF0).u8(0xFF).u8(0xFF));
                } else {
                    send(129039, kAisSrc, 4,
                         Payload().u8(18).u32(v.mmsi).i32(lon * 1e7).i32(lat * 1e7).u8(1 | stamp << 2)
                             .angle(v.course * kRad).u16(std::lround(sog * 100)).u8(0).u16(0)
                             .angle(v.course * kRad).u8(0xFF).u8(0xFF).u8(0xFF));
                }
            }
            if (tick_ % 300 == v.mmsi % 300) {  // static data every 30 s
                if (v.cls == 'A') {
                    send(129794, kAisSrc, 6,
                         Payload().u8(5).u32(v.mmsi).u32(0).str("SIM" + std::to_string(v.mmsi % 1000), 7)
                             .str(v.name, 20).u8(v.type).u16(std::lround(v.length * 10)).u16(std::lround(v.beam * 10))
                             .u16(std::lround(v.beam * 5)).u16(std::lround(v.length * 3)).u16(0xFFFF).u32(0xFFFFFFFF)
                             .u16(300).str("PORTLAND", 20).u8(0xFF).u8(0xFF));
                } else {
                    send(129809, kAisSrc, 6, Payload().u8(24).u32(v.mmsi).str(v.name, 20).u8(0xFF).u8(0xFF));
                    send(129810, kAisSrc, 6,
                         Payload().u8(24).u32(v.mmsi).u8(v.type).str("SIMAIS", 7).str("SIM" + std::to_string(v.mmsi % 1000), 7)
                             .u16(std::lround(v.length * 10)).u16(std::lround(v.beam * 10)).u16(std::lround(v.beam * 5))
                             .u16(std::lround(v.length * 3)).u32(0).u8(0xFF).u8(0xFF));
                }
            }
        }
    }

    std::deque<CanFrame> queue_;
    Clock::time_point next_{};
    std::mt19937 rng_{42};
    std::normal_distribution<double> noise_{0.0, 1.0};
    double t_ = 0, gust_ = 0, legTime_ = 0;
    size_t leg_ = 0;
    double hdg_ = 175, bs_ = 2.0, lastHdg_ = 175;
    double lat_, lon_;
    double startLat_, startLon_;
    unsigned tick_ = 0;
    uint8_t seq_ = 0;
};

}  // namespace

std::unique_ptr<FrameSource> makeSimulatorSource(double lat, double lon) {
    return std::make_unique<SimulatorSource>(lat, lon);
}
