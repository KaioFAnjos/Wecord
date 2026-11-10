// Ponte segura entre a interface e o Electron
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wecordNative', {
  isElectron: true,
  platform: process.platform,
  getSources: () => ipcRenderer.invoke('wecord:get-sources'),
  selectSource: (sel) => ipcRenderer.invoke('wecord:select-source', sel),
  info: () => ipcRenderer.invoke('wecord:info'),
  flash: () => ipcRenderer.invoke('wecord:flash'),
  updateState: () => ipcRenderer.invoke('wecord:update-state'),
  installUpdate: () => ipcRenderer.invoke('wecord:update-install'),
  onUpdate: (cb) => ipcRenderer.on('wecord:update', (_e, state) => cb(state)),
});
