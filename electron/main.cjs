// Desktop shell for the automation runner.
//
// Starts the target app if the goal points at localhost, spawns a discovery
// run, waits for its operator console to come up, and shows it. The console is
// the same client a remote operator would use.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
let win = null;
let child = null;
let targetApp = null;

/**
 * How a runner script is invoked.
 *
 * From source: `npx tsx scripts/<name>.ts`.
 * Packaged: scripts are pre-bundled to ESM .mjs files (some use top-level
 * await) and run with Electron's own binary via ELECTRON_RUN_AS_NODE, so no
 * second Node runtime is shipped.
 */
const RUNNERS = path.join(ROOT, 'runners');
function runnerCommand(script, args) {
  if (!app.isPackaged) return { cmd: 'npx', argv: ['tsx', `scripts/${script}.ts`, ...args], env: {} };
  return {
    cmd: process.execPath,
    argv: [path.join(RUNNERS, `${script}.mjs`), ...args],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Settings (mainly the API key) live in the OS app-data directory, since a
 * packaged app has no .env. The key is passed to runners via the environment.
 */
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; }
}
function writeSettings(next) {
  const merged = { ...readSettings(), ...next };
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

/** Everything a runner needs that is not on this process's own environment. */
function runnerEnv() {
  const s = readSettings();
  const out = {};
  if (s.apiKey) out.AI_GATEWAY_API_KEY = s.apiKey;
  if (s.discoveryModel) out.DISCOVERY_MODEL = s.discoveryModel;
  if (s.compileModel) out.COMPILE_MODEL = s.compileModel;
  // Download browsers into userData so the app does not depend on `playwright install`.
  out.PLAYWRIGHT_BROWSERS_PATH = path.join(app.getPath('userData'), 'browsers');
  // Artifacts and evidence must be writable; inside an .app bundle they are not.
  out.DATA_DIR = app.isPackaged ? app.getPath('userData') : ROOT;
  return out;
}

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });

const portUp = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });

async function freePort(from = 8790) {
  for (let p = from; p < from + 40; p++) if (await portFree(p)) return p;
  throw new Error('no free port for the operator console');
}

async function waitFor(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portUp(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Kill the whole process group. Runs are spawned via `npx`, so signalling only
 * our pid would orphan the runner, its console port and its browser.
 * `detached: true` makes each child a group leader so a negative pid reaches
 * the tree.
 */
function killTree(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGKILL'); }
  catch { try { proc.kill('SIGKILL'); } catch {} }
}

function stopRun() {
  detachSession();
  if (child) { killTree(child); child = null; }
}

/** Give the OS a moment to release the listener before we probe for a port. */
function settle(ms = 350) {
  return new Promise((r) => setTimeout(r, ms));
}

/** The bundled target app, started on demand so a local goal just works. */
async function ensureTargetApp() {
  if (await portUp(8710)) return;
  // The target app is not included in packaged builds.
  if (app.isPackaged) {
    send('run:log', '· the bundled demo app ships only with the source checkout — point this at a real URL instead\n');
    return;
  }
  targetApp = spawn('npx', ['tsx', 'target-app/server.ts'], { cwd: ROOT, stdio: 'ignore', detached: true });
  await waitFor(8710, 15000);
}

/**
 * Seed the catalogue on first run with the bundled artifacts, so replay can be
 * tried without an API key. Only runs when the catalogue is empty, so user
 * artifacts are never overwritten.
 */
function seedArtifacts() {
  const dest = path.join(app.getPath('userData'), 'artifacts');
  const src = path.join(ROOT, 'seed-artifacts');
  if (!app.isPackaged || !fs.existsSync(src)) return;
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) return;
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const id of fs.readdirSync(src)) {
      fs.cpSync(path.join(src, id), path.join(dest, id), { recursive: true });
    }
  } catch { /* a failed seed is not worth blocking startup over */ }
}

/* ----------------------------------------------------------- settings ---- */

ipcMain.handle('settings:get', () => {
  const s = readSettings();
  // The renderer only gets a masked hint, never the key.
  return {
    hasKey: Boolean(s.apiKey),
    keyHint: s.apiKey ? `${s.apiKey.slice(0, 7)}…${s.apiKey.slice(-4)}` : '',
    discoveryModel: s.discoveryModel ?? 'deepseek/deepseek-v4-flash',
    compileModel: s.compileModel ?? 'anthropic/claude-sonnet-5',
    browserReady: fs.existsSync(path.join(app.getPath('userData'), 'browsers')),
    dataDir: app.getPath('userData'),
  };
});

ipcMain.handle('settings:set', (_e, next) => {
  const clean = {};
  if (typeof next.apiKey === 'string') clean.apiKey = next.apiKey.trim();
  if (typeof next.discoveryModel === 'string') clean.discoveryModel = next.discoveryModel.trim();
  if (typeof next.compileModel === 'string') clean.compileModel = next.compileModel.trim();
  writeSettings(clean);
  return { ok: true };
});

ipcMain.handle('settings:openDataDir', () => { shell.openPath(app.getPath('userData')); return { ok: true }; });

/**
 * Download Chromium into userData on first use. Progress is reported to the
 * window because the download is ~150MB.
 */
let installing = null;
function ensureBrowser() {
  if (installing) return installing;
  const dir = path.join(app.getPath('userData'), 'browsers');
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((d) => d.startsWith('chromium'))) {
    return Promise.resolve({ ok: true, alreadyInstalled: true });
  }
  const cli = path.join(ROOT, 'app.asar.unpacked', 'node_modules', 'playwright', 'cli.js');
  const entry = fs.existsSync(cli) ? cli : require.resolve('playwright/cli.js');

  installing = new Promise((resolve) => {
    send('run:log', '· downloading the browser this app drives (about 150 MB, once)\n');
    const p = spawn(process.execPath, [entry, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PLAYWRIGHT_BROWSERS_PATH: dir },
    });
    p.stdout.on('data', (d) => send('run:log', d.toString()));
    p.stderr.on('data', (d) => send('run:log', d.toString()));
    p.on('exit', (code) => {
      installing = null;
      send('run:log', code === 0 ? '· browser ready\n' : `· browser download failed (${code})\n`);
      resolve({ ok: code === 0 });
    });
  });
  return installing;
}

ipcMain.handle('setup:browser', () => ensureBrowser());

ipcMain.handle('run:start', async (_e, { url, task }) => {
  if (!readSettings().apiKey) {
    return { ok: false, error: 'Add an AI Gateway key in Settings first — discovery needs a model. Replaying a saved capability does not.' };
  }
  const browser = await ensureBrowser();
  if (!browser.ok) return { ok: false, error: 'The browser could not be downloaded. Check the log and your connection.' };
  stopRun();
  await settle();
  if (/localhost:8710|127\.0\.0\.1:8710/.test(url)) {
    send('run:log', '· starting the bundled MemberDesk target app\n');
    await ensureTargetApp();
  }

  const port = await freePort();
  const run = runnerCommand('watch', [task, '--url', url, '--keep-open']);
  child = spawn(run.cmd, run.argv, {
    cwd: ROOT,
    // Own process group, so stopRun() can reach the whole tree.
    detached: true,
    // Lets the runner exit if this app dies, instead of orphaning its browser.
    env: { ...process.env, ...runnerEnv(), ...run.env,
           CONSOLE_PORT: String(port), RUNNER_PARENT_PID: String(process.pid) },
  });

  child.stdout.on('data', (d) => pipeChildOutput(d.toString()));
  child.stderr.on('data', (d) => send('run:log', d.toString()));
  child.on('exit', (code) => { send('run:exit', { code }); child = null; });

  const ok = await waitFor(port);
  if (!ok) { stopRun(); return { ok: false, error: 'the run did not start — open the raw log for the reason' }; }
  attachSession(port);
  // The port is not returned to the renderer; all session traffic goes through main.
  return { ok: true };
});

/**
 * Session channel proxy. The renderer (file://) and the session channel
 * (http://localhost) are cross-origin. Rather than enabling CORS, which would
 * let any local page drive the session, requests are relayed through main.
 */
let sessionStream = null;

function attachSession(port) {
  detachSession();
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      // SSE frames are separated by a blank line.
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { send('session:event', JSON.parse(line.slice(6))); } catch {}
      }
    });
  });
  req.on('error', () => {});
  sessionStream = { req, port };
}

function detachSession() {
  if (!sessionStream) return;
  try { sessionStream.req.destroy(); } catch {}
  sessionStream = null;
}

function relay(path, body) {
  return new Promise((resolve) => {
    if (!sessionStream) return resolve({ ok: false });
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      { host: '127.0.0.1', port: sessionStream.port, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); res.on('end', () => resolve({ ok: true })); },
    );
    req.on('error', () => resolve({ ok: false }));
    req.end(payload);
  });
}

ipcMain.handle('session:control', (_e, body) => relay('/control', body));
ipcMain.handle('session:input', (_e, body) => relay('/input', body));

ipcMain.handle('run:stop', () => { stopRun(); detachSession(); return { ok: true }; });

/**
 * Machine-readable markers the runner prints on stdout (run directory, replay
 * plan), so the app does not have to parse formatted output.
 */
const MARKERS = {
  __RUN_DONE__: 'run:done',
  __PLAN__: 'replay:plan',
  __REPLAY_DONE__: 'replay:done',
};

function pipeChildOutput(text) {
  let prose = text;
  for (const [marker, channel] of Object.entries(MARKERS)) {
    for (const line of text.split('\n')) {
      if (!line.startsWith(marker)) continue;
      try { send(channel, JSON.parse(line.slice(marker.length))); } catch {}
    }
    prose = prose.replace(new RegExp('^' + marker + '.*$', 'gm'), '');
  }
  send('run:log', prose.replace(/\n{3,}/g, '\n\n'));
}

/**
 * Replay a capability visibly, using the same operator channel as a discovery
 * run, so the stage shows each step.
 */
ipcMain.handle('caps:runLive', async (_e, { id, inputs, url }) => {
  stopRun();
  await settle();
  if (/localhost:8710|127\.0\.0\.1:8710/.test(url || '')) await ensureTargetApp();

  const port = await freePort();
  const extra = [id, '--watch'];
  for (const [k, v] of Object.entries(inputs || {})) if (String(v).length) extra.push(`${k}=${v}`);
  if (url) extra.push('--url', url);
  const run = runnerCommand('replay', extra);

  child = spawn(run.cmd, run.argv, {
    cwd: ROOT, detached: true,
    env: { ...process.env, ...runnerEnv(), ...run.env,
           CONSOLE_PORT: String(port), RUNNER_PARENT_PID: String(process.pid) },
  });
  child.stdout.on('data', (d) => pipeChildOutput(d.toString()));
  child.stderr.on('data', (d) => send('run:log', d.toString()));
  child.on('exit', (code) => { send('run:exit', { code }); child = null; });

  const ok = await waitFor(port);
  if (!ok) { stopRun(); return { ok: false, error: 'the replay did not start — open the raw log' }; }
  attachSession(port);
  return { ok: true };
});

ipcMain.handle('caps:list', () => {
  // Read from where runs write (userData when packaged), not the app bundle.
  const root = path.join(runnerEnv().DATA_DIR, 'artifacts');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const versions = fs.readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    if (!versions.length) continue;

    // Show the version replay will actually load: the highest approved one.
    const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, `v${n}.json`), 'utf8'));
    let v = versions.at(-1);
    for (const n of versions) {
      try { if (read(n).approval === 'approved') v = n; } catch { /* skip unreadable */ }
    }
    try {
      const a = read(v);
      out.push({
        id: a.id, version: a.version, versions,
        supersededBy: versions.filter((n) => n > a.version),
        name: a.name, description: a.description,
        approval: a.approval, incompleteReason: a.incompleteReason,
        inputs: a.inputs, outputs: a.outputs,
        outcomes: (a.outcomes || []).map((o) => ({ name: o.name, classification: o.classification })),
        steps: a.steps.length, app: a.app,
      });
    } catch { /* a malformed artifact is not a reason to hide the rest */ }
  }
  return out;
});

/** Replay a capability (no model involved). */
ipcMain.handle('caps:run', async (_e, { id, inputs, url }) => {
  if (/localhost:8710|127\.0\.0\.1:8710/.test(url || '')) await ensureTargetApp();
  const extra = [id, '--json'];
  for (const [k, v] of Object.entries(inputs || {})) if (String(v).length) extra.push(`${k}=${v}`);
  if (url) extra.push('--url', url);
  const run = runnerCommand('replay', extra);

  return new Promise((resolve) => {
    const p = spawn(run.cmd, run.argv,
      { cwd: ROOT, env: { ...process.env, ...runnerEnv(), ...run.env }, detached: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); send('run:log', d.toString()); });
    p.stderr.on('data', (d) => { err += d.toString(); send('run:log', d.toString()); });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'));
      if (!line) return resolve({ ok: false, error: (err || out).trim().slice(-400) || 'replay produced no result' });
      try { resolve({ ok: true, result: JSON.parse(line.slice('__RESULT__'.length)) }); }
      catch (e) { resolve({ ok: false, error: 'could not parse the replay result' }); }
    });
  });
});

/** Turn the most recent successful discovery run into a capability. */
ipcMain.handle('caps:compile', async (_e, opts) => {
  // `--partial` saves a run that never finished as an `incomplete` artifact:
  // the steps that did work are kept, but it is not invocable.
  const extra = [];
  // Compile the run the user watched, not simply the newest.
  if (opts && opts.runDir) extra.push(opts.runDir);
  if (opts && opts.partial) extra.push('--partial');
  const run = runnerCommand('compile', extra);
  return new Promise((resolve) => {
    const p = spawn(run.cmd, run.argv,
      { cwd: ROOT, env: { ...process.env, ...runnerEnv(), ...run.env }, detached: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); send('run:log', d.toString()); });
    p.stderr.on('data', (d) => { out += d.toString(); send('run:log', d.toString()); });
    p.on('exit', (code) => {
      const saved = /saved: (\S+)/.exec(out);
      const id = /^(\S+) v\d+  \[/m.exec(out);
      if (code === 0 && saved) {
        return resolve({
          ok: true, path: saved[1], id: id ? id[1] : null,
          incomplete: /\[incomplete\]/.test(out),
        });
      }
      // Distinguish an unfinished run from a failure, so the UI can offer --partial.
      const partialAvailable = /allowPartial|--partial/.test(out);
      // Prefer our own one-line reason over whatever Node dumped after it.
      const clean = /cannot (?:compile|save): (.+)/.exec(out);
      resolve({
        ok: false,
        error: clean ? clean[1] : out.split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).slice(-3).join(' ').slice(0, 300),
        partialAvailable,
      });
    });
  });
});

app.whenReady().then(() => {
  seedArtifacts();
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 700,
    backgroundColor: '#14161a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // No <webview>: the UI is one document that talks to the session over IPC.
      webviewTag: false,
    },
  });
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => { stopRun(); killTree(targetApp); app.quit(); });
app.on('before-quit', () => { stopRun(); killTree(targetApp); });
