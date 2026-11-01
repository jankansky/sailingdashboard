// Potter 19 sailing dashboard: listens to the NMEA 2000 bus and serves a
// live boat visualization to tablets on the local network.

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#include "boat_state.hpp"
#include "frame_source.hpp"
#include "http_server.hpp"
#include "imu_rvc.hpp"
#include "n2k.hpp"

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
        "  --verbose            print every decoded message\n",
        argv0);
}

void readBus(FrameSource& source, BoatState& state, bool verbose) {
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
            if (r == 1) decoder.handle(frame);
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
    std::string replayPath, imuDevice;
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
        else if (a == "--imu") imuDevice = next();
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

    std::setvbuf(stdout, nullptr, _IOLBF, 0);  // timely logs under systemd
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGINT, [](int) { g_stop = true; });
    std::signal(SIGTERM, [](int) { g_stop = true; });

    std::thread reader(readBus, std::ref(*source), std::ref(state), verbose);
    std::thread imu;
    if (!imuDevice.empty()) imu = std::thread(runImuRvc, imuDevice, std::ref(state), std::cref(g_stop));
    std::thread sampler([&state] {
        auto next = std::chrono::steady_clock::now();
        while (!g_stop) {
            next += std::chrono::seconds(1);
            std::this_thread::sleep_until(next);
            state.sampleHistory();
        }
    });

    HttpServer server(state, webRoot, tilesRoot, port, rate);
    bool ok = server.run(g_stop);
    g_stop = true;
    reader.join();
    if (imu.joinable()) imu.join();
    sampler.join();
    std::this_thread::sleep_for(std::chrono::milliseconds(300));  // let event streams finish
    return ok ? 0 : 1;
}
