#pragma once
#include <atomic>
#include <string>

#include "boat_state.hpp"

// Tiny HTTP server for the tablet UI:
//   /             static files from the web root
//   /events       Server-Sent Events stream of the boat state
//   /api/state    current state (JSON)
//   /api/devices  devices seen on the bus (JSON)
//   /api/history  last 30 minutes of 1 Hz samples (JSON)
//   /api/ais      AIS targets heard in the last 20 minutes (JSON)
//   /tiles/...    offline map tiles from the tiles directory (see tools/fetch_tiles.py)
class HttpServer {
public:
    HttpServer(BoatState& state, std::string webRoot, std::string tilesRoot, int port, double rateHz)
        : state_(state), webRoot_(std::move(webRoot)), tilesRoot_(std::move(tilesRoot)), port_(port),
          rateHz_(rateHz) {}

    // Serves until `stop` becomes true. Returns false if the port can't be opened.
    bool run(const std::atomic<bool>& stop);

private:
    void handleConnection(int fd, const std::atomic<bool>& stop);
    void streamEvents(int fd, const std::atomic<bool>& stop);
    void serveFile(int fd, const std::string& path, const std::string& ifModifiedSince);

    BoatState& state_;
    std::string webRoot_;
    std::string tilesRoot_;
    int port_;
    double rateHz_;
    std::atomic<int> streams_{0};
};
