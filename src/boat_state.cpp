#include "boat_state.hpp"
#include "json.hpp"

#include <algorithm>
#include <cstdio>
#include <string_view>
#include <vector>

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = 180.0 / kPi;
constexpr size_t kHistoryLen = 1800;  // 30 minutes at 1 Hz

double wrap2Pi(double a) {
    a = std::fmod(a, 2 * kPi);
    return a < 0 ? a + 2 * kPi : a;
}

double wrapPi(double a) {
    a = wrap2Pi(a);
    return a > kPi ? a - 2 * kPi : a;
}

// Age in seconds of a stamp, or null if it was never set.
void age(JsonWriter& j, std::string_view k, const Stamp& s, Clock::time_point now) {
    j.num(k, s.valid() ? s.age(now) : NAN, 1);
}

}  // namespace

int64_t BoatState::epochMs() const {
    using namespace std::chrono;
    int64_t us = playbackUs_.load();
    if (us >= 0) return us / 1000;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

BoatState::Derived BoatState::derive(Clock::time_point now) {
    Derived d;

    // Magnetic variation: heading sensor field, then PGN 127258, then the configured fallback.
    if (headingT.fresh(now) && std::isfinite(hdgVariation)) {
        d.var = hdgVariation;
        d.varKnown = true;
    } else if (variationT.fresh(now, 3600) && std::isfinite(variation)) {
        d.var = variation;
        d.varKnown = true;
    } else if (std::isfinite(settings.variationDeg)) {
        d.var = settings.variationDeg / kDeg;
        d.varKnown = true;
    } else {
        d.var = 0;
    }

    bool gpsFresh = cogT.fresh(now) && std::isfinite(cog) && std::isfinite(sog);
    double cogTrue = gpsFresh ? wrap2Pi(cog + (cogIsMag ? d.var : 0)) : NAN;

    if (headingT.fresh(now) && std::isfinite(heading)) {
        double h = heading + settings.headingOffsetDeg / kDeg;
        if (headingIsMag) {
            d.hdgMag = wrap2Pi(h + (std::isfinite(deviation) ? deviation : 0));
            d.hdgTrue = wrap2Pi(d.hdgMag + d.var);
        } else {
            d.hdgTrue = wrap2Pi(h);
            d.hdgMag = wrap2Pi(h - d.var);
        }
        d.hdgSrc = "sensor";
    } else if (gpsFresh && sog > 0.5) {
        d.hdgTrue = cogTrue;
        d.hdgMag = wrap2Pi(cogTrue - d.var);
        d.hdgSrc = "cog";
    }

    // True wind from apparent wind and boat motion. Using SOG/COG gives the
    // ground wind (what weather forecasts describe); fall back to STW along heading.
    bool windFresh = windT.fresh(now) && std::isfinite(aws) && std::isfinite(awa);
    if (windFresh && std::isfinite(d.hdgTrue)) {
        double bn = NAN, be = NAN;
        if (gpsFresh) {
            bn = sog * std::cos(cogTrue);
            be = sog * std::sin(cogTrue);
            d.twSrc = "ground";
        } else if (stwT.fresh(now) && std::isfinite(stw)) {
            bn = stw * std::cos(d.hdgTrue);
            be = stw * std::sin(d.hdgTrue);
            d.twSrc = "water";
        }
        if (d.twSrc) {
            double awFrom = d.hdgTrue + awa;
            // Velocity of the air relative to the boat (direction it blows toward).
            double an = -aws * std::cos(awFrom), ae = -aws * std::sin(awFrom);
            double tn = an + bn, te = ae + be;
            d.tws = std::hypot(tn, te);
            d.twd = wrap2Pi(std::atan2(-te, -tn));
            d.twa = wrapPi(d.twd - d.hdgTrue);
        }
    }
    if (!d.twSrc && devTrueT.fresh(now)) {
        d.tws = devTws;
        if (std::isfinite(devTwd)) {
            d.twd = devTwd;
            if (std::isfinite(d.hdgTrue)) d.twa = wrapPi(devTwd - d.hdgTrue);
        } else if (std::isfinite(devTwa)) {
            d.twa = devTwa;
            if (std::isfinite(d.hdgTrue)) d.twd = wrap2Pi(d.hdgTrue + devTwa);
        }
        d.twSrc = "device";
    }
    if (gpsFresh && std::isfinite(d.twd)) d.vmg = sog * std::cos(cogTrue - d.twd);

    // Heel: prefer an attitude sensor on the bus, fall back to the Pi's own IMU.
    double r = NAN, p = NAN;
    if (attT.fresh(now, 2) && std::isfinite(roll)) {
        r = roll;
        p = pitch;
        d.attSrc = "n2k";
        d.attAge = attT.age(now);
    } else if (imuT.fresh(now, 2) && std::isfinite(imuRoll)) {
        r = settings.imuInvertRoll ? -imuRoll : imuRoll;
        p = settings.imuInvertPitch ? -imuPitch : imuPitch;
        d.attSrc = "imu";
        d.attAge = imuT.age(now);
    } else if (attT.valid() || imuT.valid()) {
        d.attAge = std::min(attT.valid() ? attT.age(now) : INFINITY, imuT.valid() ? imuT.age(now) : INFINITY);
    }
    if (d.attSrc) {
        d.heel = (settings.invertRoll ? -r : r) * kDeg + settings.rollOffsetDeg;
        d.pitch = p * kDeg;
    }
    return d;
}

std::string BoatState::stateJson() {
    std::lock_guard lock(mu);
    auto now = this->now();
    Derived d = derive(now);

    if (!rateT_.time_since_epoch().count()) rateT_ = now;
    double dt = std::chrono::duration<double>(now - rateT_).count();
    if (dt >= 1.0) {
        frameRate_ = static_cast<double>(frames - rateFrames_) / dt;
        rateFrames_ = frames;
        rateT_ = now;
    }

    JsonWriter j;
    j.beginObj();
    j.integer("t", epochMs());

    j.beginObj("bus");
    j.str("source", sourceName);
    j.boolean("connected", sourceConnected);
    j.integer("frames", static_cast<int64_t>(frames));
    j.num("fps", frameRate_, 0);
    j.integer("devices", static_cast<int64_t>(devices.size()));
    j.endObj();

    j.beginObj("wind");
    age(j, "age", windT, now);
    j.num("aws", aws);
    j.num("awa", awa * kDeg, 1);
    j.num("tws", d.tws);
    j.num("twa", d.twa * kDeg, 1);
    j.num("twd", d.twd * kDeg, 1);
    j.strOrNull("twSrc", d.twSrc);
    j.endObj();

    j.beginObj("nav");
    age(j, "hdgAge", headingT, now);
    j.num("hdg", d.hdgTrue * kDeg, 1);
    j.num("hdgMag", d.hdgMag * kDeg, 1);
    j.strOrNull("hdgSrc", d.hdgSrc);
    j.num("var", d.var * kDeg, 1);
    j.boolean("varKnown", d.varKnown);
    j.num("rot", rotT.fresh(now) ? rot * kDeg * 60 : NAN, 1);  // deg/min
    age(j, "gpsAge", cogT.valid() ? cogT : posT, now);
    j.num("cog", cogT.fresh(now) ? wrap2Pi(cog + (cogIsMag ? d.var : 0)) * kDeg : NAN, 1);
    j.num("sog", cogT.fresh(now) ? sog : NAN);
    j.num("vmg", d.vmg);
    j.num("lat", lat, 6);
    j.num("lon", lon, 6);
    j.integer("sats", gnssT.fresh(now, 10) ? sats : -1);
    j.num("hdop", gnssT.fresh(now, 10) ? hdop : NAN, 1);
    j.integer("fix", gnssT.fresh(now, 10) ? fixMethod : -1);
    j.num("utc", utcT.valid() ? static_cast<double>(utcMs) + utcT.age(now) * 1000 : NAN, 0);
    j.endObj();

    j.beginObj("att");
    j.num("age", d.attAge, 1);
    j.strOrNull("src", d.attSrc);
    j.num("heel", d.heel, 1);
    j.num("pitch", d.pitch, 1);
    j.endObj();

    j.beginObj("water");
    age(j, "stwAge", stwT, now);
    j.num("stw", stw);
    age(j, "depthAge", depthT, now);
    j.num("depth", depth, 1);
    j.endObj();

    j.endObj();
    return j.out;
}

std::string BoatState::aisJson() {
    std::lock_guard lock(mu);
    auto now = this->now();
    JsonWriter j;
    j.beginArr();
    for (auto it = ais.begin(); it != ais.end();) {
        const AisTarget& t = it->second;
        if (!t.posT.fresh(now, 20 * 60)) {
            // Keep a name that arrived before any position; drop anything long silent.
            if (t.posT.valid() || !t.staticT.fresh(now, 20 * 60)) it = ais.erase(it);
            else ++it;
            continue;
        }
        j.beginObj();
        j.integer("mmsi", it->first);
        j.str("cls", std::string(1, t.aisClass));
        j.num("age", t.posT.age(now), 1);
        j.num("lat", t.lat, 6);
        j.num("lon", t.lon, 6);
        j.num("cog", t.cog * kDeg, 1);
        j.num("sog", t.sog);
        j.num("hdg", t.heading * kDeg, 1);
        j.num("rot", t.rot * kDeg * 60, 1);  // deg/min
        j.integer("nav", t.navStatus);
        j.integer("type", t.shipType);
        j.str("name", t.name);
        j.str("call", t.callsign);
        j.num("len", t.length, 1);
        j.num("beam", t.beam, 1);
        j.endObj();
        ++it;
    }
    j.endArr();
    return j.out;
}

std::string BoatState::devicesJson() {
    std::lock_guard lock(mu);
    auto now = this->now();
    JsonWriter j;
    j.beginArr();
    for (const auto& [src, dev] : devices) {
        j.beginObj();
        j.integer("src", src);
        j.num("age", std::chrono::duration<double>(now - dev.lastSeen).count(), 1);
        j.integer("frames", static_cast<int64_t>(dev.frames));
        j.integer("mfr", dev.manufacturer);
        j.integer("cls", dev.deviceClass);
        j.integer("fn", dev.deviceFunction);
        j.str("model", dev.model);
        j.str("sw", dev.software);
        j.str("serial", dev.serial);
        j.beginArr("pgns");
        for (uint32_t p : dev.pgns) j.integer(p);
        j.endArr();
        j.endObj();
    }
    j.endArr();
    return j.out;
}

HistorySample BoatState::sampleHistory() {
    std::lock_guard lock(mu);
    auto t = now();
    Derived d = derive(t);
    HistorySample s{epochMs(), d.twd * kDeg, d.tws, windT.fresh(t) ? aws : NAN,
                    cogT.fresh(t) ? sog : NAN, d.heel};
    history_.push_back(s);
    while (history_.size() > kHistoryLen) history_.pop_front();
    return s;
}

void BoatState::setHistory(std::deque<HistorySample> samples) {
    std::lock_guard lock(mu);
    history_ = std::move(samples);
    while (history_.size() > kHistoryLen) history_.pop_front();
}

std::string BoatState::historyJson() {
    std::lock_guard lock(mu);
    JsonWriter j;
    j.beginArr();
    for (const auto& s : history_) {
        j.beginArr();
        j.integer(s.t);
        j.num(s.twd, 1);
        j.num(s.tws);
        j.num(s.aws);
        j.num(s.sog);
        j.num(s.heel, 1);
        j.endArr();
    }
    j.endArr();
    return j.out;
}
