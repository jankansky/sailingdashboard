#include "weather.hpp"

#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <vector>

extern char** environ;

namespace {

constexpr auto kEvery = std::chrono::minutes(15);
constexpr auto kFirst = std::chrono::seconds(20);  // let the GPS report a position first
constexpr int kTimeoutS = 10 * 60;

}  // namespace

WeatherFetcher::WeatherFetcher(std::string dir, std::string script, std::string home, int port)
    : dir_(std::move(dir)), script_(std::move(script)), home_(std::move(home)), port_(port) {}

WeatherFetcher::~WeatherFetcher() {
    {
        std::lock_guard lock(mu_);
        stop_ = true;
    }
    cv_.notify_all();
    if (int pid = pid_) kill(pid, SIGTERM);
    if (thread_.joinable()) thread_.join();
}

void WeatherFetcher::start() {
    std::printf("weather: fetching for %s every 15 minutes with %s\n", dir_.c_str(), script_.c_str());
    thread_ = std::thread(&WeatherFetcher::loop, this);
}

void WeatherFetcher::requestNow() {
    if (running_) return;
    {
        std::lock_guard lock(mu_);
        now_ = true;
    }
    cv_.notify_all();
}

void WeatherFetcher::loop() {
    auto wait = std::chrono::duration_cast<std::chrono::steady_clock::duration>(kFirst);
    for (;;) {
        {
            std::unique_lock lock(mu_);
            cv_.wait_for(lock, wait, [this] { return stop_ || now_; });
            if (stop_) return;
            now_ = false;
        }
        runOnce();
        wait = kEvery;
    }
}

void WeatherFetcher::runOnce() {
    std::string state = "http://127.0.0.1:" + std::to_string(port_) + "/api/state";
    std::vector<std::string> args = {"python3", script_, "--out", dir_, "--state", state};
    if (!home_.empty()) {
        args.push_back("--home");
        args.push_back(home_);
    }
    std::vector<char*> argv;
    for (auto& a : args) argv.push_back(a.data());
    argv.push_back(nullptr);

    pid_t pid;
    if (int err = posix_spawnp(&pid, "python3", nullptr, nullptr, argv.data(), environ)) {
        std::fprintf(stderr, "weather: cannot run python3: %s\n", std::strerror(err));
        return;
    }
    running_ = true;
    pid_ = pid;
    int status = 0;
    for (int waited = 0;; ++waited) {
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid || (r < 0 && errno != EINTR)) break;
        if (waited == kTimeoutS) {
            std::fprintf(stderr, "weather: fetch took over %d s; stopping it\n", kTimeoutS);
            kill(pid, SIGKILL);
        }
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
    pid_ = 0;
    running_ = false;
}
