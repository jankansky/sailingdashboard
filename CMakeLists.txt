cmake_minimum_required(VERSION 3.16)
project(sailingdashboard CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

add_executable(sailingdashboard
        src/main.cpp
        src/boat_state.cpp
        src/n2k.cpp
        src/frame_source.cpp
        src/simulator.cpp
        src/http_server.cpp
        src/imu_rvc.cpp
        src/serial_port.cpp
        src/recorder.cpp
        src/playback.cpp)
target_compile_options(sailingdashboard PRIVATE -Wall -Wextra)
target_link_libraries(sailingdashboard PRIVATE Threads::Threads)
