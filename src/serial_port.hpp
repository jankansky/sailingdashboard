#pragma once
#include <string>

// Opens a serial device in raw, non-blocking mode at 115200 baud.
// Returns the file descriptor, or -1 after printing why.
int openSerialPort(const std::string& device);
