// Boots the real server with a fake yt-dlp and drives the whole job flow over HTTP.
// Run: node test/e2e.js  (needs ffmpeg on PATH)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-e2e-'));
// Copy the stand-in somewhere executable (some mounts disallow running files in place).
const fake = path.join(work, 'fake-ytdlp.js');
fs.copyFileSync(path.join(__dirname, 'fake-ytdlp.js'), fake);
fs.chmodSync(fake, 0o755);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), YTDLP_PATH: fake, WORK_DIR: path.join(work, 'jobs'), JOBS_PER_HOUR: '20', ACCESS_CODE: 'letmein', ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (body) =>
  fetch(`${BASE}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function main() {
  for (let i = 0; i < 40; i++) {
    try {
      const h = await (await fetch(`${BASE}/api/health`)).json();
      if (h.ok) break;
    } catch {}
    await sleep(250);
    if (i === 39) throw new Error(`server never became healthy\n${log}`);
  }
  console.log('  ok   server healthy with fake yt-dlp + system ffmpeg');

  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  assert.strictEqual(cfg.accessCodeRequired, true);

  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  let r = await post({ url, confirmRights: true, accessCode: 'wrong' });
  assert.strictEqual(r.status, 401);
  r = await post({ url, confirmRights: false, accessCode: 'letmein' });
  assert.strictEqual(r.status, 400);
  r = await post({ url: 'https://example.com/x', confirmRights: true, accessCode: 'letmein' });
  assert.strictEqual(r.status, 400);
  console.log('  ok   rejects wrong code, missing rights confirmation, non-YouTube links');

  r = await post({ url, confirmRights: true, accessCode: 'letmein', format: 'vertical' });
  assert.strictEqual(r.status, 202);
  const { id } = await r.json();

  let job;
  const started = Date.now();
  for (;;) {
    job = await (await fetch(`${BASE}/api/jobs/${id}`)).json();
    if (job.status === 'done' || job.status === 'error') break;
    if (Date.now() - started > 150_000) throw new Error(`timed out at stage "${job.stage}"`);
    await sleep(1000);
  }
  assert.strictEqual(job.status, 'done', `job failed: ${job.error}\n${log}`);
  assert.strictEqual(job.clips.length, 5);
  assert.strictEqual(job.method, 'transcript');
  console.log(`  ok   job finished in ${((Date.now() - started) / 1000).toFixed(1)}s with 5 clips (method: ${job.method})`);

  for (const c of job.clips) {
    const res = await fetch(`${BASE}${c.url}`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /video\/mp4/);
    const size = (await res.arrayBuffer()).byteLength;
    assert.ok(size > 10_000, `clip ${c.n} too small (${size} bytes)`);
    assert.ok(c.duration >= 24 && c.duration <= 57);
    assert.ok(c.sourceUrl.includes('&t='));
  }
  console.log('  ok   all 5 clip files download as video/mp4');
  console.log(`       titles: ${job.clips.map((c) => `"${c.title}" (${c.score})`).join(', ')}`);
  console.log(`       captions burned in: ${job.clips.every((c) => c.captions)}`);

  const leftovers = fs.readdirSync(path.join(work, 'jobs', id));
  assert.ok(leftovers.every((f) => /^clip-\d+\.mp4$/.test(f)), `source/caption files not cleaned up: ${leftovers}`);
  console.log('  ok   source video and caption files were deleted after the job');

  assert.strictEqual((await fetch(`${BASE}/api/jobs/not-a-real-id`)).status, 404);
  assert.strictEqual((await fetch(`${BASE}/clips/../server.js`)).status, 404);
  console.log('  ok   unknown job ids and path traversal return 404');
}

main()
  .then(() => console.log('\nE2E passed'))
  .catch((err) => {
    console.error(`\nE2E FAILED: ${err.stack || err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  });
