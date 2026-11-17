#!/usr/bin/env bash
# Deterministic local media fixtures for AdStreamX tests and the Player Lab.
# Requires: ffmpeg with libx264 + aac (tested with FFmpeg 4.4.2 and 6.x).
# Output: infrastructure/fixtures/media (gitignored — regenerate with `npm run fixtures`).
#
# Every rendition uses a fixed 2-second GOP (25 fps, -g 50, no scene-cut keyframes),
# so HLS segments are exactly 2.000 s and the live simulator can slide a window
# over them on a wall-clock schedule.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/infrastructure/fixtures/media"
STATIC="$ROOT/infrastructure/fixtures/static"
FF="ffmpeg -hide_banner -loglevel error -y"
GOP="-r 25 -g 50 -keyint_min 50 -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*2)"
X264="-c:v libx264 -preset veryfast -profile:v main -level 3.1 -pix_fmt yuv420p $GOP"
AAC="-c:a aac -b:a 96k -ar 48000 -ac 2"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$OUT"/{mp4,captions,hls/vod,hls/vod-fmp4,hls/vod-multiaudio,live-src/ts,live-src/fmp4,errors}

# Video source: test pattern with a burned-in clock so frames are visually distinct
# (drawtext is optional — falls back to the plain pattern if libfreetype is missing).
has_drawtext() { ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' drawtext '; }
vsrc() { # $1=duration $2=size $3=label
  local f="testsrc2=size=$2:rate=25:duration=$1"
  if has_drawtext; then
    f="$f,drawtext=text='$3 %{pts\\:hms}':x=12:y=12:fontsize=h/12:fontcolor=white:box=1:boxcolor=black@0.6"
  fi
  echo "$f"
}
asrc() { echo "sine=frequency=$1:sample_rate=48000:duration=$2"; }

echo "[fixtures] MP4 VOD (12 s, 640x360)"
$FF -f lavfi -i "$(vsrc 12 640x360 MP4)" -f lavfi -i "$(asrc 440 12)" \
  $X264 -b:v 900k $AAC -movflags +faststart "$OUT/mp4/short.mp4"

echo "[fixtures] House advertisement (6 s)"
HA="color=c=0x6d28d9:size=640x360:rate=25:duration=6"
if has_drawtext; then HA="$HA,drawtext=text='HOUSE AD %{pts\\:hms}':x=(w-tw)/2:y=(h-th)/2:fontsize=40:fontcolor=white"; fi
$FF -f lavfi -i "$HA" -f lavfi -i "$(asrc 660 6)" $X264 -b:v 600k $AAC -movflags +faststart "$OUT/mp4/house-ad.mp4"

echo "[fixtures] Captions (WebVTT)"
cp "$STATIC"/captions/*.vtt "$OUT/captions/"

echo "[fixtures] HLS VOD, MPEG-TS, 3 renditions (20 s)"
$FF -f lavfi -i "$(vsrc 20 1280x720 HLS-VOD)" -f lavfi -i "$(asrc 440 20)" \
  -filter_complex "[0:v]split=3[a][b][c];[a]scale=426:240[v0];[b]scale=640:360[v1];[c]scale=1280:720[v2]" \
  -map "[v0]" -map 1:a -map "[v1]" -map 1:a -map "[v2]" -map 1:a \
  $X264 -b:v:0 400k -maxrate:v:0 440k -bufsize:v:0 800k \
  -b:v:1 900k -maxrate:v:1 990k -bufsize:v:1 1800k \
  -b:v:2 2200k -maxrate:v:2 2420k -bufsize:v:2 4400k $AAC \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename "$OUT/hls/vod/v%v/seg_%03d.ts" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0,name:240p v:1,a:1,name:360p v:2,a:2,name:720p" \
  "$OUT/hls/vod/v%v/index.m3u8"
# ffmpeg names variant dirs by the "name:" key.
# Add a WebVTT subtitle rendition to the master playlist.
mkdir -p "$OUT/hls/vod/subs"
cp "$STATIC/captions/hls-vod.en.vtt" "$OUT/hls/vod/subs/en.vtt"
cat > "$OUT/hls/vod/subs/en.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:20
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:20.000,
en.vtt
#EXT-X-ENDLIST
EOF
node "$ROOT/infrastructure/scripts/patch-master.mjs" "$OUT/hls/vod/master.m3u8" subs

echo "[fixtures] HLS VOD, fMP4/CMAF, 2 renditions (20 s)"
$FF -f lavfi -i "$(vsrc 20 640x360 FMP4-VOD)" -f lavfi -i "$(asrc 520 20)" \
  -filter_complex "[0:v]split=2[a][b];[a]scale=426:240[v0];[b]copy[v1]" \
  -map "[v0]" -map 1:a -map "[v1]" -map 1:a \
  $X264 -b:v:0 400k -b:v:1 900k $AAC \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 -hls_flags independent_segments \
  -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename "$OUT/hls/vod-fmp4/v%v/seg_%03d.m4s" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0,name:240p v:1,a:1,name:360p" \
  "$OUT/hls/vod-fmp4/v%v/index.m3u8"

echo "[fixtures] HLS VOD with alternate audio renditions (en 440 Hz / es 880 Hz)"
MA="$OUT/hls/vod-multiaudio"; mkdir -p "$MA/video"
$FF -f lavfi -i "$(vsrc 12 640x360 MULTI-AUDIO)" -an $X264 -b:v 700k \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_filename "$MA/video/seg_%03d.ts" "$MA/video/index.m3u8"
for spec in "en 440" "es 880"; do
  set -- $spec
  mkdir -p "$MA/audio-$1"
  $FF -f lavfi -i "$(asrc "$2" 12)" $AAC -f hls -hls_time 2 -hls_playlist_type vod \
    -hls_segment_filename "$MA/audio-$1/seg_%03d.aac" "$MA/audio-$1/index.m3u8"
done
cat > "$MA/master.m3u8" <<'EOF'
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en/index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="es",DEFAULT=NO,AUTOSELECT=YES,URI="audio-es/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
video/index.m3u8
EOF

echo "[fixtures] Live source segments (120 s loop, 2 s segments)"
# The fixture server turns these into rolling live playlists (see server.mjs).
$FF -f lavfi -i "$(vsrc 120 1280x720 LIVE)" -f lavfi -i "$(asrc 330 120)" \
  -filter_complex "[0:v]split=2[a][b];[a]scale=426:240[v0];[b]scale=640:360[v1]" \
  -map "[v0]" -map 1:a -map "[v1]" -map 1:a \
  $X264 -b:v:0 350k -b:v:1 800k $AAC \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_flags independent_segments \
  -hls_segment_filename "$OUT/live-src/ts/v%v/seg_%03d.ts" \
  -master_pl_name master.m3u8 -var_stream_map "v:0,a:0,name:240p v:1,a:1,name:360p" \
  "$OUT/live-src/ts/v%v/index.m3u8"
mkdir -p "$OUT/live-src/fmp4/v360p"
$FF -f lavfi -i "$(vsrc 120 640x360 LIVE-CMAF)" -f lavfi -i "$(asrc 330 120)" \
  $X264 -b:v 700k $AAC -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 -hls_segment_filename "$OUT/live-src/fmp4/v360p/seg_%03d.m4s" \
  "$OUT/live-src/fmp4/v360p/index.m3u8"

echo "[fixtures] Error fixtures"
printf '<!doctype html><title>not a playlist</title>' > "$OUT/errors/invalid.m3u8"
head -c 4096 /dev/zero | tr '\0' 'Z' > "$OUT/errors/unsupported.xyz"

node "$ROOT/infrastructure/scripts/fixture-manifest.mjs" "$OUT"
echo "[fixtures] done -> $OUT"
