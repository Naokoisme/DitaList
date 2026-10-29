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
  getFloatingVisible: () => ipcRenderer.invoke("floating:get-visible"),
  setFloatingVisible: (visible) => ipcRenderer.invoke("floating:set-visible", visible),
  onFloatingVisibilityChanged: (listener) => {
    const wrapped = (_event, visible) => listener(visible);
    ipcRenderer.on("floating:visibility-changed", wrapped);
    return () => ipcRenderer.removeListener("floating:visibility-changed", wrapped);
  },
  resizeFloating: (width, height) => ipcRenderer.send("floating:resize", width, height),
  moveFloating: (dx, dy) => ipcRenderer.send("floating:move", dx, dy),
  getFloatingState: () => ipcRenderer.invoke("floating:get-state"),
  onFloatingStateChanged: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("floating:state-changed", wrapped);
    return () => ipcRenderer.removeListener("floating:state-changed", wrapped);
  },
  updateFloatingStatus: (status) => ipcRenderer.send("floating:update-status", status),
  setFloatingExpanded: (expanded) => ipcRenderer.send("floating:set-expanded", expanded),
  getDesktopShortcut: () => ipcRenderer.invoke("shortcut:get-desktop"),
  createDesktopShortcut: () => ipcRenderer.invoke("shortcut:create-desktop"),
  removeDesktopShortcut: () => ipcRenderer.invoke("shortcut:remove-desktop"),
  windowAction: (action) => ipcRenderer.send("window:action", action),
  openFloating: () => ipcRenderer.send("floating:show"),
  closeFloating: () => ipcRenderer.send("floating:close"),
  openMain: () => ipcRenderer.send("floating:open-main"),
  submitQuickAdd: (text) => ipcRenderer.invoke("floating:quick-add", text),
  completeQuickAdd: (requestId, error) => ipcRenderer.send("quick-add:complete", requestId, error),
  onQuickAdd: (listener) => {
    const wrapped = (_event, text, requestId) => listener(text, requestId);
    ipcRenderer.on("quick-add", wrapped);
    ipcRenderer.send("quick-add:ready");
    return () => {
      ipcRenderer.removeListener("quick-add", wrapped);
      if (ipcRenderer.listenerCount("quick-add") === 0) ipcRenderer.send("quick-add:not-ready");
    };
  },
  onExternalData: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("external-data-change", wrapped);
    return () => ipcRenderer.removeListener("external-data-change", wrapped);
  },
});
