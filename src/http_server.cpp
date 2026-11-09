#include "http_server.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <random>
#include <cerrno>
#include <ctime>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <thread>

namespace {

bool sendAll(int fd, const char* data, size_t len) {
    while (len > 0) {
        ssize_t n = send(fd, data, len, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        data += n;
        len -= static_cast<size_t>(n);
    }
    return true;
}

bool sendAll(int fd, const std::string& s) { return sendAll(fd, s.data(), s.size()); }

void respond(int fd, int code, const char* status, const std::string& type, const std::string& body,
             const char* cache = "no-cache", const std::string& extraHeaders = "") {
    std::ostringstream h;
    h << "HTTP/1.1 " << code << ' ' << status << "\r\n"
      << "Content-Type: " << type << "\r\n"
      << "Content-Length: " << body.size() << "\r\n"
      << "Cache-Control: " << cache << "\r\n"
      << extraHeaders
      << "Access-Control-Allow-Origin: *\r\n"
      << "Connection: close\r\n\r\n";
    if (sendAll(fd, h.str())) sendAll(fd, body);
}

std::string httpDate(time_t t) {
    char buf[64];
    tm g{};
    gmtime_r(&t, &g);
    std::strftime(buf, sizeof buf, "%a, %d %b %Y %H:%M:%S GMT", &g);
    return buf;
}

// Value of a request header (case-insensitive name), or "".
std::string header(const std::string& req, const std::string& name) {
    std::istringstream in(req);
    std::string line;
    while (std::getline(in, line) && line != "\r") {
        auto colon = line.find(':');
        if (colon == std::string::npos || colon != name.size()) continue;
        bool match = std::equal(name.begin(), name.end(), line.begin(),
                                [](char a, char b) { return std::tolower(a) == std::tolower(b); });
        if (!match) continue;
        std::string value = line.substr(colon + 1);
        value.erase(0, value.find_first_not_of(' '));
        while (!value.empty() && (value.back() == '\r' || value.back() == ' ')) value.pop_back();
        return value;
    }
    return "";
}

// Value of a query parameter in a request target, URL-decoded; "" if absent.
std::string param(const std::string& target, const std::string& name) {
    auto q = target.find('?');
    if (q == std::string::npos) return "";
    std::string query = target.substr(q + 1);
    size_t pos = 0;
    while (pos <= query.size()) {
        size_t amp = query.find('&', pos);
        if (amp == std::string::npos) amp = query.size();
        std::string pair = query.substr(pos, amp - pos);
        auto eq = pair.find('=');
        if (pair.substr(0, eq) == name) {
            std::string raw = eq == std::string::npos ? "" : pair.substr(eq + 1), out;
            for (size_t i = 0; i < raw.size(); ++i) {
                if (raw[i] == '+') out += ' ';
                else if (raw[i] == '%' && i + 2 < raw.size() && std::isxdigit(static_cast<unsigned char>(raw[i + 1])) &&
                         std::isxdigit(static_cast<unsigned char>(raw[i + 2]))) {
                    out += static_cast<char>(std::stoi(raw.substr(i + 1, 2), nullptr, 16));
                    i += 2;
                } else out += raw[i];
            }
            return out;
        }
        pos = amp + 1;
    }
    return "";
}

// For session timeouts: unaffected by the system clock being set.
int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string contentType(const std::string& path) {
    auto dot = path.rfind('.');
    std::string ext = dot == std::string::npos ? "" : path.substr(dot + 1);
    if (ext == "html") return "text/html; charset=utf-8";
    if (ext == "js") return "text/javascript; charset=utf-8";
    if (ext == "css") return "text/css; charset=utf-8";
    if (ext == "json" || ext == "webmanifest") return "application/json";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "png") return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "webp") return "image/webp";
    if (ext == "ico") return "image/x-icon";
    return "application/octet-stream";
}

}  // namespace

bool HttpServer::run(const std::atomic<bool>& stop) {
    int listener = socket(AF_INET6, SOCK_STREAM, 0);
    bool v6 = listener >= 0;
    if (!v6) listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) {
        std::perror("socket");
        return false;
    }
    int one = 1, zero = 0;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    int rc;
    if (v6) {
        setsockopt(listener, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof zero);  // accept IPv4 too
        sockaddr_in6 addr{};
        addr.sin6_family = AF_INET6;
        addr.sin6_addr = in6addr_any;
        addr.sin6_port = htons(static_cast<uint16_t>(port_));
        rc = bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof addr);
    } else {
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
        addr.sin_port = htons(static_cast<uint16_t>(port_));
        rc = bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof addr);
    }
    if (rc < 0 || listen(listener, 16) < 0) {
        std::fprintf(stderr, "cannot listen on port %d: %s\n", port_, std::strerror(errno));
        close(listener);
        return false;
    }
    std::printf("web UI on http://0.0.0.0:%d/ (web root %s)\n", port_, webRoot_.c_str());

    while (!stop) {
        expireSessions();
        pollfd p{listener, POLLIN, 0};
        if (poll(&p, 1, 500) <= 0) continue;
        int fd = accept(listener, nullptr, nullptr);
        if (fd < 0) continue;
        timeval tv{5, 0};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        std::thread([this, fd, &stop] {
            handleConnection(fd, stop);
            close(fd);
        }).detach();
    }
    close(listener);
    return true;
}

void HttpServer::handleConnection(int fd, const std::atomic<bool>& stop) {
    std::string req;
    char buf[2048];
    while (req.find("\r\n\r\n") == std::string::npos && req.size() < 16384) {
        ssize_t n = recv(fd, buf, sizeof buf, 0);
        if (n <= 0) return;
        req.append(buf, static_cast<size_t>(n));
    }

    std::istringstream line(req.substr(0, req.find("\r\n")));
    std::string method, target;
    line >> method >> target;
    std::string path = target.substr(0, target.find('?'));
    bool control = (path.rfind("/api/playback/", 0) == 0 && path != "/api/playback/status") ||
                   path == "/api/weather/refresh";
    if (control ? method != "POST" : method != "GET" && method != "HEAD") {
        respond(fd, 405, "Method Not Allowed", "text/plain", control ? "POST only\n" : "GET only\n");
        return;
    }
    if (path.rfind("/api/playback/", 0) == 0) return handlePlayback(fd, path, target);
    if (path == "/events") return streamEvents(fd, param(target, "session"), stop);
    if (path == "/api/recordings") {
        std::string files = recordingsDir_.empty() ? "[]" : recordingsJson(listRecordings(recordingsDir_));
        std::string rec = recorder_ ? recorder_->statusJson() : "{\"enabled\":false}";
        respond(fd, 200, "OK", "application/json", "{\"recorder\":" + rec + ",\"files\":" + files + "}");
        return;
    }
    if (path == "/api/recorder") {
        respond(fd, 200, "OK", "application/json", recorder_ ? recorder_->statusJson() : "{\"enabled\":false}");
        return;
    }
    if (path.rfind("/recordings/", 0) == 0) return serveRecording(fd, path.substr(12));
    if (path == "/api/weather/refresh" && weather_) weather_->requestNow();
    if (path == "/api/weather" || path == "/api/weather/refresh") {
        std::string body = "{\"enabled\":" + std::string(weather_ ? "true" : "false") +
                           ",\"running\":" + (weather_ && weather_->running() ? "true" : "false") + "}";
        respond(fd, 200, "OK", "application/json", body);
        return;
    }

    // Data calls answer for a replay session if one is named, else for the live boat.
    BoatState* st = &state_;
    std::shared_ptr<BoatState> replay;
    std::string sid = param(target, "session");
    if (!sid.empty() && path.rfind("/api/", 0) == 0) {
        auto sess = session(sid);
        if (!sess) {
            respond(fd, 404, "Not Found", "application/json", "{\"error\":\"replay session ended\"}");
            return;
        }
        replay = sess->player->state();
        st = replay.get();
    }
    if (path == "/api/state") respond(fd, 200, "OK", "application/json", st->stateJson());
    else if (path == "/api/devices") respond(fd, 200, "OK", "application/json", st->devicesJson());
    else if (path == "/api/ais") respond(fd, 200, "OK", "application/json", st->aisJson());
    else if (path == "/api/history") respond(fd, 200, "OK", "application/json", st->historyJson());
    else serveFile(fd, path == "/" ? "/index.html" : path, header(req, "If-Modified-Since"));
}

void HttpServer::handlePlayback(int fd, const std::string& path, const std::string& target) {
    auto json = [&](const std::string& body) { respond(fd, 200, "OK", "application/json", body); };
    auto fail = [&](int code, const char* status, const std::string& msg) {
        respond(fd, code, status, "application/json", "{\"error\":\"" + msg + "\"}");
    };
    if (path == "/api/playback/open") {
        if (recordingsDir_.empty()) return fail(404, "Not Found", "no recordings directory");
        Settings settings;
        {
            std::lock_guard lock(state_.mu);
            settings = state_.settings;
        }
        std::string error;
        auto player = Player::open(recordingsDir_, param(target, "file"), settings, error);
        if (!player) return fail(404, "Not Found", error);
        std::random_device rd;
        char id[17];
        std::snprintf(id, sizeof id, "%08x%08x", rd(), rd());
        auto sess = std::make_shared<Session>();
        sess->player = std::move(player);
        sess->lastUsedMs = nowMs();
        std::string body = sess->player->statusJson();
        body.pop_back();  // close it after adding the session and overview
        body += std::string(",\"session\":\"") + id + "\",\"overview\":" + sess->player->overviewJson() + "}";
        std::shared_ptr<Session> evicted;
        {
            std::lock_guard lock(sessionsMu_);
            if (sessions_.size() >= 4) {  // each holds an open file and a thread; drop the least recently used
                auto lru = std::min_element(sessions_.begin(), sessions_.end(), [](const auto& a, const auto& b) {
                    return a.second->lastUsedMs < b.second->lastUsedMs;
                });
                evicted = lru->second;
                sessions_.erase(lru);
            }
            sessions_[id] = sess;
        }
        std::printf("replaying %s (session %s)\n", param(target, "file").c_str(), id);
        return json(body);
    }

    std::string sid = param(target, "session");
    if (path == "/api/playback/close") {
        std::shared_ptr<Session> closing;
        {
            std::lock_guard lock(sessionsMu_);
            auto it = sessions_.find(sid);
            if (it != sessions_.end()) {
                closing = it->second;
                sessions_.erase(it);
            }
        }
        return json("{}");  // the player stops when the last user lets go of `closing`
    }
    auto sess = session(sid);
    if (!sess) return fail(404, "Not Found", "replay session ended");
    Player& p = *sess->player;
    if (path == "/api/playback/control") {
        std::string v;
        if (!(v = param(target, "speed")).empty()) p.setSpeed(std::atof(v.c_str()));
        if (!(v = param(target, "seek")).empty()) p.seek(std::atoll(v.c_str()));
        if (!(v = param(target, "play")).empty()) p.setPlaying(v == "1");
    } else if (path != "/api/playback/status") {
        return fail(404, "Not Found", "unknown playback call");
    }
    std::string body = p.statusJson();
    if (param(target, "overview") == "1") {
        body.pop_back();
        body += ",\"overview\":" + p.overviewJson() + "}";
    }
    json(body);
}

std::shared_ptr<HttpServer::Session> HttpServer::session(const std::string& id) {
    std::lock_guard lock(sessionsMu_);
    auto it = sessions_.find(id);
    if (it == sessions_.end()) return nullptr;
    it->second->lastUsedMs = nowMs();
    return it->second;
}

// Ends replay sessions that no tablet has used for two minutes.
void HttpServer::expireSessions() {
    std::vector<std::shared_ptr<Session>> expired;  // destroyed outside the lock
    std::lock_guard lock(sessionsMu_);
    int64_t now = nowMs();
    for (auto it = sessions_.begin(); it != sessions_.end();) {
        if (it->second->streams == 0 && now - it->second->lastUsedMs > 120000) {
            expired.push_back(it->second);
            it = sessions_.erase(it);
        } else {
            ++it;
        }
    }
}

void HttpServer::streamEvents(int fd, const std::string& sessionId, const std::atomic<bool>& stop) {
    const char* header =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: keep-alive\r\n\r\n"
        "retry: 2000\n\n";
    if (!sendAll(fd, header, std::strlen(header))) return;
    std::shared_ptr<Session> sess;
    if (!sessionId.empty() && !(sess = session(sessionId))) {
        sendAll(fd, std::string("event: gone\ndata: {}\n\n"));  // tells the page to go back to live
        return;
    }
    if (sess) ++sess->streams;
    else std::printf("tablet connected (%d stream%s)\n", streams_ + 1, streams_ ? "s" : "");
    ++streams_;
    auto period = std::chrono::microseconds(static_cast<int64_t>(1e6 / rateHz_));
    auto next = std::chrono::steady_clock::now();
    int tick = 0;
    while (!stop) {
        std::string msg;
        if (sess) {
            if (!session(sessionId)) {  // closed from another request
                sendAll(fd, std::string("event: gone\ndata: {}\n\n"));
                break;
            }
            msg = "data: " + sess->player->state()->stateJson() + "\n\n";
            if (tick++ % std::max(1, static_cast<int>(rateHz_)) == 0)
                msg += "event: playback\ndata: " + sess->player->statusJson() + "\n\n";
        } else {
            msg = "data: " + state_.stateJson() + "\n\n";
        }
        if (!sendAll(fd, msg)) break;
        next += period;
        std::this_thread::sleep_until(next);
    }
    --streams_;
    if (sess) --sess->streams;
    else std::printf("tablet disconnected (%d stream%s)\n", streams_.load(), streams_ == 1 ? "" : "s");
}

void HttpServer::serveRecording(int fd, const std::string& name) {
    if (recordingsDir_.empty() || !validRecordingName(name)) {
        respond(fd, 404, "Not Found", "text/plain", "not found\n");
        return;
    }
    std::string file = recordingsDir_ + "/" + name;
    FILE* f = std::fopen(file.c_str(), "rb");
    struct stat st{};
    if (!f || fstat(fileno(f), &st) != 0) {
        if (f) std::fclose(f);
        respond(fd, 404, "Not Found", "text/plain", "not found\n");
        return;
    }
    // Streamed: a day's recording is too big to hold in memory.
    std::ostringstream h;
    h << "HTTP/1.1 200 OK\r\n"
      << "Content-Type: text/plain; charset=utf-8\r\n"
      << "Content-Length: " << st.st_size << "\r\n"
      << "Content-Disposition: attachment; filename=\"" << name << "\"\r\n"
      << "Cache-Control: no-cache\r\n"
      << "Connection: close\r\n\r\n";
    if (sendAll(fd, h.str())) {
        char buf[65536];
        size_t n;
        long left = st.st_size;  // a file still being recorded keeps growing; send what we promised
        while (left > 0 && (n = std::fread(buf, 1, std::min<long>(left, sizeof buf), f)) > 0) {
            if (!sendAll(fd, buf, n)) break;
            left -= static_cast<long>(n);
        }
    }
    std::fclose(f);
}

void HttpServer::serveFile(int fd, const std::string& path, const std::string& ifModifiedSince) {
    if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos) {
        respond(fd, 400, "Bad Request", "text/plain", "bad path\n");
        return;
    }
    bool tile = path.rfind("/tiles/", 0) == 0;
    bool weather = path.rfind("/weather/", 0) == 0;
    if (weather && !weather_) {
        respond(fd, 404, "Not Found", "text/plain", "weather is off\n");
        return;
    }
    std::string file = tile ? tilesRoot_ + path.substr(6) : weather ? weather_->dir() + path.substr(8) : webRoot_ + path;
    struct stat st{};
    std::ifstream in(file, std::ios::binary);
    if (!in || stat(file.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
        respond(fd, 404, "Not Found", "text/plain", "not found\n");
        return;
    }
    // Map tiles and weather images never change (new ones get new names), so
    // tablets may keep them. Everything else is revalidated on each load (cheap:
    // unchanged files get a bodiless 304), so edits to the page always show up.
    if ((tile || weather) && path.size() > 11 && path.compare(path.size() - 11, 11, "/index.json") != 0) {
        std::ostringstream body;
        body << in.rdbuf();
        respond(fd, 200, "OK", contentType(path), body.str(), "max-age=604800");
        return;
    }
    std::string modified = httpDate(st.st_mtime);
    std::string validator = "Last-Modified: " + modified + "\r\n";
    if (ifModifiedSince == modified) {
        respond(fd, 304, "Not Modified", contentType(path), "", "no-cache", validator);
        return;
    }
    std::ostringstream body;
    body << in.rdbuf();
    respond(fd, 200, "OK", contentType(path), body.str(), "no-cache", validator);
}
