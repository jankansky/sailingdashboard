#pragma once
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

// Runs tools/fetch_weather.py every 15 minutes (and when a tablet asks), so the
// Weather view has satellite, radar and forecasts for the area around the boat.
// The script writes into `dir`, which the HTTP server serves as /weather/.
// Without internet the script just fails, and the last fetch stays on show.
class WeatherFetcher {
public:
    // script: path to fetch_weather.py. home: "LAT,LON" to use before the boat's
    // position is first known, or empty.
    WeatherFetcher(std::string dir, std::string script, std::string home, int port);
    ~WeatherFetcher();

    void start();
    void requestNow();  // fetch as soon as possible
    bool running() const { return running_; }
    const std::string& dir() const { return dir_; }

private:
    void loop();
    void runOnce();

    std::string dir_, script_, home_;
    int port_;
    std::atomic<bool> running_{false};
    std::atomic<int> pid_{0};
    bool stop_ = false, now_ = false;
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread thread_;
};
