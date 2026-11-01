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
    if (method != "GET" && method != "HEAD") {
        respond(fd, 405, "Method Not Allowed", "text/plain", "GET only\n");
        return;
    }
    std::string path = target.substr(0, target.find('?'));

    if (path == "/events") streamEvents(fd, stop);
    else if (path == "/api/state") respond(fd, 200, "OK", "application/json", state_.stateJson());
    else if (path == "/api/devices") respond(fd, 200, "OK", "application/json", state_.devicesJson());
    else if (path == "/api/ais") respond(fd, 200, "OK", "application/json", state_.aisJson());
    else if (path == "/api/history") respond(fd, 200, "OK", "application/json", state_.historyJson());
    else serveFile(fd, path == "/" ? "/index.html" : path, header(req, "If-Modified-Since"));
}

void HttpServer::streamEvents(int fd, const std::atomic<bool>& stop) {
    const char* header =
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/event-stream\r\n"
        "Cache-Control: no-cache\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: keep-alive\r\n\r\n"
        "retry: 2000\n\n";
    if (!sendAll(fd, header, std::strlen(header))) return;
    std::printf("tablet connected (%d stream%s)\n", streams_ + 1, streams_ ? "s" : "");
    ++streams_;
    auto period = std::chrono::microseconds(static_cast<int64_t>(1e6 / rateHz_));
    auto next = std::chrono::steady_clock::now();
    while (!stop) {
        if (!sendAll(fd, "data: " + state_.stateJson() + "\n\n")) break;
        next += period;
        std::this_thread::sleep_until(next);
    }
    --streams_;
    std::printf("tablet disconnected (%d stream%s)\n", streams_.load(), streams_ == 1 ? "" : "s");
}

void HttpServer::serveFile(int fd, const std::string& path, const std::string& ifModifiedSince) {
    if (path.find("..") != std::string::npos || path.find('\\') != std::string::npos) {
        respond(fd, 400, "Bad Request", "text/plain", "bad path\n");
        return;
    }
    bool tile = path.rfind("/tiles/", 0) == 0;
    std::string file = tile ? tilesRoot_ + path.substr(6) : webRoot_ + path;
    struct stat st{};
    std::ifstream in(file, std::ios::binary);
    if (!in || stat(file.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) {
        respond(fd, 404, "Not Found", "text/plain", "not found\n");
        return;
    }
    // Map tiles never change, so tablets may keep them. Everything else is
    // revalidated on each load (cheap: unchanged files get a bodiless 304), so
    // edits to the page always show up.
    if (tile && path != "/tiles/index.json") {
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
