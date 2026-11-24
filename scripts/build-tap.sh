#!/usr/bin/env bash
# Builds the macOS capture helper (system audio per application through a Core Audio process tap, and the microphone with
# voice processing). Needs the Xcode command line tools and macOS 14.2+ to run (it builds on older ones).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/tap
# one binary for Apple silicon and Intel, built for macOS 14.2 (the first with process taps) so that it also loads there
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos14.2" -o "build/tap/whisperbrain-tap-$arch" native/macos/whisperbrain-tap.swift \
    -framework AVFoundation -framework AudioToolbox -framework CoreAudio -framework Foundation
done
lipo -create -output build/tap/whisperbrain-tap build/tap/whisperbrain-tap-arm64 build/tap/whisperbrain-tap-x86_64
rm build/tap/whisperbrain-tap-arm64 build/tap/whisperbrain-tap-x86_64
echo "built build/tap/whisperbrain-tap"
