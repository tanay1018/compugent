const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runner', {
  start: (opts) => ipcRenderer.invoke('run:start', opts),
  stop: () => ipcRenderer.invoke('run:stop'),
  onLog: (fn) => ipcRenderer.on('run:log', (_e, line) => fn(line)),
  onExit: (fn) => ipcRenderer.on('run:exit', (_e, info) => fn(info)),
  onDone: (fn) => ipcRenderer.on('run:done', (_e, info) => fn(info)),
  onSessionEvent: (fn) => ipcRenderer.on('session:event', (_e, d) => fn(d)),
  control: (body) => ipcRenderer.invoke('session:control', body),
  input: (body) => ipcRenderer.invoke('session:input', body),
  listCapabilities: () => ipcRenderer.invoke('caps:list'),
  runCapability: (opts) => ipcRenderer.invoke('caps:run', opts),
  runCapabilityLive: (opts) => ipcRenderer.invoke('caps:runLive', opts),
  onReplayPlan: (fn) => ipcRenderer.on('replay:plan', (_e, d) => fn(d)),
  onReplayDone: (fn) => ipcRenderer.on('replay:done', (_e, d) => fn(d)),
  compileLatest: (opts) => ipcRenderer.invoke('caps:compile', opts || {}),
});
