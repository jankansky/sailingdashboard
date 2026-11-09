#!/usr/bin/env bash
# Copies this project from the development machine to the Pi over SSH, then
# builds and installs it there. Only changed files are sent.
#   ./deploy/push.sh user@host                 sync, rebuild, install, restart
#   ./deploy/push.sh user@host --tiles         also send the offline map tiles
#   ./deploy/push.sh user@host --setup [opts]  first time: run install.sh on the Pi
#                                              with any of its options (--pican3, ...)
# Set PI=user@host in your environment to leave out the first argument.
set -euo pipefail
cd "$(dirname "$0")/.."

host="${PI:-}"
if [ $# -gt 0 ] && [[ "$1" != --* ]]; then host="$1"; shift; fi
[ -n "$host" ] || { echo "usage: $0 user@host [--tiles] [--setup install-options...]" >&2; exit 2; }

tiles=0
setup=0
while [ $# -gt 0 ]; do
    case "$1" in
        --tiles) tiles=1; shift ;;
        --setup) setup=1; shift; break ;;  # the rest goes to install.sh
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

dest=sailingdashboard  # in the Pi user's home directory
rsync -az --delete --stats \
    --exclude 'build/' --exclude 'cmake-build-*/' --exclude '.idea/' \
    --exclude 'tiles/' --exclude 'tiles_cache/' --exclude 'recordings/' --exclude 'weather/' --exclude '.DS_Store' \
    ./ "$host:$dest/"
if [ "$tiles" = 1 ] && [ -d tiles ]; then
    echo "Sending map tiles ($(du -sh tiles | cut -f1))..."
    rsync -az --delete tiles/ "$host:$dest/tiles/"
fi

if [ "$setup" = 1 ]; then
    ssh -t "$host" "cd $dest && ./deploy/install.sh $*"
else
    # Quick update: rebuild and replace the program and web files only.
    ssh -t "$host" "set -e; cd $dest
        cmake -S . -B build -DCMAKE_BUILD_TYPE=Release >/dev/null
        cmake --build build -j\$(nproc)
        sudo install -m 755 build/sailingdashboard /opt/sailingdashboard/
        sudo install -m 644 tools/fetch_weather.py /opt/sailingdashboard/
        sudo rsync -a --delete web/ /opt/sailingdashboard/web/
        sudo install -m 644 deploy/sailingdashboard.service /etc/systemd/system/
        sudo systemctl daemon-reload
        if [ -d tiles ]; then sudo rsync -a --delete tiles/ /opt/sailingdashboard/tiles/; fi
        sudo systemctl restart sailingdashboard
        systemctl --no-pager --lines=5 status sailingdashboard"
fi
