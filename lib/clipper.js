const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { run } = require('./proc');

// Center crop only: no face tracking. Output sizes are fixed so every clip is consistent.
const FORMATS = {
  vertical: "crop='min(iw,trunc(ih*9/16/2)*2)':ih,scale=720:1280",
  square: "crop='min(iw,ih)':'min(iw,ih)',scale=720:720",
  original: "scale=-2:'min(720,ih)'",
};

const srtTime = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
};

// Captions that fall inside the clip, re-timed to start at zero.
function buildSrt(cues, start, duration) {
  const blocks = [];
  for (const cue of cues) {
    if (cue.end <= start || cue.start >= start + duration) continue;
    const from = Math.max(0, cue.start - start);
    const to = Math.min(duration, cue.end - start);
    if (to - from < 0.05) continue;
    blocks.push(`${blocks.length + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${cue.text}\n`);
  }
  return blocks.join('\n');
}

async function encode({ input, outName, start, duration, filter, dir }) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-i', input,
    '-t', duration.toFixed(3),
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-threads', '2',
    outName,
  ];
  const result = await run(cfg.ffmpegPath, args, { cwd: dir, timeoutMs: 10 * 60_000 });
  const ok = result.code === 0 && fs.existsSync(path.join(dir, outName));
  return { ok, stderr: result.stderr };
}

// Cuts one clip. Tries with burned-in captions first, then without if that fails
// (for example when the server's ffmpeg has no usable font).
async function cutClip({ input, dir, n, start, duration, cues, format = 'vertical' }) {
  const base = FORMATS[format] || FORMATS.vertical;
  const outName = `clip-${n}.mp4`;
  const srtName = `clip-${n}.srt`;
  const srt = cues && cues.length ? buildSrt(cues, start, duration) : '';

  if (srt) {
    fs.writeFileSync(path.join(dir, srtName), srt);
    const style = 'FontName=DejaVu Sans,FontSize=8,Bold=1,Outline=2,Shadow=0,MarginV=60,MarginL=20,MarginR=20,Alignment=2';
    const filter = `${base},subtitles=${srtName}:force_style='${style}'`;
    const withCaptions = await encode({ input, outName, start, duration, filter, dir });
    if (withCaptions.ok) return { file: outName, captions: true };
  }
  const plain = await encode({ input, outName, start, duration, filter: base, dir });
  if (!plain.ok) throw new Error(`ffmpeg failed: ${plain.stderr.trim().split('\n').pop() || 'unknown error'}`);
  return { file: outName, captions: false };
}

module.exports = { cutClip, buildSrt, FORMATS };
