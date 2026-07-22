// preload.js — safe bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  saveVideo: (format) => ipcRenderer.invoke('dialog:saveVideo', { format }),
  exportBegin: (opts) => ipcRenderer.invoke('export:begin', opts),
  exportFrame: (id, buffer) => ipcRenderer.invoke('export:frame', { id, buffer }),
  exportEnd: (id) => ipcRenderer.invoke('export:end', { id }),
  exportCancel: (id) => ipcRenderer.invoke('export:cancel', { id }),
});
