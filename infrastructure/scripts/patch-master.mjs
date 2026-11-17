#!/usr/bin/env node
// Adds a WebVTT SUBTITLES rendition group to an ffmpeg-generated HLS master playlist
// and an explicit CODECS attribute to each variant (ffmpeg 4.4 omits CODECS for TS).
import fs from 'node:fs';

const [file, subsDir] = process.argv.slice(2);
if (!file) throw new Error('usage: patch-master.mjs <master.m3u8> [subsDir]');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const out = [];
for (const line of lines) {
  if (line.startsWith('#EXT-X-STREAM-INF:')) {
    let l = line;
    if (!/CODECS=/.test(l)) l += ',CODECS="avc1.4d401f,mp4a.40.2"';
    if (subsDir && !/SUBTITLES=/.test(l)) l += ',SUBTITLES="subs"';
    out.push(l);
  } else {
    out.push(line);
  }
  if (line.startsWith('#EXT-X-VERSION') && subsDir) {
    out.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="${subsDir}/en.m3u8"`,
    );
  }
}
fs.writeFileSync(file, out.join('\n'));
