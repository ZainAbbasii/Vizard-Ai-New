const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { run } = require('./proc');

// Returns the 11-character video id, or null. Only YouTube hosts are accepted,
// and the id is re-inserted into a URL we build ourselves, so nothing else the
// visitor types ever reaches yt-dlp's command line.
function parseVideoId(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

class FriendlyError extends Error {}

// Turns yt-dlp's stderr into something a visitor can act on.
function explain(stderr) {
  const s = stderr || '';
  if (/confirm you.?re not a bot|sign in to confirm/i.test(s)) {
    return 'YouTube blocked the download from this server (bot check). This is common on hosting providers. The site owner can fix it by supplying a cookies file; see the README.';
  }
  if (/private video/i.test(s)) return 'That video is private.';
  if (/video unavailable|has been removed|not available/i.test(s)) return 'That video is unavailable.';
  if (/age.?restricted|confirm your age/i.test(s)) return 'That video is age-restricted and cannot be downloaded without a signed-in session.';
  if (/members.?only|join this channel/i.test(s)) return 'That video is for channel members only.';
  if (/HTTP Error 429|too many requests/i.test(s)) return 'YouTube is rate-limiting this server. Try again later.';
  if (/is a live|live event|premieres in/i.test(s)) return 'Live streams and premieres are not supported. Try again after it ends.';
  const last = s.trim().split('\n').filter(Boolean).pop() || 'unknown error';
  return `Could not fetch the video: ${last.replace(/^ERROR:\s*/i, '').slice(0, 200)}`;
}

function baseArgs() {
  const args = ['--no-warnings', '--no-playlist', '--no-color'];
  if (path.isAbsolute(cfg.ffmpegPath)) args.push('--ffmpeg-location', cfg.ffmpegPath);
  if (cfg.cookiesFile) args.push('--cookies', cfg.cookiesFile);
  return args;
}

// Runs yt-dlp. If this build does not know --js-runtimes, retries without it.
async function ytdlp(args, opts = {}) {
  const withRuntime = cfg.jsRuntime ? ['--js-runtimes', cfg.jsRuntime] : [];
  let result;
  try {
    result = await run(cfg.ytdlpPath, [...baseArgs(), ...withRuntime, ...args], opts);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new FriendlyError('The video downloader (yt-dlp) is not installed on this server.');
    }
    throw err;
  }
  if (result.code !== 0 && withRuntime.length && /no such option|unrecognized arguments/i.test(result.stderr)) {
    result = await run(cfg.ytdlpPath, [...baseArgs(), ...args], opts);
  }
  if (result.timedOut) throw new FriendlyError('The download took too long and was cancelled.');
  return result;
}

async function getInfo(id) {
  const result = await ytdlp(
    ['--skip-download', '--print', '%(.{id,title,duration,is_live,live_status,uploader})j', watchUrl(id)],
    { timeoutMs: 90_000 }
  );
  if (result.code !== 0) throw new FriendlyError(explain(result.stderr));
  const line = result.stdout.trim().split('\n').filter(Boolean).pop();
  let info;
  try {
    info = JSON.parse(line);
  } catch {
    throw new FriendlyError('Could not read the video details from YouTube.');
  }
  return {
    id,
    title: String(info.title || 'Untitled video'),
    uploader: info.uploader || '',
    duration: Number(info.duration) || 0,
    isLive: Boolean(info.is_live) || ['is_live', 'is_upcoming'].includes(info.live_status),
  };
}

async function downloadVideo(id, dir, onPercent) {
  const result = await ytdlp(
    [
      '-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
      '-S', 'vcodec:h264,res,acodec:aac',
      '--merge-output-format', 'mp4',
      '--max-filesize', '2G',
      '--newline',
      '--progress-template', 'download:%(progress._percent_str)s',
      '-o', path.join(dir, 'source.%(ext)s'),
      watchUrl(id),
    ],
    {
      timeoutMs: 25 * 60_000,
      onStdout: (chunk) => {
        for (const m of chunk.matchAll(/download:\s*([\d.]+)%/g)) onPercent(parseFloat(m[1]));
      },
    }
  );
  if (result.code !== 0) throw new FriendlyError(explain(result.stderr));
  const file = fs.readdirSync(dir).find((f) => /^source\.(mp4|mkv|webm|mov)$/.test(f));
  if (!file) throw new FriendlyError('The download finished but no video file was produced.');
  return path.join(dir, file);
}

// Captions are optional: failure here just means we fall back to evenly spaced clips.
async function downloadCaptions(id, dir) {
  try {
    await ytdlp(
      [
        '--skip-download',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'en.*,.*-orig,-live_chat',
        '--sub-format', 'vtt',
        '-o', path.join(dir, 'captions'),
        watchUrl(id),
      ],
      { timeoutMs: 60_000 }
    );
  } catch {
    return null;
  }
  const files = fs.readdirSync(dir).filter((f) => /^captions\..+\.vtt$/.test(f));
  if (!files.length) return null;
  const rank = (f) => (/\.en\.vtt$/.test(f) ? 0 : /\.en-[A-Za-z]+\.vtt$/.test(f) ? 1 : /-orig\.vtt$/.test(f) ? 2 : 3);
  files.sort((a, b) => rank(a) - rank(b));
  return path.join(dir, files[0]);
}

async function checkTools() {
  const out = { ytdlp: null, ffmpeg: null };
  try {
    const r = await run(cfg.ytdlpPath, ['--version'], { timeoutMs: 15_000 });
    if (r.code === 0) out.ytdlp = r.stdout.trim();
  } catch {
    // not installed
  }
  try {
    const r = await run(cfg.ffmpegPath, ['-version'], { timeoutMs: 15_000 });
    if (r.code === 0) out.ffmpeg = (r.stdout.split('\n')[0] || '').replace(/^ffmpeg version\s+/, '').split(' ')[0];
  } catch {
    // not installed
  }
  return out;
}

module.exports = { parseVideoId, watchUrl, getInfo, downloadVideo, downloadCaptions, checkTools, FriendlyError };
