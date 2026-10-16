function toSeconds(stamp) {
  const m = String(stamp).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function cleanLine(line) {
  const text = line
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
  // Drop sound tags like [Music] and music-note lines.
  if (/^\[[^\]]*\]$/.test(text) || /^[♪\s]+$/.test(text)) return '';
  return text;
}

// Returns [{ start, end, text }] with each spoken line appearing once.
function parseVtt(source) {
  const lines = String(source).replace(/\r/g, '').split('\n');
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('-->')) continue;
    const [a, b] = lines[i].split('-->');
    const start = toSeconds(a);
    const end = toSeconds(b.trim().split(/\s+/)[0]);
    const body = [];
    // YouTube cues often contain a whitespace-only line before the text, so only a
    // truly empty line (or the next timing line) ends a cue.
    while (i + 1 < lines.length && lines[i + 1] !== '' && !lines[i + 1].includes('-->')) body.push(lines[++i]);
    if (start != null && end != null) raw.push({ start, end, lines: body.map(cleanLine).filter(Boolean) });
  }

  // YouTube auto-captions repeat the previous line in every cue. Keep only new lines.
  const cues = [];
  let previous = [];
  for (const cue of raw) {
    const fresh = cue.lines.filter((l) => !previous.includes(l));
    previous = cue.lines;
    const text = fresh.join(' ').trim();
    if (text) cues.push({ start: cue.start, end: cue.end, text });
  }

  // A line stays on screen until the next one arrives; close small gaps.
  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (gap >= 0 && gap < 1) cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.end > c.start);
}

module.exports = { parseVtt };
