// preload.js — safe bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openImages: () => ipcRenderer.invoke('dialog:openImages'),
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  saveVideo: (format) => ipcRenderer.invoke('dialog:saveVideo', { format }),
  exportBegin: (opts) => ipcRenderer.invoke('export:begin', opts),
  exportFrame: (id, buffer) => ipcRenderer.invoke('export:frame', { id, buffer }),
  exportEnd: (id) => ipcRenderer.invoke('export:end', { id }),
  exportCancel: (id) => ipcRenderer.invoke('export:cancel', { id }),

  // Project save / load
  saveProjectPath: (defaultName) => ipcRenderer.invoke('dialog:saveProjectPath', { defaultName }),
  openProjectPath: () => ipcRenderer.invoke('dialog:openProjectPath'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  writeProject: (args) => ipcRenderer.invoke('project:write', args),
  readProject: (filePath) => ipcRenderer.invoke('project:read', { filePath }),
  matchInFolder: (folder, names) => ipcRenderer.invoke('fs:matchInFolder', { folder, names }),
});
