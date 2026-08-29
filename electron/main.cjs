// Desktop shell for the automation runner.
//
// The app owns the lifecycle: it starts the target app if the goal points at
// localhost, spawns a discovery run, waits for that run's operator console to
// come up, and then shows it. The console itself is unchanged -- it is the
// same client an operator would attach to a containerised session with, which
// is why this shell can stay thin.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let win = null;
let child = null;
let targetApp = null;

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

function stopRun() {
  if (child) { try { child.kill('SIGKILL'); } catch {} child = null; }
}

/** The bundled target app, started on demand so a local goal just works. */
async function ensureTargetApp() {
  if (await portUp(8710)) return;
  targetApp = spawn('npx', ['tsx', 'target-app/server.ts'], { cwd: ROOT, stdio: 'ignore' });
  await waitFor(8710, 15000);
}

ipcMain.handle('run:start', async (_e, { url, task }) => {
  stopRun();
  if (/localhost:8710|127\.0\.0\.1:8710/.test(url)) {
    send('run:log', '· starting the bundled MemberDesk target app\n');
    await ensureTargetApp();
  }

  const port = await freePort();
  const args = ['tsx', 'scripts/watch.ts', task, '--url', url, '--keep-open'];
  child = spawn('npx', args, { cwd: ROOT, env: { ...process.env, CONSOLE_PORT: String(port) } });

  child.stdout.on('data', (d) => send('run:log', d.toString()));
  child.stderr.on('data', (d) => send('run:log', d.toString()));
  child.on('exit', (code) => { send('run:exit', { code }); child = null; });

  const ok = await waitFor(port);
  if (!ok) { stopRun(); return { ok: false, error: 'the run did not start — check the log below' }; }
  return { ok: true, consoleUrl: `http://localhost:${port}/` };
});

ipcMain.handle('run:stop', () => { stopRun(); return { ok: true }; });

/**
 * The capability catalog: what has been recorded and can now be invoked
 * without a model. Read straight off disk — artifacts are files, one per
 * version, and the newest version of each id is what a caller gets.
 */
ipcMain.handle('caps:list', () => {
  const root = path.join(ROOT, 'artifacts');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const id of fs.readdirSync(root)) {
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const versions = fs.readdirSync(dir)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    const v = versions.at(-1);
    if (v === undefined) continue;
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, `v${v}.json`), 'utf8'));
      out.push({
        id: a.id, version: a.version, versions, name: a.name, description: a.description,
        approval: a.approval, inputs: a.inputs, outputs: a.outputs,
        outcomes: (a.outcomes || []).map((o) => ({ name: o.name, classification: o.classification })),
        steps: a.steps.length, app: a.app,
      });
    } catch { /* a malformed artifact is not a reason to hide the rest */ }
  }
  return out;
});

/** Replay a capability. No model is involved — this is the production path. */
ipcMain.handle('caps:run', async (_e, { id, inputs, url }) => {
  if (/localhost:8710|127\.0\.0\.1:8710/.test(url || '')) await ensureTargetApp();
  const args = ['tsx', 'scripts/replay.ts', id, '--json'];
  for (const [k, v] of Object.entries(inputs || {})) if (String(v).length) args.push(`${k}=${v}`);
  if (url) args.push('--url', url);

  return new Promise((resolve) => {
    const p = spawn('npx', args, { cwd: ROOT, env: { ...process.env } });
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
ipcMain.handle('caps:compile', async () => {
  return new Promise((resolve) => {
    const p = spawn('npx', ['tsx', 'scripts/compile.ts'], { cwd: ROOT, env: { ...process.env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); send('run:log', d.toString()); });
    p.stderr.on('data', (d) => { out += d.toString(); send('run:log', d.toString()); });
    p.on('exit', (code) => {
      const saved = /saved: (\S+)/.exec(out);
      resolve(code === 0 && saved ? { ok: true, path: saved[1] } : { ok: false, error: out.trim().slice(-400) });
    });
  });
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1040, minHeight: 700,
    backgroundColor: '#14161a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The console is loaded in a <webview>, which needs this enabled.
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'shell.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => { stopRun(); if (targetApp) targetApp.kill('SIGKILL'); app.quit(); });
app.on('before-quit', () => { stopRun(); if (targetApp) targetApp.kill('SIGKILL'); });
