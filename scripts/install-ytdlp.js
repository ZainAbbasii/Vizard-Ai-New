// Downloads the standalone yt-dlp binary into ./bin during `npm install`.
// It never fails the install: if the download is blocked, the server reports
// the problem at /api/health and you can set YTDLP_PATH to a binary you installed yourself.
const fs = require('fs');
const path = require('path');

const force = process.argv.includes('--force');
const binDir = path.join(__dirname, '..', 'bin');

function assetName() {
  const { platform, arch } = process;
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'win32') return 'yt-dlp.exe';
  return null;
}

(async () => {
  if (process.env.YTDLP_PATH) {
    console.log('[yt-dlp] YTDLP_PATH is set; skipping download.');
    return;
  }
  const asset = assetName();
  if (!asset) {
    console.warn(`[yt-dlp] No prebuilt binary for ${process.platform}/${process.arch}. Install yt-dlp and set YTDLP_PATH.`);
    return;
  }
  const dest = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(dest) && !force) {
    console.log('[yt-dlp] Already installed. Run "npm run update:ytdlp" to refresh it.');
    return;
  }
  fs.mkdirSync(binDir, { recursive: true });
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error('download looks truncated');
    fs.writeFileSync(`${dest}.tmp`, buf, { mode: 0o755 });
    fs.renameSync(`${dest}.tmp`, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`[yt-dlp] Installed ${(buf.length / 1e6).toFixed(1)} MB to ${path.relative(process.cwd(), dest)}`);
  } catch (err) {
    console.warn(`[yt-dlp] Download failed: ${err.message}`);
    console.warn('[yt-dlp] Install yt-dlp yourself and set YTDLP_PATH, or retry with "npm run update:ytdlp".');
  }
})();
