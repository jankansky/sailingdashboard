#pragma once
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "boat_state.hpp"
#include "playback.hpp"
#include "recorder.hpp"

// Tiny HTTP server for the tablet UI:
//   /             static files from the web root
//   /events       Server-Sent Events stream of the boat state
//   /api/state    current state (JSON)
//   /api/devices  devices seen on the bus (JSON)
//   /api/history  last 30 minutes of 1 Hz samples (JSON)
//   /api/ais      AIS targets heard in the last 20 minutes (JSON)
//   /tiles/...    offline map tiles from the tiles directory (see tools/fetch_tiles.py)
//
// Recordings:
//   /api/recorder                        recorder status
//   /api/recordings                      recorder status and the list of recordings
//   /recordings/NAME                     download one (candump format)
//   POST /api/playback/open?file=NAME    start replaying it: returns a session id
//   POST /api/playback/control?session=ID&play=0|1&speed=X&seek=EPOCH_MS
//   POST /api/playback/close?session=ID
//   /api/playback/status?session=ID
// With ?session=ID, /events and the /api/ data calls show the recording instead
// of the live boat, so one tablet can replay while others stay live.
class HttpServer {
public:
    HttpServer(BoatState& state, std::string webRoot, std::string tilesRoot, std::string recordingsDir,
               Recorder* recorder, int port, double rateHz)
        : state_(state), webRoot_(std::move(webRoot)), tilesRoot_(std::move(tilesRoot)),
          recordingsDir_(std::move(recordingsDir)), recorder_(recorder), port_(port), rateHz_(rateHz) {}

    // Serves until `stop` becomes true. Returns false if the port can't be opened.
    bool run(const std::atomic<bool>& stop);

private:
    struct Session {
        std::unique_ptr<Player> player;
        std::atomic<int64_t> lastUsedMs{0};
        std::atomic<int> streams{0};
    };

    void handleConnection(int fd, const std::atomic<bool>& stop);
    void handlePlayback(int fd, const std::string& path, const std::string& target);
    void streamEvents(int fd, const std::string& sessionId, const std::atomic<bool>& stop);
    void serveFile(int fd, const std::string& path, const std::string& ifModifiedSince);
    void serveRecording(int fd, const std::string& name);
    std::shared_ptr<Session> session(const std::string& id);  // null if unknown
    void expireSessions();

    BoatState& state_;
    std::string webRoot_;
    std::string tilesRoot_;
    std::string recordingsDir_;  // empty: no recordings
    Recorder* recorder_;  // null: not recording
    int port_;
    double rateHz_;
    std::atomic<int> streams_{0};
    std::mutex sessionsMu_;
    std::map<std::string, std::shared_ptr<Session>> sessions_;
};
