// Offline tests: no network, no YouTube. The ffmpeg test is skipped if ffmpeg is missing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cfg = require('../lib/config');
const { parseVideoId } = require('../lib/youtube');
const { parseVtt } = require('../lib/vtt');
const { pickHighlights, evenlySpaced } = require('../lib/highlights');
const { cutClip, buildSrt } = require('../lib/clipper');

let passed = 0;
let skipped = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('Cutroom tests');

  await test('parseVideoId accepts YouTube links and rejects everything else', () => {
    const id = 'dQw4w9WgXcQ';
    assert.strictEqual(parseVideoId(`https://www.youtube.com/watch?v=${id}&t=10s`), id);
    assert.strictEqual(parseVideoId(`https://youtu.be/${id}?si=abc`), id);
    assert.strictEqual(parseVideoId(`https://m.youtube.com/shorts/${id}`), id);
    assert.strictEqual(parseVideoId(`https://www.youtube.com/embed/${id}`), id);
    assert.strictEqual(parseVideoId('https://vimeo.com/12345'), null);
    assert.strictEqual(parseVideoId('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
    assert.strictEqual(parseVideoId('https://www.youtube.com/watch?v=short'), null);
    assert.strictEqual(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ;rm -rf'), null);
    assert.strictEqual(parseVideoId('javascript:alert(1)'), null);
    assert.strictEqual(parseVideoId(''), null);
  });

  await test('parseVtt collapses YouTube rolling auto-captions', () => {
    const vtt = [
      'WEBVTT', 'Kind: captions', 'Language: en', '',
      '00:00:00.480 --> 00:00:03.040 align:start position:0%', ' ',
      'hello everyone<00:00:01.000><c> welcome</c><00:00:01.500><c> back</c>', '',
      '00:00:03.040 --> 00:00:03.050 align:start position:0%',
      'hello everyone welcome back', ' ', '',
      '00:00:03.050 --> 00:00:05.200 align:start position:0%',
      'hello everyone welcome back',
      'today we talk<00:00:04.000><c> about</c><00:00:04.400><c> pricing</c>', '',
      '00:00:05.200 --> 00:00:06.000 align:start position:0%', '[Music]', '',
    ].join('\n');
    const cues = parseVtt(vtt);
    assert.deepStrictEqual(cues.map((c) => c.text), ['hello everyone welcome back', 'today we talk about pricing']);
    assert.ok(cues[0].end <= cues[1].start + 0.001, 'gap between cues is closed');
  });

  await test('parseVtt reads clean manual captions with hour stamps', () => {
    const vtt = 'WEBVTT\n\n1\n01:02:03.500 --> 01:02:05.000\nFirst line.\n\n2\n01:02:05.000 --> 01:02:07.250\nSecond line.\n';
    const cues = parseVtt(vtt);
    assert.strictEqual(cues.length, 2);
    assert.strictEqual(cues[0].start, 3723.5);
  });

  // Synthetic 20-minute transcript with a few deliberately strong moments.
  const filler = 'so this is just some regular talking about nothing in particular really';
  const hooky = 'Why is this the biggest mistake? Nobody tells you the truth, and it cost me 5000 dollars in 3 months. Here is the simple reason, stop doing it.';
  const cues = [];
  for (let t = 0; t < 1200; t += 4) {
    const strong = [300, 520, 700, 900, 1100].some((s) => t >= s && t < s + 44);
    cues.push({ start: t, end: t + 3.9, text: strong ? hooky : filler });
  }
  const opts = { count: 5, min: 25, max: 55 };

  await test('pickHighlights returns 5 separate in-range moments on a long transcript', () => {
    const r = pickHighlights(cues, 1200, opts);
    assert.strictEqual(r.method, 'transcript');
    assert.strictEqual(r.picks.length, 5);
    const sorted = [...r.picks].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      assert.ok(sorted[i].duration >= 24 && sorted[i].duration <= 57, `duration ${sorted[i].duration}`);
      assert.ok(sorted[i].start >= 0 && sorted[i].end <= 1200);
      if (i) assert.ok(sorted[i].start >= sorted[i - 1].end, 'no overlap');
    }
    assert.ok(r.pool.length >= 5);
  });

  await test('pickHighlights prefers the strong moments over filler', () => {
    const r = pickHighlights(cues, 1200, opts);
    const strongStarts = [300, 520, 700, 900, 1100];
    const hits = r.picks.filter((p) => strongStarts.some((s) => p.start < s + 44 && p.end > s)).length;
    assert.ok(hits >= 4, `only ${hits} of 5 picks landed on a strong moment`);
  });

  await test('pickHighlights backfills shorter clips on a short video', () => {
    const short = [];
    for (let t = 0; t < 100; t += 4) short.push({ start: t, end: t + 3.9, text: filler });
    const r = pickHighlights(short, 100, opts);
    assert.strictEqual(r.method, 'transcript');
    assert.ok(r.picks.length >= 3, `only ${r.picks.length} picks`);
    const sorted = [...r.picks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end, 'no overlap');
    assert.ok(sorted.every((p) => p.end <= 100));
  });

  await test('evenlySpaced handles short and normal videos', () => {
    const a = evenlySpaced(600, opts);
    assert.strictEqual(a.length, 5);
    assert.ok(a.every((p) => p.end <= 600 && p.start >= 0));
    const b = evenlySpaced(45, opts);
    assert.ok(b.length >= 1 && b.every((p) => p.end <= 45.001 && p.duration > 5));
    assert.strictEqual(pickHighlights([], 600, opts).method, 'even');
  });

  await test('buildSrt re-times captions to the clip', () => {
    const srt = buildSrt([{ start: 100, end: 104, text: 'hello' }, { start: 200, end: 204, text: 'later' }], 98, 10);
    assert.ok(srt.includes('00:00:02,000 --> 00:00:06,000'));
    assert.ok(!srt.includes('later'));
  });

  const ff = spawnSync(cfg.ffmpegPath, ['-version']);
  if (ff.status !== 0) {
    skipped++;
    console.log('  skip ffmpeg end-to-end test (ffmpeg not found)');
  } else {
    await test('cutClip makes a 720x1280 vertical clip with burned-in captions', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutroom-'));
      const src = path.join(dir, 'source.mp4');
      const gen = spawnSync(cfg.ffmpegPath, [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=60',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src,
      ]);
      assert.strictEqual(gen.status, 0, String(gen.stderr));

      const caps = [{ start: 10, end: 14, text: 'This is a caption test' }, { start: 14, end: 18, text: 'Second caption line' }];
      const out = await cutClip({ input: src, dir, n: 1, start: 10, duration: 20, cues: caps, format: 'vertical' });
      assert.ok(fs.existsSync(path.join(dir, out.file)));
      console.log(`       captions burned in: ${out.captions}`);

      const probe = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json', path.join(dir, out.file),
      ]);
      const info = JSON.parse(probe.stdout);
      assert.strictEqual(info.streams[0].width, 720);
      assert.strictEqual(info.streams[0].height, 1280);
      assert.ok(Math.abs(Number(info.format.duration) - 20) < 0.6, `duration ${info.format.duration}`);

      const sq = await cutClip({ input: src, dir, n: 2, start: 0, duration: 8, cues: [], format: 'square' });
      const probe2 = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path.join(dir, sq.file)]);
      const s2 = JSON.parse(probe2.stdout).streams[0];
      assert.deepStrictEqual([s2.width, s2.height], [720, 720]);
      assert.strictEqual(sq.captions, false);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  console.log(`\n${passed} passed${skipped ? `, ${skipped} skipped` : ''}${process.exitCode ? ', SOME FAILED' : ''}`);
})();
