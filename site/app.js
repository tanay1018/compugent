/**
 * Evidence explorer.
 *
 * Reads the same run logs the tool writes. No content is authored here: if a
 * run is re-recorded, this renders whatever actually happened, including the
 * parts that did not go well.
 */
const $ = (id) => document.getElementById(id);

/** Which hue an event gets. Actor on chrome, status on data — per DESIGN.md. */
function toneOf(e) {
  if (e.kind.startsWith('act.')) return 'agent';
  if (/fail|timeout|blocked|error/.test(e.kind)) return 'bad';
  if (/paused|escalat|warn/.test(e.kind)) return 'warn';
  if (/finish|success|checkpoint/.test(e.kind)) return 'ok';
  return '';
}

/** A one-line label for the step list. */
function summarise(e) {
  const d = e.detail || {};
  if (d.target) return d.target;
  if (d.goal) return d.goal;
  if (e.kind === 'observe') return `${d.nodes} nodes · ${d.location || ''}`;
  if (e.kind === 'model.step') return `in ${d.in} · out ${d.out}`;
  if (d.summary) return d.summary;
  if (d.message) return d.message;
  return '';
}

let runs = [];
let current = 0;
let step = 0;

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  runs.forEach((r, i) => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === current));
    b.textContent = r.title;
    b.onclick = () => { current = i; step = 0; renderAll(); };
    tabs.appendChild(b);
  });
}

function renderRun() {
  const r = runs[current];
  $('goal').textContent = r.goal;
  const stats = $('stats');
  stats.textContent = '';
  const bits = [
    ['outcome', r.outcome],
    ['steps', String(r.events.filter((e) => e.kind.startsWith('act.')).length)],
    ['tokens', `${r.tokens.in.toLocaleString()} in / ${r.tokens.out.toLocaleString()} out`],
    ['elapsed', `${(r.ms / 1000).toFixed(1)}s`],
  ];
  for (const [k, v] of bits) {
    const s = document.createElement('span');
    s.textContent = `${k} ${v}`;
    stats.appendChild(s);
  }

  const list = $('steps');
  list.textContent = '';
  r.events.forEach((e, i) => {
    const b = document.createElement('button');
    b.className = 'step';
    b.type = 'button';
    b.setAttribute('aria-current', String(i === step));

    const k = document.createElement('span');
    k.className = 'k ' + toneOf(e);
    k.textContent = `${String(e.seq).padStart(2, '0')}  ${e.kind}`;

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = summarise(e);

    b.appendChild(k); b.appendChild(t);
    b.onclick = () => { step = i; renderAll(); };
    list.appendChild(b);
  });
}

function renderPane() {
  const e = runs[current].events[step];
  const pane = $('pane');
  pane.textContent = '';
  if (!e) return;

  const d = e.detail || {};

  if (d.why) {
    const w = document.createElement('div');
    w.className = 'why';
    const b = document.createElement('b');
    b.textContent = 'why the model did this';
    const p = document.createElement('span');
    p.textContent = d.why;
    w.appendChild(b); w.appendChild(p);
    pane.appendChild(w);
  }

  if (d.target) {
    const t = document.createElement('p');
    t.className = 'target';
    t.textContent = d.target;
    pane.appendChild(t);
  }

  if (d.as !== undefined || d.observedValue !== undefined) {
    const t = document.createElement('p');
    t.className = 'target ok';
    t.textContent = `${d.as ?? 'value'} = ${JSON.stringify(d.observedValue ?? d.value ?? '')}`;
    pane.appendChild(t);
  }

  // The screenshot for a step that has none is the last one taken before it:
  // the screen the model was looking at when it chose.
  let shot = e.screenshot;
  if (!shot) {
    for (let i = step; i >= 0; i--) {
      if (runs[current].events[i].screenshot) { shot = runs[current].events[i].screenshot; break; }
    }
  }
  if (shot) {
    const img = document.createElement('img');
    img.src = `data/${shot}`;
    img.alt = `screen at step ${e.seq}`;
    img.loading = 'lazy';
    pane.appendChild(img);
  }

  // Anything with no screenshot and no reasoning still has detail worth
  // reading -- the goal a run opened with, a token count, a refusal message.
  // A raw JSON dump is not that, so the fields are laid out as a small list.
  if (!pane.childNodes.length) {
    const dl = document.createElement('dl');
    dl.className = 'kv';
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || v === '') continue;
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
      dl.appendChild(dt); dl.appendChild(dd);
    }
    pane.appendChild(dl.children.length ? dl
      : Object.assign(document.createElement('p'), { className: 'empty', textContent: 'no detail recorded' }));
  }
}

function renderAll() { renderTabs(); renderRun(); renderPane(); }

fetch('data/runs.json')
  .then((r) => r.json())
  .then((data) => {
    runs = data;
    if (!runs.length) { $('explorer').remove(); return; }
    renderAll();
  })
  .catch(() => { $('explorer').remove(); });

// Arrow keys step through a run once the explorer has focus in view.
document.addEventListener('keydown', (ev) => {
  if (!runs.length) return;
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  const box = $('explorer').getBoundingClientRect();
  if (box.bottom < 0 || box.top > innerHeight) return;
  ev.preventDefault();
  const n = runs[current].events.length;
  step = (step + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
  renderAll();
  document.querySelector('.step[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
});
