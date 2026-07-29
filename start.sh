#!/usr/bin/env bash
# YT Studio launcher for Linux and macOS
set -euo pipefail
cd "$(dirname "$0")"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 &&
     "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo "Python 3.8+ not found."
  echo "  Debian/Ubuntu:  sudo apt install python3 ffmpeg"
  echo "  macOS:          brew install python ffmpeg"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x ./bin/ffmpeg ]; then
  echo "FFmpeg not found. Install it first:"
  echo "  Debian/Ubuntu:  sudo apt install ffmpeg"
  echo "  macOS:          brew install ffmpeg"
  exit 1
fi

exec "$PY" app.py
