/**
 * 首启向导的专用 preload —— 只暴露向导需要的 6 个方法。
 * 独立文件而不复用主 preload：向导页面不需要（也不应该拿到）完整 IPC 面。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  detect: () => ipcRenderer.invoke('setup:detect'),
  applyDatabase: (cfg) => ipcRenderer.invoke('setup:db:apply', cfg),
  testDatabase: (cfg) => ipcRenderer.invoke('setup:db:test', cfg),
  packs: () => ipcRenderer.invoke('setup:packs'),
  downloadPack: (id) => ipcRenderer.invoke('setup:pack:download', id),
  finish: () => ipcRenderer.invoke('setup:finish'),
  onPackProgress: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on('setup:pack:progress', h);
    return () => ipcRenderer.removeListener('setup:pack:progress', h);
  },
});
