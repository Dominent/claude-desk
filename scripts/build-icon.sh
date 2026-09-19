#!/bin/zsh
# Render build/icon.png from build/icon.svg. Keep -b none: a converter that
# flattens the background (Quick Look does) leaves an opaque white square
# behind the rounded corners in the Dock and the taskbar.
set -eu
cd "$(dirname "$0")/.."
if ! command -v rsvg-convert >/dev/null; then
  echo "needs rsvg-convert (brew install librsvg)" >&2
  exit 1
fi
rsvg-convert -w 1024 -h 1024 -b none build/icon.svg -o build/icon.png
echo "wrote build/icon.png"
