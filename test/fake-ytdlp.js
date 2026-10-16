#!/usr/bin/env node
// A stand-in for yt-dlp so the full pipeline can be tested offline.
// It answers the same three calls the server makes: metadata, captions, video.
const fs = require('fs');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const DURATION = 300;

if (args.includes('--version')) {
  console.log('0000.00.00-fake');
  process.exit(0);
}

if (args.includes('--print')) {
  console.log(JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Fake Podcast Episode', duration: DURATION, is_live: false, live_status: 'not_live', uploader: 'Test Channel' }));
  process.exit(0);
}

const out = args[args.indexOf('-o') + 1];

if (args.includes('--write-subs')) {
  const stamp = (t) => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.round((t % 1) * 1000)).padStart(3, '0')}`;
  const filler = 'so this is just some regular talking about nothing in particular really';
  const hooky = 'why is this the biggest mistake? nobody tells you the truth and it cost me 5000 dollars in 3 months';
  const lines = ['WEBVTT', 'Kind: captions', 'Language: en', ''];
  let prev = '';
  for (let t = 0; t < DURATION; t += 4) {
    const strong = [60, 120, 180].some((s) => t >= s && t < s + 44);
    // Real speech does not repeat word for word, so make each line unique.
    const text = `${strong ? hooky : filler} ${t}`;
    // Mimic YouTube's rolling format: previous line on top, new line below.
    lines.push(`${stamp(t)} --> ${stamp(t + 4)} align:start position:0%`, prev || ' ', text, '');
    prev = text;
  }
  fs.writeFileSync(`${out}.en.vtt`, lines.join('\n'));
  process.exit(0);
}

// Video download.
const file = out.replace('%(ext)s', 'mp4');
const gen = spawnSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=25:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
]);
if (gen.status !== 0) {
  console.error(`ERROR: ${gen.stderr}`);
  process.exit(1);
}
console.log('download:  50.0%');
console.log('download: 100.0%');
