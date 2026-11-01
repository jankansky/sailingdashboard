#!/usr/bin/env bash
# Builds and installs the dashboard on a Raspberry Pi (Raspberry Pi OS Bookworm or later).
# Run from the project directory:
#   ./deploy/install.sh                          install / update
#   ./deploy/install.sh --pican3                 also enable the PiCAN3 HAT (CAN + real-time clock)
#   ./deploy/install.sh --canfd-hat              or the Waveshare 2-CH isolated CAN FD HAT (can0 + can1)
#   ./deploy/install.sh --imu                    also enable the serial port for a BNO085 heel sensor
#   ./deploy/install.sh --hotspot SSID PASSWORD  also make the Pi a Wi-Fi hotspot
# Options can be combined.
set -euo pipefail
cd "$(dirname "$0")/.."

pican3=0
canfd=0
imu=0
ssid=""
pass=""
while [ $# -gt 0 ]; do
    case "$1" in
        --pican3) pican3=1; shift ;;
        --canfd-hat) canfd=1; shift ;;
        --imu) imu=1; shift ;;
        --hotspot)
            ssid="${2:?SSID required}"
            pass="${3:?password (8+ characters) required}"
            shift 3 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

if [ "$pican3" = 1 ] && [ "$canfd" = 1 ]; then
    echo "--pican3 and --canfd-hat both use SPI0 and GPIO25; choose one" >&2
    exit 2
fi

sudo apt-get update
sudo apt-get install -y build-essential cmake can-utils rsync

cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j"$(nproc)"

sudo install -d /opt/sailingdashboard/web
sudo install -m 755 build/sailingdashboard /opt/sailingdashboard/
sudo cp -r web/. /opt/sailingdashboard/web/
if [ -d tiles ]; then  # offline map tiles from tools/fetch_tiles.py
    echo "Copying map tiles ($(du -sh tiles | cut -f1))..."
    sudo rsync -a --delete tiles/ /opt/sailingdashboard/tiles/
fi
[ -f /etc/default/sailingdashboard ] || sudo install -m 644 deploy/sailingdashboard.default /etc/default/sailingdashboard

sudo install -m 644 deploy/80-can-n2k.rules /etc/udev/rules.d/
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=net --action=add  # configure an adapter that is already present

sudo install -m 644 deploy/sailingdashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable sailingdashboard
sudo systemctl restart sailingdashboard

reboot_needed=0
if [ "$pican3" = 1 ]; then
    # PiCAN3: MCP2515 on SPI0 with a 16 MHz crystal and its interrupt on GPIO25,
    # plus a PCF8523 real-time clock on I2C.
    config=/boot/firmware/config.txt
    [ -f "$config" ] || config=/boot/config.txt
    for line in "dtparam=spi=on" "dtparam=i2c_arm=on" \
                "dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25" \
                "dtoverlay=i2c-rtc,pcf8523"; do
        if ! grep -qxF "$line" "$config"; then
            echo "$line" | sudo tee -a "$config" >/dev/null
            reboot_needed=1
        fi
    done
    # The RTC replaces the fake clock that Raspberry Pi OS saves at shutdown.
    sudo apt-get purge -y fake-hwclock >/dev/null 2>&1 || true
    echo "PiCAN3 configured in $config"
fi

if [ "$canfd" = 1 ]; then
    # Waveshare 2-CH CAN FD HAT: two MCP2518FD controllers, on SPI0 (interrupt
    # GPIO25) and SPI1 (interrupt GPIO24), per Waveshare's wiki. NMEA 2000 is
    # classic CAN, which these controllers also speak; the udev rule brings both
    # up at 250 kbit/s without FD.
    config=/boot/firmware/config.txt
    [ -f "$config" ] || config=/boot/config.txt
    for line in "dtparam=spi=on" "dtoverlay=spi1-3cs" \
                "dtoverlay=mcp251xfd,spi0-0,interrupt=25" \
                "dtoverlay=mcp251xfd,spi1-0,interrupt=24"; do
        if ! grep -qxF "$line" "$config"; then
            echo "$line" | sudo tee -a "$config" >/dev/null
            reboot_needed=1
        fi
    done
    echo "CAN FD HAT configured in $config"
fi

if [ "$imu" = 1 ]; then
    # BNO085 in UART-RVC mode on GPIO15 (RXD). Give the full UART to GPIO14/15 instead
    # of Bluetooth, and stop the Linux login console from using it.
    config=/boot/firmware/config.txt
    [ -f "$config" ] || config=/boot/config.txt
    for line in "enable_uart=1" "dtoverlay=disable-bt"; do
        if ! grep -qxF "$line" "$config"; then
            echo "$line" | sudo tee -a "$config" >/dev/null
            reboot_needed=1
        fi
    done
    sudo raspi-config nonint do_serial_cons 1 || true
    sudo systemctl disable --now hciuart >/dev/null 2>&1 || true
    if ! grep -q -- "--imu" /etc/default/sailingdashboard; then
        sudo sed -i 's|^DASH_ARGS="\(.*\)"|DASH_ARGS="\1 --imu /dev/serial0"|' /etc/default/sailingdashboard
        sudo systemctl restart sailingdashboard
    fi
    echo "BNO085 serial port enabled (/dev/serial0)"
fi

if [ -n "$ssid" ]; then
    sudo nmcli connection delete boat-hotspot >/dev/null 2>&1 || true
    sudo nmcli connection add type wifi ifname wlan0 con-name boat-hotspot autoconnect yes \
        ssid "$ssid" 802-11-wireless.mode ap 802-11-wireless.band bg ipv4.method shared \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$pass" connection.autoconnect-priority 100
    sudo nmcli connection up boat-hotspot
    echo "Hotspot '$ssid' is up. Tablet URL: http://10.42.0.1/"
fi

echo
echo "Installed. Check with:  systemctl status sailingdashboard   and   candump can0"
echo "Tablet URL: http://$(hostname).local/  (or http://10.42.0.1/ on the hotspot)"
[ "$reboot_needed" = 1 ] && echo "*** Reboot now (sudo reboot) to apply the hardware settings. ***"
exit 0
