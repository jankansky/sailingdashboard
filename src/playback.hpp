#pragma once
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "boat_state.hpp"
#include "n2k.hpp"

struct RecordingInfo {
    std::string name;
    uint64_t bytes = 0;
    int64_t startMs = 0, endMs = 0;  // from the first and last lines
};

// Recordings in a directory, newest first.
std::vector<RecordingInfo> listRecordings(const std::string& dir);
std::string recordingsJson(const std::vector<RecordingInfo>& files);
// True for names listRecordings could return (no paths, ends in .log).
bool validRecordingName(const std::string& name);

// Replays one recording into its own BoatState, at any speed, from any point.
// The state's clock follows the recording, so data ages, the wind history and
// AIS targets look exactly as they did at that moment.
class Player {
public:
    // Reads through the whole file once to index it (a few seconds for a long
    // day). Returns null and sets `error` if the file can't be used.
    static std::unique_ptr<Player> open(const std::string& dir, const std::string& name,
                                        const Settings& settings, std::string& error);
    ~Player();

    // The state to show. Replaced on every seek, so fetch it for each use.
    std::shared_ptr<BoatState> state();

    void setPlaying(bool on);
    void setSpeed(double speed);
    void seek(int64_t epochMs);

    std::string statusJson();  // {name, start, end, t, playing, speed}
    std::string overviewJson();  // [[t, sog, tws], ...] across the whole recording, for the time slider

private:
    struct Line {
        int64_t us;
        CanFrame frame;
    };

    Player() = default;
    // Caller holds mu_ for these.
    void seekFile(int64_t epochUs);  // positions file_ a little before epochUs
    bool next(Line& line);  // next timestamped frame from file_
    void advance(int64_t epochUs, bool sample);  // feeds frames up to epochUs
    void jump(int64_t epochUs);
    void run();

    std::string name_;
    Settings settings_;
    FILE* file_ = nullptr;
    int64_t startUs_ = 0, endUs_ = 0;
    std::vector<long> index_;  // file offset of the first line in each second from startUs_
    std::vector<HistorySample> samples_;  // 1 Hz history across the whole recording
    // Clock steps inside the file (the Pi's clock being set mid-recording) are
    // taken out so time runs smoothly: from file offset `at`, add `shiftUs`.
    struct Jump {
        long at;
        int64_t shiftUs;
    };
    std::vector<Jump> jumps_;

    std::mutex mu_;  // guards everything below, and file_ after open()
    std::shared_ptr<BoatState> state_;
    std::unique_ptr<n2k::Decoder> decoder_;
    long offset_ = 0;  // of the next line in file_
    int64_t shiftUs_ = 0;
    size_t nextJump_ = 0;
    bool havePending_ = false;
    Line pending_{};
    int64_t nowUs_ = 0;  // playback position
    int64_t nextSampleUs_ = 0;
    bool playing_ = false;
    double speed_ = 1;

    std::atomic<bool> stop_{false};
    std::thread thread_;
};
