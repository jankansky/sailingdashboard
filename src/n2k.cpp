#include "n2k.hpp"

#include <algorithm>
#include <bit>
#include <cstdio>
#include <cstring>
#include <set>
#include <string>

namespace n2k {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Little-endian field readers. NMEA 2000 marks "not available" with the
// top values of each type (0xFFFF, 0x7FFF, ...), which we map to NaN.
uint16_t u16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | p[1] << 8); }
int16_t i16(const uint8_t* p) { return static_cast<int16_t>(u16(p)); }
uint32_t u32(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) | static_cast<uint32_t>(p[1]) << 8 |
           static_cast<uint32_t>(p[2]) << 16 | static_cast<uint32_t>(p[3]) << 24;
}
int32_t i32(const uint8_t* p) { return static_cast<int32_t>(u32(p)); }
int64_t i64(const uint8_t* p) {
    return static_cast<int64_t>(static_cast<uint64_t>(u32(p)) | static_cast<uint64_t>(u32(p + 4)) << 32);
}

double u16f(const uint8_t* p, double scale) {
    uint16_t v = u16(p);
    return v >= 0xFFFD ? NAN : v * scale;
}
double i16f(const uint8_t* p, double scale) {
    int16_t v = i16(p);
    return v >= 0x7FFE ? NAN : v * scale;
}
double u32f(const uint8_t* p, double scale) {
    uint32_t v = u32(p);
    return v >= 0xFFFFFFFDu ? NAN : v * scale;
}
double i32f(const uint8_t* p, double scale) {
    int32_t v = i32(p);
    return v >= 0x7FFFFFFE ? NAN : v * scale;
}
double i64f(const uint8_t* p, double scale) {
    int64_t v = i64(p);
    return v >= 0x7FFFFFFFFFFFFFFELL ? NAN : static_cast<double>(v) * scale;
}

double wrapPi(double a) {
    if (!std::isfinite(a)) return a;
    a = std::fmod(a, 2 * kPi);
    if (a > kPi) a -= 2 * kPi;
    if (a < -kPi) a += 2 * kPi;
    return a;
}

// Fixed-length string field: trim trailing padding (0xFF, NUL, spaces, '@').
std::string fixedString(const uint8_t* p, size_t n) {
    std::string s(reinterpret_cast<const char*>(p), n);
    auto end = s.find_last_not_of(std::string("\xFF\0 @", 4));
    s.resize(end == std::string::npos ? 0 : end + 1);
    auto nul = s.find('\0');
    if (nul != std::string::npos) s.resize(nul);
    return s;
}

// Date (days since 1970) + time of day (0.0001 s) -> ms since epoch.
bool dateTimeMs(const uint8_t* date, const uint8_t* time, int64_t& out) {
    uint16_t days = u16(date);
    uint32_t t = u32(time);
    if (days >= 0xFFFD || t >= 0xFFFFFFFDu) return false;
    out = static_cast<int64_t>(days) * 86400000LL + t / 10;
    return true;
}

}  // namespace

Id parseId(uint32_t canId) {
    Id id{};
    id.priority = (canId >> 26) & 0x7;
    id.source = canId & 0xFF;
    uint32_t dp = (canId >> 24) & 0x3;
    uint32_t pf = (canId >> 16) & 0xFF;
    uint32_t ps = (canId >> 8) & 0xFF;
    if (pf < 240) {  // PDU1: addressed, PS is the destination
        id.pgn = dp << 16 | pf << 8;
        id.destination = static_cast<uint8_t>(ps);
    } else {  // PDU2: broadcast, PS is part of the PGN
        id.pgn = dp << 16 | pf << 8 | ps;
        id.destination = 255;
    }
    return id;
}

uint32_t makeId(uint32_t pgn, uint8_t source, uint8_t priority, uint8_t destination) {
    uint32_t pf = (pgn >> 8) & 0xFF;
    uint32_t id = static_cast<uint32_t>(priority & 0x7) << 26 | (pgn & 0x3FF00) << 8 | source;
    if (pf < 240) id |= static_cast<uint32_t>(destination) << 8;
    else id |= (pgn & 0xFF) << 8;
    return id;
}

bool isFastPacket(uint32_t pgn) {
    static const std::set<uint32_t> fast = {
        126208, 126464, 126720, 126983, 126984, 126985, 126986, 126987, 126988, 126996, 126998,
        127233, 127237, 127489, 127496, 127497, 127498, 127503, 127504, 127506, 127507, 127509,
        127510, 127511, 127512, 127513, 127514, 128275, 128520, 129029, 129038, 129039, 129040,
        129041, 129044, 129045, 129284, 129285, 129301, 129302, 129538, 129540, 129541, 129542,
        129545, 129547, 129549, 129551, 129556, 129792, 129793, 129794, 129795, 129796, 129797,
        129798, 129799, 129800, 129801, 129802, 129803, 129804, 129805, 129806, 129807, 129808,
        129809, 129810, 130052, 130053, 130054, 130060, 130061, 130064, 130065, 130066, 130067,
        130068, 130069, 130070, 130071, 130072, 130073, 130074, 130320, 130321, 130322, 130323,
        130324, 130567, 130569, 130570, 130571, 130572, 130573, 130574, 130577, 130578, 130580,
        130581, 130583, 130584, 130586, 130816, 130817, 130818, 130819, 130820, 130821, 130822,
        130823, 130824, 130825, 130827, 130828, 130831, 130832, 130834, 130835, 130836, 130837,
        130838, 130839, 130840, 130842, 130843, 130845, 130846, 130847, 130850, 130851, 130856,
        130860, 130880, 130881, 130944,
    };
    return fast.count(pgn) > 0;
}

std::vector<CanFrame> encode(uint32_t pgn, uint8_t source, uint8_t priority,
                             const std::vector<uint8_t>& payload, uint8_t sequence) {
    std::vector<CanFrame> frames;
    uint32_t id = makeId(pgn, source, priority);
    auto addFrame = [&](const uint8_t* bytes, size_t n, int prefix, int lenByte) {
        CanFrame f;
        f.id = id;
        f.len = 8;
        std::memset(f.data, 0xFF, 8);
        size_t pos = 0;
        if (prefix >= 0) f.data[pos++] = static_cast<uint8_t>(prefix);
        if (lenByte >= 0) f.data[pos++] = static_cast<uint8_t>(lenByte);
        std::memcpy(f.data + pos, bytes, n);
        frames.push_back(f);
    };
    if (!isFastPacket(pgn)) {
        addFrame(payload.data(), std::min<size_t>(8, payload.size()), -1, -1);
        return frames;
    }
    size_t total = std::min<size_t>(223, payload.size());
    uint8_t seq = static_cast<uint8_t>((sequence & 0x7) << 5);
    size_t first = std::min<size_t>(6, total);
    addFrame(payload.data(), first, seq, static_cast<int>(total));
    for (size_t off = first, idx = 1; off < total; off += 7, ++idx)
        addFrame(payload.data() + off, std::min<size_t>(7, total - off), seq | static_cast<int>(idx), -1);
    return frames;
}

void Decoder::handle(const CanFrame& frame) {
    if (frame.id == kImuFrameId) {  // the Pi's own IMU, as recorded in a log
        if (frame.len < 4) return;
        std::lock_guard lock(st_.mu);
        st_.imuPitch = i16f(frame.data, 1e-4);
        st_.imuRoll = i16f(frame.data + 2, 1e-4);
        st_.imuT.touch(st_.now());
        return;
    }
    Id id = parseId(frame.id);
    std::lock_guard lock(st_.mu);
    auto now = st_.now();

    st_.frames++;
    DeviceInfo& dev = st_.devices[id.source];
    dev.lastSeen = now;
    dev.frames++;
    dev.pgns.insert(id.pgn);

    if (!isFastPacket(id.pgn)) {
        dispatch(id.pgn, id.source, frame.data, frame.len);
        return;
    }
    if (frame.len < 1) return;

    uint32_t key = id.pgn << 8 | id.source;
    uint8_t seq = frame.data[0] >> 5;
    uint8_t idx = frame.data[0] & 0x1F;
    if (idx == 0) {
        if (frame.len < 2 || frame.data[1] > 223) return;
        FastPacket& fp = fastPackets_[key];
        fp = FastPacket{};
        fp.sequence = seq;
        fp.total = frame.data[1];
        fp.started = now;
        std::memcpy(fp.buf, frame.data + 2, std::min<size_t>(6, frame.len - 2));
        fp.received = 1;
    } else {
        auto it = fastPackets_.find(key);
        if (it == fastPackets_.end() || it->second.sequence != seq) return;
        FastPacket& fp = it->second;
        size_t off = 6 + (idx - 1) * 7;
        if (off >= fp.total) return;
        std::memcpy(fp.buf + off, frame.data + 1, std::min<size_t>({7, frame.len - 1u, fp.total - off}));
        fp.received |= 1u << idx;
    }

    FastPacket& fp = fastPackets_[key];
    int needed = fp.total <= 6 ? 1 : 1 + (fp.total - 6 + 6) / 7;
    if (std::popcount(fp.received) == needed) {
        dispatch(id.pgn, id.source, fp.buf, fp.total);
        fastPackets_.erase(key);
    } else if (now - fp.started > std::chrono::seconds(2)) {
        fastPackets_.erase(key);
    }
}

void Decoder::dispatch(uint32_t pgn, uint8_t src, const uint8_t* d, size_t len) {
    BoatState& s = st_;
    if (verbose_) {
        std::printf("pgn %6u src %3u len %3zu:", pgn, src, len);
        for (size_t i = 0; i < len && i < 16; ++i) std::printf(" %02X", d[i]);
        std::printf("%s\n", len > 16 ? " ..." : "");
    }

    switch (pgn) {
    case 60928: {  // ISO Address Claim
        if (len < 8) return;
        uint64_t name = static_cast<uint64_t>(u32(d)) | static_cast<uint64_t>(u32(d + 4)) << 32;
        DeviceInfo& dev = s.devices[src];
        dev.manufacturer = static_cast<int>((name >> 21) & 0x7FF);
        dev.deviceFunction = d[5];
        dev.deviceClass = (d[6] >> 1) & 0x7F;
        break;
    }
    case 126992: {  // System Time
        if (len < 8) return;
        int64_t ms;
        if (dateTimeMs(d + 2, d + 4, ms) && !s.gnssT.fresh(s.now(), 3)) {  // prefer GNSS time
            s.utcMs = ms;
            s.utcT.touch(s.now());
        }
        break;
    }
    case 126996: {  // Product Information
        if (len < 134) return;
        DeviceInfo& dev = s.devices[src];
        dev.model = fixedString(d + 4, 32);
        dev.software = fixedString(d + 36, 32);
        dev.serial = fixedString(d + 100, 32);
        break;
    }
    case 127250: {  // Vessel Heading
        if (len < 8) return;
        s.heading = u16f(d + 1, 1e-4);
        s.deviation = i16f(d + 3, 1e-4);
        s.hdgVariation = i16f(d + 5, 1e-4);
        int ref = d[7] & 0x3;
        if (ref > 1 || !std::isfinite(s.heading)) return;
        s.headingIsMag = ref == 1;
        s.headingT.touch(s.now());
        break;
    }
    case 127251: {  // Rate of Turn
        if (len < 5) return;
        s.rot = i32f(d + 1, 3.125e-8);
        s.rotT.touch(s.now());
        break;
    }
    case 127257: {  // Attitude
        if (len < 7) return;
        s.yaw = i16f(d + 1, 1e-4);
        s.pitch = i16f(d + 3, 1e-4);
        s.roll = i16f(d + 5, 1e-4);
        s.attT.touch(s.now());
        break;
    }
    case 127258: {  // Magnetic Variation
        if (len < 6) return;
        double v = i16f(d + 4, 1e-4);
        if (!std::isfinite(v)) return;
        s.variation = v;
        s.variationT.touch(s.now());
        break;
    }
    case 128259: {  // Speed, Water Referenced
        if (len < 3) return;
        s.stw = u16f(d + 1, 0.01);
        s.stwT.touch(s.now());
        break;
    }
    case 128267: {  // Water Depth
        if (len < 7) return;
        double depth = u32f(d + 1, 0.01);
        double offset = i16f(d + 5, 0.001);
        s.depth = depth + (std::isfinite(offset) ? offset : 0);
        s.depthT.touch(s.now());
        break;
    }
    case 129025: {  // Position, Rapid Update
        if (len < 8) return;
        double lat = i32f(d, 1e-7), lon = i32f(d + 4, 1e-7);
        if (!std::isfinite(lat) || !std::isfinite(lon)) return;
        s.lat = lat;
        s.lon = lon;
        s.posT.touch(s.now());
        s.posRapidT.touch(s.now());
        break;
    }
    case 129026: {  // COG & SOG, Rapid Update
        if (len < 6) return;
        s.cogIsMag = (d[1] & 0x3) == 1;
        s.cog = u16f(d + 2, 1e-4);
        s.sog = u16f(d + 4, 0.01);
        s.cogT.touch(s.now());
        break;
    }
    case 129029: {  // GNSS Position Data
        if (len < 38) return;
        int64_t ms;
        if (dateTimeMs(d + 1, d + 3, ms)) {
            s.utcMs = ms;
            s.utcT.touch(s.now());
        }
        double lat = i64f(d + 7, 1e-16), lon = i64f(d + 15, 1e-16);
        int method = d[31] >> 4;
        if (std::isfinite(lat) && std::isfinite(lon) && method >= 1 && method <= 5 &&
            !s.posRapidT.fresh(s.now(), 1.5)) {  // rapid updates win
            s.lat = lat;
            s.lon = lon;
            s.posT.touch(s.now());
        }
        s.fixMethod = method;
        s.sats = d[33] == 0xFF ? -1 : d[33];
        s.hdop = i16f(d + 34, 0.01);
        s.gnssT.touch(s.now());
        break;
    }
    case 129038:  // AIS Class A Position Report
    case 129039:  // AIS Class B Position Report
    case 129040: {  // AIS Class B Extended Position Report
        if (len < 23) return;
        uint32_t mmsi = u32(d + 1);
        double lat = i32f(d + 9, 1e-7), lon = i32f(d + 5, 1e-7);
        if (!mmsi || !std::isfinite(lat) || !std::isfinite(lon)) return;
        AisTarget& t = s.ais[mmsi];
        t.aisClass = pgn == 129038 ? 'A' : 'B';
        t.lat = lat;
        t.lon = lon;
        t.cog = u16f(d + 14, 1e-4);
        t.sog = u16f(d + 16, 0.01);
        if (pgn == 129038) {
            t.heading = u16f(d + 21, 1e-4);
            if (len >= 26) {
                t.rot = i16f(d + 23, 3.125e-5);
                t.navStatus = d[25] & 0x0F;
            }
        } else if (pgn == 129039) {
            t.heading = u16f(d + 21, 1e-4);
        } else if (len >= 52) {  // 129040 carries the static data too
            t.shipType = d[20] == 0xFF ? -1 : d[20];
            t.heading = u16f(d + 21, 1e-4);
            t.length = u16f(d + 24, 0.1);
            t.beam = u16f(d + 26, 0.1);
            t.name = fixedString(d + 32, 20);
            t.staticT.touch(s.now());
        }
        t.posT.touch(s.now());
        break;
    }
    case 129794: {  // AIS Class A Static and Voyage Related Data
        if (len < 41) return;
        AisTarget& t = s.ais[u32(d + 1)];
        t.aisClass = 'A';
        t.callsign = fixedString(d + 9, 7);
        t.name = fixedString(d + 16, 20);
        t.shipType = d[36] == 0xFF ? -1 : d[36];
        t.length = u16f(d + 37, 0.1);
        t.beam = u16f(d + 39, 0.1);
        t.staticT.touch(s.now());
        break;
    }
    case 129809: {  // AIS Class B static data, part A: name
        if (len < 25) return;
        AisTarget& t = s.ais[u32(d + 1)];
        t.aisClass = 'B';
        t.name = fixedString(d + 5, 20);
        t.staticT.touch(s.now());
        break;
    }
    case 129810: {  // AIS Class B static data, part B: type, call sign, size
        if (len < 24) return;
        AisTarget& t = s.ais[u32(d + 1)];
        t.aisClass = 'B';
        t.shipType = d[5] == 0xFF ? -1 : d[5];
        t.callsign = fixedString(d + 13, 7);
        t.length = u16f(d + 20, 0.1);
        t.beam = u16f(d + 22, 0.1);
        t.staticT.touch(s.now());
        break;
    }
    case 130306: {  // Wind Data
        if (len < 6) return;
        double speed = u16f(d + 1, 0.01);
        double angle = u16f(d + 3, 1e-4);
        switch (d[5] & 0x7) {
        case 2:  // apparent
            s.aws = speed;
            s.awa = wrapPi(angle);
            s.windT.touch(s.now());
            break;
        case 0:  // true, ground referenced to north
            s.devTws = speed;
            s.devTwd = angle;
            s.devTwa = NAN;
            s.devTrueT.touch(s.now());
            break;
        case 3:  // true, boat referenced
        case 4:  // true, water referenced
            s.devTws = speed;
            s.devTwa = wrapPi(angle);
            s.devTwd = NAN;
            s.devTrueT.touch(s.now());
            break;
        default:
            break;
        }
        break;
    }
    default:
        break;
    }
}

}  // namespace n2k
