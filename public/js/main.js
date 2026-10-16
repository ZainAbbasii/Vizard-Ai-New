(() => {
  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const RATIOS = { vertical: '9 / 16', square: '1 / 1', original: '16 / 9' };
  const STORE_KEY = 'cutroom-job';

  $('#year').textContent = new Date().getFullYear();

  const form = $('#try');
  const urlInput = $('#video-url');
  const runBtn = $('#run');
  const statusEl = $('#status');
  const configNote = $('#config-note');
  const progressBox = $('#progress');
  const bar = $('#bar');
  const stageText = $('#stage-text');
  const stage = $('#stage');
  const clipsEl = $('#clips');
  let busy = false;
  let ready = true;
  let clipCount = 5;

  const setStatus = (text, tone) => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone || '';
  };
  const setBusy = (state) => {
    busy = state;
    runBtn.disabled = state || !ready;
  };

  async function loadConfig() {
    try {
      const cfg = await (await fetch('/api/config')).json();
      clipCount = cfg.clipCount;
      runBtn.textContent = `Make ${cfg.clipCount} clips`;
      $('#code-field').hidden = !cfg.accessCodeRequired;
      $('#faq-limit').textContent = `This server accepts videos up to ${cfg.maxVideoMinutes} minutes long. Longer videos use more time and disk space.`;
      if (!cfg.ready) {
        ready = false;
        runBtn.disabled = true;
        configNote.textContent = `This server is missing ${cfg.missing.join(' and ')}, so it cannot make clips yet. The site owner can check /api/health.`;
        configNote.dataset.tone = 'warn';
      }
    } catch {
      configNote.textContent = 'Could not reach the server.';
      configNote.dataset.tone = 'error';
    }
  }

  function clipCard(clip, format) {
    const el = document.createElement('article');
    el.className = 'clip';
    el.style.setProperty('--ratio', RATIOS[format] || RATIOS.vertical);

    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.src = clip.url;

    const h = document.createElement('h3');
    h.textContent = clip.title;

    const meta = document.createElement('p');
    meta.className = 'meta';
    const score = clip.score ? ` · Score ${clip.score}/10` : '';
    meta.textContent = `${fmt(clip.start)} to ${fmt(clip.end)} of the source · ${Math.round(clip.duration)}s${score}${clip.captions ? ' · Captioned' : ''}`;

    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = clip.reason;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const dl = document.createElement('a');
    dl.className = 'btn btn--small';
    dl.href = clip.url;
    dl.download = `clip-${clip.n}.mp4`;
    dl.textContent = 'Download';
    const src = document.createElement('a');
    src.className = 'btn btn--small';
    src.href = clip.sourceUrl;
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = 'See in video';
    actions.append(dl, src);

    el.append(video, h, meta, why, actions);
    return el;
  }

  function showResults(job) {
    stage.hidden = false;
    $('#stage-title').textContent = job.video ? job.video.title : 'Your clips';
    const how = {
      'transcript+ai': 'Moments chosen from the captions and refined by AI.',
      transcript: 'Moments chosen from the captions by a scoring rule.',
      even: 'Moments spaced evenly through the video.',
    }[job.method];
    $('#stage-meta').textContent = `${job.clips.length} clips${job.video ? ` from a ${fmt(job.video.duration)} video` : ''}`;
    const notes = $('#notes');
    notes.replaceChildren(
      ...[how, ...job.notes].filter(Boolean).map((n) => {
        const li = document.createElement('li');
        li.textContent = n;
        return li;
      })
    );
    clipsEl.replaceChildren(...job.clips.map((c) => clipCard(c, job.format)));
  }

  async function poll(id) {
    setBusy(true);
    progressBox.hidden = false;
    sessionStorage.setItem(STORE_KEY, id);
    let misses = 0;
    for (;;) {
      let job;
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' });
        if (res.status === 404) {
          sessionStorage.removeItem(STORE_KEY);
          progressBox.hidden = true;
          setStatus('That job has expired. Clips are deleted after a couple of hours. Paste the link again.', 'error');
          break;
        }
        job = await res.json();
        misses = 0;
      } catch {
        if (++misses > 5) {
          progressBox.hidden = true;
          setStatus('Lost contact with the server. Reload the page to check on your clips.', 'error');
          break;
        }
        await sleep(3000);
        continue;
      }

      bar.value = job.percent;
      stageText.textContent = job.status === 'queued' ? `Waiting in line (position ${job.position})` : job.stage;

      if (job.status === 'done') {
        progressBox.hidden = true;
        sessionStorage.removeItem(STORE_KEY);
        showResults(job);
        setStatus(`Done. ${job.clips.length} clips are ready below. They are deleted from the server in a couple of hours.`);
        stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        break;
      }
      if (job.status === 'error') {
        progressBox.hidden = true;
        sessionStorage.removeItem(STORE_KEY);
        setStatus(job.error, 'error');
        break;
      }
      await sleep(2000);
    }
    setBusy(false);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !ready) return;
    const url = urlInput.value.trim();
    if (!url) {
      setStatus('Paste a YouTube link first.', 'error');
      urlInput.focus();
      return;
    }
    if (!$('#rights').checked) {
      setStatus('Confirm that you own this video or have permission to clip it.', 'error');
      $('#rights').focus();
      return;
    }
    stage.hidden = true;
    setStatus('');
    setBusy(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          format: $('#format').value,
          confirmRights: true,
          accessCode: $('#access-code').value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the job.');
      await poll(data.id);
    } catch (err) {
      setStatus(err.message, 'error');
      setBusy(false);
    }
  });

  loadConfig().then(() => {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved && ready) poll(saved);
  });
})();
