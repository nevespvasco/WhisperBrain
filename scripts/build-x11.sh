#!/usr/bin/env bash
# Builds the Linux X11 helper (global key listener + paste via XTest). Needs gcc and libx11-dev libxi-dev libxtst-dev.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/x11
gcc -O2 -Wall -o build/x11/whisperbrain-x11 native/x11/whisperbrain-x11.c $(pkg-config --cflags --libs x11 xi xtst)
echo "built build/x11/whisperbrain-x11"
