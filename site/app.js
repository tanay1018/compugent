/*
 * Two interactive pieces, both driven by real data from the repository:
 *
 *   1. an inspector over the approved capability artifact, which shows what
 *      actually happens to each descriptor when you change the input
 *   2. a player over recorded runs
 *
 * Nothing is authored here. If an artifact is recompiled or a run re-recorded,
 * this renders whatever is now true, including the parts that are unflattering.
 */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ---------------------------------------------------------------- inspector */

const PRESETS = ['Bank of America', 'Microsoft', 'Toyota', 'Nintendo'];
let artifact = null;

/** Substitute {{param}} the way replay does. */
const interp = (text, value) =>
  typeof text === 'string' ? text.split('{{companyName}}').join(value) : text;

/**
 * Resolution is tiered: try the accessible name, then the anchor relation.
 * Rendering both tiers is the point — on step 3 the recorded NAME is a string
 * Wikipedia composed for one company, so it stops matching the moment you
 * change the input, and the anchor is what carries the capability across.
 */
function tiersFor(step, value, recorded) {
  const t = step.target;
  const out = [];
  const isRecorded = value.trim().toLowerCase() === recorded.trim().toLowerCase();

  if (t.name) {
    const filled = interp(t.name, value);
    const parameterised = t.name.includes('{{');
    // A name with no placeholder was recorded verbatim. If it also contains the
    // recorded value, it is text the surface composed and cannot generalise.
    const composed = !parameterised && t.name.includes(recorded);
    const hit = parameterised || !composed || isRecorded;
    out.push({
      label: 'name', value: filled, parameterised,
      verdict: hit ? 'match' : 'no match', tone: hit ? 'v-ok' : 'v-miss', dead: !hit,
    });
  }
  if (t.anchor) {
    const filled = interp(t.anchor.text, value);
    out.push({
      label: t.anchor.relation, value: filled,
      parameterised: t.anchor.text.includes('{{'),
      verdict: 'match', tone: 'v-ok', dead: false,
    });
  }
  return out;
}

function renderInspector() {
  if (!artifact) return;
  const recorded = artifact.inputs[0]?.example ?? '';
  const value = $('param').value || recorded;

  for (const b of $('presets').children) {
    b.setAttribute('aria-pressed', String(b.textContent === value));
  }

  const host = $('steps');
  host.textContent = '';
  let fellThrough = false;

  artifact.steps.forEach((step, i) => {
    const card = el('div', 'stepcard');
    const head = el('div', 'stepcard-head');
    head.append(
      el('span', 'sid', `s${i + 1}`),
      el('span', 'skind', step.kind),
      el('span', 'srole', step.target.role),
    );
    if (step.value?.from === 'param') {
      const v = el('span', 'srole');
      v.append(document.createTextNode('← '));
      v.append(el('span', 'fill', value));
      head.append(v);
    }
    card.append(head);

    const tiers = tiersFor(step, value, recorded);
    const box = el('div', 'tiers');
    for (const t of tiers) {
      const row = el('div', 'tier' + (t.dead ? ' is-dead' : ''));
      row.append(el('span', 'tier-name', t.label));

      const val = el('span', 'tier-val');
      if (t.parameterised) {
        // Show the substitution rather than just its result.
        const parts = t.value.split(value);
        parts.forEach((p, k) => {
          if (p) val.append(document.createTextNode(`"${k === 0 ? '' : ''}${p}`.replace(/^"/, k === 0 ? '"' : '')));
          if (k < parts.length - 1) val.append(el('span', 'fill', value));
        });
        if (!val.childNodes.length) val.append(el('span', 'fill', value));
      } else {
        val.textContent = `"${t.value}"`;
      }
      row.append(val);
      row.append(el('span', `verdict ${t.tone}`, t.verdict));
      box.append(row);
    }
    card.append(box);

    const winner = tiers.find((t) => !t.dead);
    const res = el('div', 'resolved');
    res.append(document.createTextNode('resolves through '));
    res.append(el('b', null, winner ? winner.label : 'nothing'));
    if (tiers.some((t) => t.dead)) {
      fellThrough = true;
      res.append(document.createTextNode(' — the name no longer matches, so resolution falls through'));
    }
    card.append(res);
    host.append(card);
  });

  $('artifact-note').textContent = fellThrough
    ? `Step 3’s name is text Wikipedia composed for one company, so it stops matching when you change the input. The step still resolves through its anchor, "${value}". This is why targeting falls back from name to anchor.`
    : 'Every descriptor matches on its recorded value. Try another company: step 3’s name is a string Wikipedia composed, and it will stop matching.';
}

/* ------------------------------------------------------------------- player */

let runs = [];
let cur = 0, at = 0, timer = null;

const toneOf = (e) =>
  e.kind.startsWith('act.') ? 'agent'
  : /fail|timeout|blocked|error/.test(e.kind) ? 'bad'
  : /paus|escalat|serial/.test(e.kind) ? 'warn'
  : /finish|success|checkpoint/.test(e.kind) ? 'ok' : '';

function summarise(e) {
  const d = e.detail || {};
  if (d.target) return d.target;
  if (d.goal) return d.goal;
  if (e.kind === 'observe') return `${d.nodes} nodes · ${d.location || ''}`;
  if (e.kind === 'model.step') return `in ${d.in} · out ${d.out}`;
  return d.summary || d.message || d.note || '';
}

function renderTabs() {
  const host = $('tabs');
  host.textContent = '';
  runs.forEach((r, i) => {
    const b = el('button', 'tab', r.title);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === cur));
    b.onclick = () => { stop(); cur = i; at = 0; renderAll(); };
    host.append(b);
  });
}

function renderRun() {
  const r = runs[cur];
  $('goal').textContent = r.goal;

  const stats = $('stats');
  stats.textContent = '';
  const acts = r.events.filter((e) => e.kind.startsWith('act.')).length;
  for (const [k, v] of [
    ['outcome', r.outcome], ['actions', String(acts)],
    ['tokens', `${r.tokens.in.toLocaleString()} in / ${r.tokens.out.toLocaleString()} out`],
    ['elapsed', `${(r.ms / 1000).toFixed(1)}s`],
  ]) {
    const s = el('span');
    s.append(document.createTextNode(`${k} `), el('b', null, v));
    stats.append(s);
  }

  const track = $('track');
  track.textContent = '';
  r.events.forEach((e, i) => {
    const b = el('button', 'ev');
    b.type = 'button';
    b.setAttribute('aria-current', String(i === at));
    b.append(
      el('span', `k ${toneOf(e)}`, `${String(e.seq).padStart(2, '0')}  ${e.kind}`),
      el('span', 't', summarise(e)),
    );
    b.onclick = () => { stop(); at = i; renderAll(); };
    track.append(b);
  });

  const scrub = $('scrub');
  scrub.max = String(r.events.length - 1);
  scrub.value = String(at);
  $('counter').textContent = `${at + 1} / ${r.events.length}`;
}

function renderView() {
  const e = runs[cur].events[at];
  const view = $('view');
  view.textContent = '';
  if (!e) return;
  const d = e.detail || {};

  if (d.why) {
    const w = el('div', 'why');
    w.append(el('b', null, 'why the model did this'), el('span', null, d.why));
    view.append(w);
  }
  if (d.note) {
    const w = el('div', 'why');
    w.append(el('b', null, 'what the system did about it'), el('span', null, d.note));
    view.append(w);
  }
  if (d.target) view.append(el('p', 'target', d.target));
  if (d.as !== undefined) {
    view.append(el('p', 'target ok', `${d.as} = ${JSON.stringify(d.observedValue ?? '')}`));
  }

  // A step with no screenshot of its own shows the last one taken before it:
  // the screen the model was actually looking at when it chose.
  let shot = e.screenshot;
  for (let i = at; i >= 0 && !shot; i--) shot = runs[cur].events[i].screenshot;
  if (shot) {
    const img = el('img');
    img.src = `data/${shot}`;
    img.alt = `the screen at step ${e.seq}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    view.append(img);
  } else if (!view.childNodes.length) {
    const dl = el('dl', 'kv');
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || v === '') continue;
      dl.append(el('dt', null, k), el('dd', null, typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    view.append(dl.children.length ? dl : el('p', 'note', 'no detail recorded'));
  }
}

function renderAll() { renderTabs(); renderRun(); renderView(); }

/* transport. Autoplay is user-initiated and cancelled by any interaction. */
function stop() {
  if (!timer) return;
  clearInterval(timer); timer = null;
  $('play').setAttribute('aria-pressed', 'false');
  $('play').textContent = '▶  Play';
}
function play() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('play').setAttribute('aria-pressed', 'true');
  $('play').textContent = '❚❚  Pause';
  timer = setInterval(() => {
    if (at >= runs[cur].events.length - 1) { stop(); return; }
    at += 1;
    renderAll();
    document.querySelector('.ev[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, reduced ? 2400 : 1400);
}

/* -------------------------------------------------------------------- boot */

Promise.all([
  fetch('data/runs.json').then((r) => r.json()).catch(() => []),
  fetch('data/artifacts.json').then((r) => r.json()).catch(() => []),
]).then(([r, a]) => {
  artifact = a.find((x) => x.id.includes('Wikipedia') || x.id.includes('Infobox')) || a[0] || null;

  if (artifact) {
    $('apv').textContent = `${artifact.approval} · v${artifact.version}`;
    const host = $('presets');
    for (const p of PRESETS) {
      const b = el('button', 'chip', p);
      b.type = 'button';
      b.onclick = () => { $('param').value = p; renderInspector(); };
      host.append(b);
    }
    $('param').addEventListener('input', renderInspector);
    renderInspector();
  } else {
    $('artifact')?.remove();
  }

  runs = r;
  if (!runs.length) { $('think')?.remove(); return; }
  $('play').onclick = () => (timer ? stop() : play());
  $('scrub').addEventListener('input', (ev) => { stop(); at = Number(ev.target.value); renderAll(); });
  renderAll();
});

document.addEventListener('keydown', (ev) => {
  if (!runs.length) return;
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) return;
  const box = $('think').getBoundingClientRect();
  if (box.bottom < 0 || box.top > innerHeight) return;
  ev.preventDefault();
  stop();
  const n = runs[cur].events.length;
  at = (at + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
  renderAll();
  document.querySelector('.ev[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
});


/* ------------------------------------------------------------- downloads */
/*
 * The download button reflects what is actually published rather than what we
 * hope is published: it asks GitHub for the latest release and points at the
 * real asset. With no release yet -- or with the API rate-limiting an
 * anonymous visitor -- it falls back to build-from-source instructions rather
 * than offering a link that 404s.
 */
const REPO = 'tanay1018/compugent';

function pickAsset(assets, platform) {
  const want = platform === 'mac' ? /\.(dmg|zip)$/i
             : platform === 'win' ? /\.exe$/i
             : /\.(AppImage|deb)$/i;
  return assets.find((a) => want.test(a.name));
}

const hostPlatform = () => {
  const p = navigator.userAgent;
  if (/Mac/i.test(p)) return 'mac';
  if (/Win/i.test(p)) return 'win';
  return 'linux';
};

fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((rel) => {
    const plat = hostPlatform();
    const asset = pickAsset(rel.assets || [], plat);
    const main = $('dl-main');
    if (!main) return;
    if (asset) {
      main.href = asset.browser_download_url;
      main.textContent = `Download ${rel.tag_name} for ${{ mac: 'macOS', win: 'Windows', linux: 'Linux' }[plat]}`;
      const size = el('span', 'note', ` ${(asset.size / 1048576).toFixed(0)} MB`);
      main.after(size);
    } else {
      main.href = rel.html_url;
      main.textContent = `Release ${rel.tag_name} on GitHub`;
    }
  })
  .catch(() => {
    const main = $('dl-main');
    if (!main) return;
    main.href = `https://github.com/${REPO}#running-it`;
    main.textContent = 'Build and run from source';
    const n = $('dl')?.parentElement?.querySelector('.note');
    if (n) n.textContent = 'No packaged build is published yet. See the repository to run it from source.';
  });
