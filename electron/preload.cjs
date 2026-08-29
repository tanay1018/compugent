const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runner', {
  start: (opts) => ipcRenderer.invoke('run:start', opts),
  stop: () => ipcRenderer.invoke('run:stop'),
  onLog: (fn) => ipcRenderer.on('run:log', (_e, line) => fn(line)),
  onExit: (fn) => ipcRenderer.on('run:exit', (_e, info) => fn(info)),
  listCapabilities: () => ipcRenderer.invoke('caps:list'),
  runCapability: (opts) => ipcRenderer.invoke('caps:run', opts),
  compileLatest: (opts) => ipcRenderer.invoke('caps:compile', opts || {}),
});
