const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const yt = require('./youtube');
const { parseVtt } = require('./vtt');
const { pickHighlights } = require('./highlights');
const { refine } = require('./llm');
const { cutClip, FORMATS } = require('./clipper');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const jobs = new Map();
const queue = [];
const recentByIp = new Map();
let busy = false;

// Start clean: files left over from a previous run are never reachable again.
fs.mkdirSync(cfg.workDir, { recursive: true });
for (const entry of fs.readdirSync(cfg.workDir)) {
  fs.rmSync(path.join(cfg.workDir, entry), { recursive: true, force: true });
}

function submit({ url, format, ip }) {
  const videoId = yt.parseVideoId(url);
  if (!videoId) throw new HttpError(400, 'Paste a YouTube video link, like https://www.youtube.com/watch?v=...');

  const now = Date.now();
  const recent = (recentByIp.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= cfg.jobsPerHour) {
    throw new HttpError(429, `Limit reached: ${cfg.jobsPerHour} videos per hour. Try again later.`);
  }
  if (queue.length + (busy ? 1 : 0) >= cfg.maxQueue) {
    throw new HttpError(503, 'The server is busy with other videos. Try again in a few minutes.');
  }
  recent.push(now);
  recentByIp.set(ip, recent);

  const job = {
    id: crypto.randomUUID(),
    videoId,
    format: FORMATS[format] ? format : 'vertical',
    status: 'queued',
    stage: 'Waiting in line',
    percent: 0,
    error: null,
    video: null,
    method: null,
    notes: [],
    clips: [],
    createdAt: now,
    finishedAt: null,
  };
  jobs.set(job.id, job);
  queue.push(job);
  setImmediate(processNext);
  return view(job);
}

function view(job) {
  return {
    id: job.id,
    format: job.format,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    position: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    error: job.error,
    video: job.video,
    method: job.method,
    notes: job.notes,
    clips: job.clips,
  };
}

function get(id) {
  const job = jobs.get(id);
  return job ? view(job) : null;
}

async function processNext() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try {
    await runJob(job);
  } finally {
    job.finishedAt = Date.now();
    busy = false;
    setImmediate(processNext);
  }
}

async function runJob(job) {
  const dir = path.join(cfg.workDir, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const progress = (stage, percent) => {
    job.stage = stage;
    job.percent = Math.round(percent);
  };

  try {
    job.status = 'running';
    progress('Checking the video', 3);
    const info = await yt.getInfo(job.videoId);
    if (info.isLive) throw new yt.FriendlyError('Live streams and premieres are not supported. Try again after it ends.');
    if (!info.duration) throw new yt.FriendlyError('Could not determine the length of that video.');
    if (info.duration < 20) throw new yt.FriendlyError('That video is under 20 seconds, which is too short to cut into clips.');
    if (info.duration > cfg.maxVideoMinutes * 60) {
      throw new yt.FriendlyError(
        `That video is ${Math.round(info.duration / 60)} minutes long. This server accepts up to ${cfg.maxVideoMinutes} minutes.`
      );
    }
    job.video = { title: info.title, uploader: info.uploader, duration: info.duration, url: yt.watchUrl(job.videoId) };

    progress('Downloading the video', 5);
    const input = await yt.downloadVideo(job.videoId, dir, (p) =>
      progress(`Downloading the video (${Math.round(p)}%)`, 5 + p * 0.5)
    );

    progress('Reading captions', 57);
    let cues = [];
    const captionFile = await yt.downloadCaptions(job.videoId, dir);
    if (captionFile) {
      try {
        cues = parseVtt(fs.readFileSync(captionFile, 'utf8'));
      } catch {
        cues = [];
      }
    }

    progress('Choosing the best moments', 62);
    const opts = { count: cfg.clipCount, min: cfg.clipMinSeconds, max: cfg.clipMaxSeconds };
    const found = pickHighlights(cues, info.duration, opts);
    let picks = found.picks;
    job.method = found.method;
    if (found.method === 'transcript') {
      const refined = await refine(found.pool, cfg.clipCount, info.title);
      if (refined) {
        picks = refined;
        job.method = 'transcript+ai';
      }
    }
    if (found.method === 'even') {
      job.notes.push('This video has no usable captions, so the clips are spaced evenly instead of chosen by content.');
    } else if (picks.length < cfg.clipCount) {
      job.notes.push(`Only ${picks.length} clearly separate moments were found in this video.`);
    }
    picks = [...picks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.start - b.start);

    let captioned = 0;
    for (let k = 0; k < picks.length; k++) {
      const pick = picks[k];
      progress(`Cutting clip ${k + 1} of ${picks.length}`, 65 + (k / picks.length) * 33);
      const out = await cutClip({
        input,
        dir,
        n: k + 1,
        start: pick.start,
        duration: pick.duration,
        cues,
        format: job.format,
      });
      if (out.captions) captioned++;
      job.clips.push({
        n: k + 1,
        title: pick.title,
        reason: pick.reason,
        score: pick.score,
        start: pick.start,
        end: pick.end,
        duration: pick.duration,
        captions: out.captions,
        url: `/clips/${job.id}/${out.file}`,
        sourceUrl: `${job.video.url}&t=${Math.floor(pick.start)}s`,
      });
    }
    if (cues.length && captioned === 0) {
      job.notes.push('Captions could not be burned into the clips on this server, so they have no on-screen text.');
    }

    progress('Done', 100);
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.error = err instanceof yt.FriendlyError ? err.message : 'Something went wrong while making the clips.';
    if (!(err instanceof yt.FriendlyError)) console.error(`[job ${job.id}]`, err);
    job.clips = [];
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    // Keep only the finished clips; the source video and caption files are large.
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!/^clip-\d+\.mp4$/.test(f)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
      }
    }
  }
}

// Remove finished jobs (and their clips) after KEEP_MINUTES.
setInterval(() => {
  const cutoff = Date.now() - cfg.keepMinutes * 60_000;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) {
      fs.rmSync(path.join(cfg.workDir, id), { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 10 * 60_000).unref();

module.exports = { submit, get, HttpError };
