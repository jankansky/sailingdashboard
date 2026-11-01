#pragma once
#include <cstdint>
#include <map>
#include <vector>

#include "boat_state.hpp"
#include "can_frame.hpp"

namespace n2k {

struct Id {
    uint32_t pgn;
    uint8_t priority, source, destination;
};

Id parseId(uint32_t canId);
uint32_t makeId(uint32_t pgn, uint8_t source, uint8_t priority, uint8_t destination = 255);
bool isFastPacket(uint32_t pgn);

// Splits a message into CAN frames (fast-packet when the PGN requires it).
std::vector<CanFrame> encode(uint32_t pgn, uint8_t source, uint8_t priority,
                             const std::vector<uint8_t>& payload, uint8_t sequence = 0);

// Reassembles fast packets and decodes the PGNs we care about into BoatState.
class Decoder {
public:
    explicit Decoder(BoatState& state, bool verbose = false) : st_(state), verbose_(verbose) {}
    void handle(const CanFrame& frame);

private:
    struct FastPacket {
        uint8_t sequence = 0;
        uint8_t total = 0;
        uint32_t received = 0;  // bitmask of frame indexes
        uint8_t buf[223] = {};
        Clock::time_point started{};
    };

    // Caller holds st_.mu.
    void dispatch(uint32_t pgn, uint8_t src, const uint8_t* d, size_t len);

    BoatState& st_;
    bool verbose_;
    std::map<uint32_t, FastPacket> fastPackets_;  // key: pgn << 8 | source
};

}  // namespace n2k
