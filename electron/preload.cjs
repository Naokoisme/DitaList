const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("didaLocal", {
  load: () => ipcRenderer.invoke("data:load"),
  save: (data) => ipcRenderer.invoke("data:save", data),
  exportBackup: (data) => ipcRenderer.invoke("data:export", data),
  importBackup: () => ipcRenderer.invoke("data:import"),
  revealData: () => ipcRenderer.invoke("data:reveal"),
  generateAgentDocument: () => ipcRenderer.invoke("agent:generate-document"),
  copyAgentDocument: () => ipcRenderer.invoke("agent:copy-document"),
  openAgentDocumentDirectory: () => ipcRenderer.invoke("agent:open-directory"),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  setFloatingShortcut: (shortcut) =>
    ipcRenderer.invoke("settings:set-floating-shortcut", shortcut),
  getDesktopShortcut: () => ipcRenderer.invoke("shortcut:get-desktop"),
  createDesktopShortcut: () => ipcRenderer.invoke("shortcut:create-desktop"),
  removeDesktopShortcut: () => ipcRenderer.invoke("shortcut:remove-desktop"),
  windowAction: (action) => ipcRenderer.send("window:action", action),
  openFloating: () => ipcRenderer.send("floating:show"),
  closeFloating: () => ipcRenderer.send("floating:close"),
  openMain: () => ipcRenderer.send("floating:open-main"),
  submitQuickAdd: (text) => ipcRenderer.send("floating:quick-add", text),
  onQuickAdd: (listener) => {
    const wrapped = (_event, text) => listener(text);
    ipcRenderer.on("quick-add", wrapped);
    return () => ipcRenderer.removeListener("quick-add", wrapped);
  },
  onExternalData: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("external-data-change", wrapped);
    return () => ipcRenderer.removeListener("external-data-change", wrapped);
  },
});
