const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("didaLocal", {
  load: () => ipcRenderer.invoke("data:load"),
  save: (data) => ipcRenderer.invoke("data:save", data),
  exportBackup: (data) => ipcRenderer.invoke("data:export", data),
  importBackup: () => ipcRenderer.invoke("data:import"),
  revealData: () => ipcRenderer.invoke("data:reveal"),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  windowAction: (action) => ipcRenderer.send("window:action", action),
});
