require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./lib/config');
const jobs = require('./lib/jobs');
const { checkTools } = require('./lib/youtube');

const app = express();
// Hosted behind a reverse proxy (Cloudways Velocity). Without this every visitor
// shares the proxy's IP and the per-IP hourly limit would apply to everyone together.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  next();
});

let tools = { ytdlp: null, ffmpeg: null };
checkTools().then((t) => {
  tools = t;
  console.log(`[tools] yt-dlp: ${t.ytdlp || 'MISSING'} | ffmpeg: ${t.ffmpeg || 'MISSING'}`);
});

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/health', (req, res) => res.json({ ok: Boolean(tools.ytdlp && tools.ffmpeg), ...tools }));

app.get('/api/config', (req, res) => {
  res.json({
    ready: Boolean(tools.ytdlp && tools.ffmpeg),
    missing: [!tools.ytdlp && 'yt-dlp', !tools.ffmpeg && 'ffmpeg'].filter(Boolean),
    accessCodeRequired: Boolean(cfg.accessCode),
    clipCount: cfg.clipCount,
    maxVideoMinutes: cfg.maxVideoMinutes,
    ai: Boolean(cfg.anthropicKey),
  });
});

app.post('/api/jobs', (req, res) => {
  const body = req.body || {};
  if (cfg.accessCode && !safeEqual(body.accessCode || '', cfg.accessCode)) {
    return res.status(401).json({ error: 'That access code is not correct.' });
  }
  if (body.confirmRights !== true) {
    return res.status(400).json({ error: 'Confirm that you own this video or have permission to clip it.' });
  }
  if (!tools.ytdlp || !tools.ffmpeg) {
    return res.status(503).json({ error: 'The server is missing a required tool. The site owner needs to check /api/health.' });
  }
  try {
    const job = jobs.submit({
      url: typeof body.url === 'string' ? body.url : '',
      format: typeof body.format === 'string' ? body.format : 'vertical',
      ip: req.ip,
    });
    res.status(202).json(job);
  } catch (err) {
    if (err instanceof jobs.HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Unexpected error.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = /^[0-9a-f-]{36}$/.test(req.params.id) ? jobs.get(req.params.id) : null;
  if (!job) return res.status(404).json({ error: 'That job no longer exists. Clips are deleted after a while.' });
  res.set('Cache-Control', 'no-store').json(job);
});

// Finished clips. Folder names are random UUIDs, so links are unguessable.
app.use(
  '/clips',
  express.static(cfg.workDir, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => res.set('X-Robots-Tag', 'noindex'),
  })
);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`Cutroom running on port ${cfg.port}`);
});
