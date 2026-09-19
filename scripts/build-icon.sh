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

# Windows also needs an .ico: win.setAppDetails takes a real file path, and the
# taskbar jump-list header uses it. PNG-compressed entries, which Windows reads.
python3 - <<'PYEOF'
import struct, subprocess, os, tempfile
sizes = [16, 32, 48, 64, 128, 256]
tmp = tempfile.mkdtemp()
blobs = []
for s in sizes:
    out = os.path.join(tmp, f'{s}.png')
    subprocess.run(['sips', '-z', str(s), str(s), 'build/icon.png', '--out', out], check=True, capture_output=True)
    blobs.append(open(out, 'rb').read())
header = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries, data = b'', b''
for s, blob in zip(sizes, blobs):
    entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
    data += blob
open('build/icon.ico', 'wb').write(header + entries + data)
PYEOF
echo "wrote build/icon.png and build/icon.ico"
