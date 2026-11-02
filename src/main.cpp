// Sailing dashboard: listens to the NMEA 2000 bus and serves a
// live boat visualization to tablets on the local network.

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <thread>

#include "boat_state.hpp"
#include "clock_sync.hpp"
#include "frame_source.hpp"
#include "http_server.hpp"
#include "imu_rvc.hpp"
#include "n2k.hpp"
#include "recorder.hpp"

namespace {

std::atomic<bool> g_stop{false};

void usage(const char* argv0) {
    std::printf(
        "usage: %s [source] [options]\n"
        "\nsource (default --can can0):\n"
        "  --can IFACE          SocketCAN interface (adapter with candleLight/gs_usb firmware)\n"
        "  --slcan DEVICE       serial adapter with slcan firmware, e.g. /dev/ttyACM0\n"
        "  --replay FILE        replay a candump log (add --loop to repeat)\n"
        "  --sim                built-in simulator, no hardware needed\n"
        "  --sim-at WHERE       simulator start: boston, casco, or LAT,LON (default boston)\n"
        "\noptions:\n"
        "  --port N             HTTP port (default 8080)\n"
        "  --web DIR            web UI directory (default ./web)\n"
        "  --tiles DIR          offline map tiles from tools/fetch_tiles.py (default ./tiles)\n"
        "  --rate HZ            update rate to tablets (default 5)\n"
        "  --variation DEG      magnetic variation if not on the bus, east positive (Boston: -14.3)\n"
        "  --heading-offset DEG correction added to the heading sensor\n"
        "  --roll-offset DEG    correction added to heel\n"
        "  --invert-roll        flip heel direction if the sensor is mounted reversed\n"
        "  --imu DEVICE         BNO085 in UART-RVC mode for heel/pitch, e.g. /dev/serial0\n"
        "                       (used when no attitude sensor is on the bus)\n"
        "  --imu-invert-roll    flip the IMU's heel only (sensor on the bus unaffected)\n"
        "  --imu-invert-pitch   flip the IMU's pitch only\n"
        "  --record DIR         log the bus to DIR (one candump file per outing) and offer\n"
        "                       the recordings for replay on the tablet\n"
        "  --record-max-gb N    delete the oldest recordings beyond N GB (default 8)\n"
        "  --recordings DIR     offer recordings in DIR for replay without recording\n"
        "  --set-clock          set the Pi's clock from GPS time (the service does this)\n"
        "  --no-record          turn off a --record given earlier (e.g. in the service file)\n"
        "  --verbose            print every decoded message\n",
        argv0);
}

void readBus(FrameSource& source, BoatState& state, Recorder* recorder, bool verbose) {
    n2k::Decoder decoder(state, verbose);
    CanFrame frame;
    while (!g_stop) {
        if (!source.open()) {
            for (int i = 0; i < 20 && !g_stop; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        std::printf("reading NMEA 2000 from %s\n", source.describe().c_str());
        {
            std::lock_guard lock(state.mu);
            state.sourceConnected = true;
        }
        int r;
        while (!g_stop && (r = source.read(frame, 500)) >= 0)
            if (r == 1) {
                if (recorder) recorder->write(frame);
                decoder.handle(frame);
            }
        source.close();
        {
            std::lock_guard lock(state.mu);
            state.sourceConnected = false;
        }
        if (!g_stop) std::fprintf(stderr, "lost %s, retrying\n", source.describe().c_str());
    }
}

}  // namespace

int main(int argc, char** argv) {
    std::unique_ptr<FrameSource> source;
    std::string webRoot = "web", tilesRoot = "tiles";
    int port = 8080;
    double rate = 5;
    bool verbose = false, loop = false;
    std::string replayPath, imuDevice, recordDir, recordingsDir;
    double recordMaxGb = 8;
    bool noRecord = false;
    bool setClock = false;
    bool sim = false;
    double simLat = 42.3355, simLon = -70.9920;  // Boston outer harbor
    BoatState state;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "%s needs a value\n", a.c_str());
                std::exit(2);
            }
            return argv[++i];
        };
        if (a == "--can") source = makeSocketCanSource(next());
        else if (a == "--slcan") source = makeSlcanSource(next());
        else if (a == "--replay") replayPath = next();
        else if (a == "--loop") loop = true;
        else if (a == "--sim") sim = true;
        else if (a == "--sim-at") {
            std::string where = next();
            sim = true;
            if (where == "boston") simLat = 42.3355, simLon = -70.9920;
            else if (where == "casco") simLat = 43.6420, simLon = -70.2050;  // off Portland Head toward the islands
            else if (std::sscanf(where.c_str(), "%lf,%lf", &simLat, &simLon) != 2) {
                std::fprintf(stderr, "--sim-at needs boston, casco or LAT,LON\n");
                return 2;
            }
        }
        else if (a == "--port") port = std::atoi(next().c_str());
        else if (a == "--web") webRoot = next();
        else if (a == "--tiles") tilesRoot = next();
        else if (a == "--rate") rate = std::clamp(std::atof(next().c_str()), 0.5, 20.0);
        else if (a == "--variation") state.settings.variationDeg = std::atof(next().c_str());
        else if (a == "--heading-offset") state.settings.headingOffsetDeg = std::atof(next().c_str());
        else if (a == "--roll-offset") state.settings.rollOffsetDeg = std::atof(next().c_str());
        else if (a == "--invert-roll") state.settings.invertRoll = true;
        else if (a == "--imu-invert-roll") state.settings.imuInvertRoll = true;
        else if (a == "--imu-invert-pitch") state.settings.imuInvertPitch = true;
        else if (a == "--imu") imuDevice = next();
        else if (a == "--record") recordDir = next();
        else if (a == "--record-max-gb") recordMaxGb = std::max(0.1, std::atof(next().c_str()));
        else if (a == "--recordings") recordingsDir = next();
        else if (a == "--no-record") noRecord = true;
        else if (a == "--set-clock") setClock = true;
        else if (a == "--verbose") verbose = true;
        else {
            usage(argv[0]);
            return a == "--help" || a == "-h" ? 0 : 2;
        }
    }
    if (sim) source = makeSimulatorSource(simLat, simLon);
    if (!replayPath.empty()) source = makeReplaySource(replayPath, loop);
    if (!source) source = makeSocketCanSource("can0");
    while (webRoot.size() > 1 && webRoot.back() == '/') webRoot.pop_back();
    while (tilesRoot.size() > 1 && tilesRoot.back() == '/') tilesRoot.pop_back();
    state.sourceName = source->describe();
    std::unique_ptr<Recorder> recorder;
    if (!recordDir.empty()) {
        while (recordDir.size() > 1 && recordDir.back() == '/') recordDir.pop_back();
        if (noRecord) std::printf("recording is off (--no-record)\n");
        else if (replayPath.empty()) recorder = std::make_unique<Recorder>(recordDir, recordMaxGb);
        else std::printf("not recording while replaying a file\n");
        if (recordingsDir.empty()) recordingsDir = recordDir;
    }
    while (recordingsDir.size() > 1 && recordingsDir.back() == '/') recordingsDir.pop_back();

    std::setvbuf(stdout, nullptr, _IOLBF, 0);  // timely logs under systemd
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGINT, [](int) { g_stop = true; });
    std::signal(SIGTERM, [](int) { g_stop = true; });

    std::thread reader(readBus, std::ref(*source), std::ref(state), recorder.get(), verbose);
    std::thread imu;
    std::function<void(const CanFrame&)> recordImu;
    if (recorder) recordImu = [r = recorder.get()](const CanFrame& f) { r->write(f); };
    if (!imuDevice.empty())
        imu = std::thread(runImuRvc, imuDevice, std::ref(state), std::cref(g_stop), std::cref(recordImu));
    if (setClock && (sim || !replayPath.empty())) {
        std::printf("not setting the clock from simulated or replayed GPS\n");
        setClock = false;
    }
    std::thread sampler([&state, &recorder, setClock] {
        ClockSync clockSync;
        ClockWatch clockWatch;
        auto next = std::chrono::steady_clock::now();
        while (!g_stop) {
            next += std::chrono::seconds(1);
            std::this_thread::sleep_until(next);
            if (setClock) clockSync.tick(state);
            if (int64_t step = clockWatch.tick()) {
                std::printf("the clock moved %+.1f s\n", step / 1e6);
                state.shiftHistory(step / 1000);
                if (recorder) recorder->clockStepped(step);
            }
            state.sampleHistory();
            if (recorder) recorder->tick();
        }
    });

    HttpServer server(state, webRoot, tilesRoot, recordingsDir, recorder.get(), port, rate);
    bool ok = server.run(g_stop);
    g_stop = true;
    reader.join();
    if (imu.joinable()) imu.join();
    sampler.join();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));  // let event streams finish
    return ok ? 0 : 1;
}
