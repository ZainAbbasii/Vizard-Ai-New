// Picks short moments from a captioned video using plain heuristics (no AI needed).
// Heuristics are crude: they reward fast, dense speech, hook words, questions,
// numbers, and a strong opening line, and penalize filler words.

const HOOK_WORDS =
  /\b(secret|mistake|never|always|biggest|truth|actually|honestly|important|problem|worst|best|free|money|stop|why|how|nobody|everyone|crazy|insane|wrong|lesson|simple|changed|realized|surprising|reason|trick|fail|win)\b/gi;
const FILLERS = /\b(um+|uh+|erm|you know|i mean|kind of|sort of)\b/gi;
const OPENING =
  /^(why|how|what|here'?s|never|stop|if you|the (biggest|best|worst|first|only)|most people|you (need|should|have to|can)|i (never|used to|learned|realized))/i;

// Merge caption cues into speech chunks that break at pauses or sentence ends.
function buildChunks(cues) {
  const chunks = [];
  let cur = null;
  for (const cue of cues) {
    const gap = cur ? cue.start - cur.end : Infinity;
    if (cur && gap < 0.8 && cur.end - cur.start < 12 && !/[.?!]$/.test(cur.text)) {
      cur.end = Math.max(cur.end, cue.end);
      cur.text += ` ${cue.text}`;
    } else {
      if (cur) chunks.push(cur);
      cur = { start: cue.start, end: cue.end, text: cue.text };
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function scoreWindow(chunks, i, j) {
  const start = chunks[i].start;
  const end = chunks[j].end;
  const dur = end - start;
  const text = chunks.slice(i, j + 1).map((c) => c.text).join(' ');
  const words = (text.match(/\S+/g) || []).length;
  const density = Math.min(words / dur / 3, 1);
  const hooks = (text.match(HOOK_WORDS) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  const numbers = (text.match(/\b\d[\d,.]*\b/g) || []).length;
  const fillers = (text.match(FILLERS) || []).length;
  const fillerRatio = fillers / Math.max(words, 1);
  const opening = OPENING.test(chunks[i].text) || chunks[i].text.includes('?');
  const endsClean = /[.?!]$/.test(chunks[j].text);

  const raw =
    3 * density +
    Math.min(hooks, 6) * 0.35 +
    Math.min(questions, 3) * 0.4 +
    Math.min(numbers, 4) * 0.2 -
    fillerRatio * 8 +
    (opening ? 1.2 : 0) +
    (endsClean ? 0.3 : 0);

  const reasons = [];
  if (opening) reasons.push('opens with a hook');
  if (questions) reasons.push('poses a question');
  if (hooks >= 3) reasons.push('uses strong hook words');
  if (numbers >= 2) reasons.push('includes specific numbers');
  if (density > 0.75) reasons.push('fast, dense delivery');
  if (fillerRatio < 0.01) reasons.push('few filler words');
  if (!reasons.length) reasons.push('steady, clear speech');

  return { start, end, duration: dur, text, raw, reasons };
}

function findCandidates(chunks, min, max) {
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    for (let j = i; j < chunks.length; j++) {
      const dur = chunks[j].end - chunks[i].start;
      if (dur > max) break;
      if (dur >= min) out.push(scoreWindow(chunks, i, j));
    }
  }
  return out;
}

// Best-first, skipping anything that overlaps (or nearly touches) a pick already made.
// `existing` picks are kept and counted toward `count`; the full list is returned.
function selectTop(candidates, count, pad = 3, existing = []) {
  const sorted = [...candidates].sort((a, b) => b.raw - a.raw);
  const picked = [...existing];
  for (const c of sorted) {
    if (picked.length >= count) break;
    if (picked.every((p) => c.end + pad <= p.start || c.start >= p.end + pad)) picked.push(c);
  }
  return picked;
}

function makeTitle(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const head = words.slice(0, 10).join(' ').replace(/[,;:\-–]+$/, '');
  const title = head.charAt(0).toUpperCase() + head.slice(1);
  return words.length > 10 ? `${title}…` : title.replace(/[.]+$/, '');
}

const toScore = (raw) => Math.max(1, Math.min(10, Math.round((raw / 7) * 10)));

function finish(c, id, duration) {
  const start = Math.max(0, c.start - 0.3);
  const end = Math.min(duration || Infinity, c.end + 0.4);
  const reason = c.reasons[0].charAt(0).toUpperCase() + c.reasons.join(', ').slice(1) + '.';
  return {
    id,
    start,
    end,
    duration: end - start,
    raw: c.raw,
    score: toScore(c.raw),
    title: makeTitle(c.text),
    reason,
    text: c.text,
  };
}

// The small padding added around each clip can make back-to-back picks overlap slightly.
function separate(picks) {
  const sorted = [...picks].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end > sorted[i + 1].start) sorted[i].end = sorted[i + 1].start;
  }
  for (const p of sorted) p.duration = p.end - p.start;
  return sorted;
}

// Fallback when there are no usable captions: spread clips across the video.
function evenlySpaced(duration, { count, min, max }) {
  const wanted = Math.min(40, max);
  let n = Math.max(1, Math.min(count, Math.floor(duration / Math.max(wanted, 10))));
  const seg = duration / n;
  const len = Math.min(Math.max(min, wanted), seg, duration);
  if (len < 5) n = 1;
  return Array.from({ length: n }, (_, k) => {
    const start = k * seg + (seg - len) / 2;
    return {
      id: k,
      start,
      end: start + len,
      duration: len,
      raw: 0,
      score: null,
      title: `Moment ${k + 1}`,
      reason: 'No captions were available, so this was picked by position rather than content.',
      text: '',
    };
  });
}

function pickHighlights(cues, duration, opts) {
  const { count, min, max } = opts;
  if (!cues || cues.length < 5) {
    return { method: 'even', picks: evenlySpaced(duration, opts), pool: [] };
  }
  const chunks = buildChunks(cues);
  const candidates = findCandidates(chunks, min, max);
  if (!candidates.length) return { method: 'even', picks: evenlySpaced(duration, opts), pool: [] };
  // First pass keeps a buffer between picks so clips feel different from each other.
  let chosen = selectTop(candidates, count, 6);
  if (chosen.length < count) {
    // Short video or sparse speech: backfill the remaining slots with shorter moments
    // that may sit right next to an existing pick (but never overlap one).
    const relaxed = findCandidates(chunks, Math.min(12, min), max);
    chosen = selectTop(relaxed, count, 0, chosen);
  }
  const picks = separate(chosen.map((c, i) => finish(c, i, duration)));
  const pool = selectTop(candidates, 12).map((c, i) => finish(c, i, duration));
  return { method: 'transcript', picks, pool };
}

module.exports = { buildChunks, scoreWindow, findCandidates, selectTop, evenlySpaced, pickHighlights };
