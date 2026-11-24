#!/usr/bin/env bash
# Builds the Linux accessibility helper (reads who is in a browser's Meet window through AT-SPI). Needs gcc and libatspi2.0-dev.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/atspi
gcc -O2 -Wall -o build/atspi/whisperbrain-atspi native/atspi/whisperbrain-atspi.c $(pkg-config --cflags --libs atspi-2 gobject-2.0)
echo "built build/atspi/whisperbrain-atspi"
