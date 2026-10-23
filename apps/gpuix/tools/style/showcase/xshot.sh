#!/usr/bin/env bash
# Screenshot a GPUIX entry under Xvfb + lavapipe once it logs a ready line.
# usage: xshot.sh <entry.tsx> <out.png> [readyText] [timeoutSec]
set -euo pipefail
entry=$1 out=$2 ready=${3:-ready} limit=${4:-60}
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json GPUIX_BACKGROUND=1
disp=:$((170 + RANDOM % 20))
Xvfb "$disp" -screen 0 1320x840x24 -nolisten tcp >/dev/null 2>&1 & xpid=$!
apid=
trap 'kill $apid $xpid 2>/dev/null || true' EXIT
sleep 0.5
DISPLAY=$disp bun "$entry" >"$out.log" 2>&1 & apid=$!
for _ in $(seq $((limit * 4))); do
  grep -q "$ready" "$out.log" && break
  kill -0 "$apid" 2>/dev/null || { echo "entry exited early, see $out.log" >&2; exit 1; }
  sleep 0.25
done
grep -q "$ready" "$out.log" || { echo "timed out waiting for '$ready'" >&2; exit 1; }
sleep "${SHOT_SETTLE:-1}"
# GPUI places the window itself (+2+0 under a bare Xvfb), so grab where it is.
geom=$(DISPLAY=$disp xwininfo -root -tree | grep -m1 -oE '[0-9]+x[0-9]+\+[0-9]+\+[0-9]+ +\+[0-9]+\+[0-9]+$' | awk '{print $2}')
x=$(echo "$geom" | cut -d+ -f2) y=$(echo "$geom" | cut -d+ -f3)
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -video_size 1280x800 -i "$disp+$x,$y" -frames:v 1 "$out"
echo "window origin $x,$y"
echo "wrote $out"
