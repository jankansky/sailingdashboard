#pragma once
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

// Minimal streaming JSON writer. NaN numbers become null.
class JsonWriter {
public:
    std::string out;

    void beginObj(std::string_view k = {}) { open(k, '{'); }
    void endObj() { close('}'); }
    void beginArr(std::string_view k = {}) { open(k, '['); }
    void endArr() { close(']'); }

    void num(std::string_view k, double v, int prec = 2) {
        key(k);
        raw(v, prec);
    }
    void num(double v, int prec = 2) {
        sep();
        raw(v, prec);
    }
    void integer(std::string_view k, int64_t v) {
        key(k);
        out += std::to_string(v);
    }
    void integer(int64_t v) {
        sep();
        out += std::to_string(v);
    }
    void boolean(std::string_view k, bool v) {
        key(k);
        out += v ? "true" : "false";
    }
    void str(std::string_view k, std::string_view v) {
        key(k);
        quoted(v);
    }
    void strOrNull(std::string_view k, const char* v) {
        key(k);
        if (v) quoted(v);
        else out += "null";
    }

private:
    std::vector<bool> first_;

    void sep() {
        if (first_.empty()) return;
        if (!first_.back()) out += ',';
        first_.back() = false;
    }
    void key(std::string_view k) {
        sep();
        quoted(k);
        out += ':';
    }
    void open(std::string_view k, char c) {
        if (k.empty()) sep();
        else key(k);
        out += c;
        first_.push_back(true);
    }
    void close(char c) {
        out += c;
        first_.pop_back();
    }
    void raw(double v, int prec) {
        if (!std::isfinite(v)) {
            out += "null";
            return;
        }
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.*f", prec, v);
        out += buf;
    }
    void quoted(std::string_view s) {
        out += '"';
        for (unsigned char c : s) {
            if (c == '"' || c == '\\') {
                out += '\\';
                out += static_cast<char>(c);
            } else if (c < 0x20 || c > 0x7E) {
                out += '?';
            } else {
                out += static_cast<char>(c);
            }
        }
        out += '"';
    }
};
