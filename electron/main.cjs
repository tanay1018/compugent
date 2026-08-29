// Desktop shell for the automation runner.
//
// The app owns the lifecycle: it starts the target app if the goal points at
// localhost, spawns a discovery run, waits for that run's operator console to
// come up, and then shows it. The console itself is unchanged -- it is the
// same client an operator would attach to a containerised session with, which
// is why this shell can stay thin.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
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
