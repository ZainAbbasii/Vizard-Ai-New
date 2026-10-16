// Runs the real job pipeline (queue, metadata, download, captions, highlight picking,
// ffmpeg cutting, cleanup) against a fake yt-dlp. Needs ffmpeg, but no npm packages.
// Run: node test/pipeline.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-pipe-'));
// Copy the stand-in somewhere executable (some mounts disallow running files in place).
const fake = path.join(work, 'fake-ytdlp.js');
fs.copyFileSync(path.join(__dirname, 'fake-ytdlp.js'), fake);
fs.chmodSync(fake, 0o755);
Object.assign(process.env, { YTDLP_PATH: fake, WORK_DIR: path.join(work, 'jobs'), JOBS_PER_HOUR: '20', ANTHROPIC_API_KEY: '' });

const jobs = require('../lib/jobs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assert.throws(() => jobs.submit({ url: 'https://example.com/x', format: 'vertical', ip: '1.1.1.1' }), /YouTube/);
  console.log('  ok   rejects non-YouTube links');

  const first = jobs.submit({ url: 'https://youtu.be/dQw4w9WgXcQ', format: 'vertical', ip: '1.1.1.1' });
  const second = jobs.submit({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'square', ip: '2.2.2.2' });
  await sleep(150); // let the queue pick up the first job
  const waiting = jobs.get(second.id);
  assert.strictEqual(waiting.status, 'queued');
  assert.strictEqual(waiting.position, 1);
  console.log('  ok   second job waits in the queue behind the first');

  const started = Date.now();
  let job;
  for (;;) {
    job = jobs.get(first.id);
    if (job.status === 'done' || job.status === 'error') break;
    if (Date.now() - started > 150_000) throw new Error(`timed out at "${job.stage}"`);
    await sleep(500);
  }
  assert.strictEqual(job.status, 'done', `job failed: ${job.error}`);
  assert.strictEqual(job.clips.length, 5);
  assert.strictEqual(job.method, 'transcript');
  console.log(`  ok   job 1 finished in ${((Date.now() - started) / 1000).toFixed(1)}s: 5 clips, method "${job.method}"`);

  const dir = path.join(work, 'jobs', first.id);
  const sorted = [...job.clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const file = path.join(dir, path.basename(c.url));
    assert.ok(fs.statSync(file).size > 10_000, `clip ${c.n} is too small`);
    assert.ok(c.duration >= 24 && c.duration <= 57, `clip ${c.n} duration ${c.duration}`);
    if (i) assert.ok(c.start >= sorted[i - 1].end, 'clips overlap');
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]);
    const s = JSON.parse(probe.stdout).streams[0];
    assert.deepStrictEqual([s.width, s.height], [720, 1280], `clip ${c.n} is ${s.width}x${s.height}`);
  }
  console.log('  ok   every clip is a real 720x1280 mp4 of 25-57 seconds, none overlapping');
  console.log(`       captions burned in: ${job.clips.every((c) => c.captions)}`);
  console.log(`       picks: ${job.clips.map((c) => `${Math.round(c.start)}s "${c.title.slice(0, 32)}" (score ${c.score})`).join(' | ')}`);

  const left = fs.readdirSync(dir);
  assert.ok(left.every((f) => /^clip-\d+\.mp4$/.test(f)), `not cleaned up: ${left}`);
  console.log('  ok   source video and caption files were deleted');

  for (;;) {
    job = jobs.get(second.id);
    if (job.status === 'done' || job.status === 'error') break;
    await sleep(500);
  }
  assert.strictEqual(job.status, 'done', `job 2 failed: ${job.error}`);
  const sq = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(work, 'jobs', second.id, path.basename(job.clips[0].url))]);
  const s2 = JSON.parse(sq.stdout).streams[0];
  assert.deepStrictEqual([s2.width, s2.height], [720, 720]);
  console.log('  ok   queued job 2 ran afterwards and honored the square format');

  assert.throws(() => {
    for (let i = 0; i < 25; i++) jobs.submit({ url: 'https://youtu.be/dQw4w9WgXcQ', format: 'vertical', ip: '9.9.9.9' });
  }, /Limit reached|busy/);
  console.log('  ok   per-visitor limit / busy protection kicks in');
}

main()
  .then(() => console.log('\nPipeline test passed'))
  .catch((err) => {
    console.error(`\nPipeline test FAILED: ${err.stack || err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
    setTimeout(() => process.exit(), 200);
  });
