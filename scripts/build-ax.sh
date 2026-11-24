#!/usr/bin/env bash
# Builds the macOS accessibility helper (reads a browser's Meet window through the AX API). Needs the Xcode command line tools.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/ax
swiftc -O -o build/ax/whisperbrain-ax native/macos/whisperbrain-ax.swift -framework ApplicationServices -framework AppKit
echo "built build/ax/whisperbrain-ax"
