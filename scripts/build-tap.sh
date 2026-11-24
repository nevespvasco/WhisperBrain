#!/usr/bin/env bash
# Builds the macOS capture helper (system audio per application through a Core Audio process tap, and the microphone with
# voice processing). Needs the Xcode command line tools and macOS 14.2+ to run (it builds on older ones).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/tap
swiftc -O -o build/tap/whisperbrain-tap native/macos/whisperbrain-tap.swift \
  -framework AVFoundation -framework AudioToolbox -framework CoreAudio -framework Foundation
echo "built build/tap/whisperbrain-tap"
