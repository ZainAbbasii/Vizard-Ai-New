const fs = require('fs');
const os = require('os');
const path = require('path');

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function resolveYtdlp() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const local = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return fs.existsSync(local) ? local : 'yt-dlp';
}

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // optional dependency not installed; fall back to a system ffmpeg
  }
  return 'ffmpeg';
}

// Cookies let yt-dlp look like a signed-in browser, which helps when YouTube blocks hosting IPs.
// Provide a file path (YTDLP_COOKIES) or the file's contents as base64 (YTDLP_COOKIES_B64)
// so the secret can live in the host's environment settings instead of Git.
function resolveCookies() {
  if (process.env.YTDLP_COOKIES) return process.env.YTDLP_COOKIES;
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const file = path.join(os.tmpdir(), 'cutroom-yt-cookies.txt');
      fs.writeFileSync(file, Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64'), { mode: 0o600 });
      return file;
    } catch {
      return '';
    }
  }
  return '';
}

module.exports = {
  port: int(process.env.PORT, 3000),
  workDir: process.env.WORK_DIR || path.join(__dirname, '..', 'work'),

  clipCount: int(process.env.CLIP_COUNT, 5),
  clipMinSeconds: int(process.env.CLIP_MIN_SECONDS, 25),
  clipMaxSeconds: int(process.env.CLIP_MAX_SECONDS, 55),
  maxVideoMinutes: int(process.env.MAX_VIDEO_MINUTES, 60),

  // Protect a small server: one job runs at a time, a few may wait.
  maxQueue: int(process.env.MAX_QUEUE, 4),
  jobsPerHour: int(process.env.JOBS_PER_HOUR, 4),
  keepMinutes: int(process.env.KEEP_MINUTES, 120),
  accessCode: process.env.ACCESS_CODE || '',

  ytdlpPath: resolveYtdlp(),
  ffmpegPath: resolveFfmpeg(),
  cookiesFile: resolveCookies(),
  // yt-dlp needs a JavaScript runtime for some YouTube extraction. We already have Node.
  jsRuntime: process.env.YTDLP_JS_RUNTIME === 'off' ? '' : process.env.YTDLP_JS_RUNTIME || `node:${process.execPath}`,

  // Optional: let Claude choose among the top candidate moments and write titles.
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
};
