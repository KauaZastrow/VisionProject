const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("telaJunta", {
  listScreens: () => ipcRenderer.invoke("screens:list"),
  selectScreen: (sourceId) => ipcRenderer.invoke("screens:select", sourceId),
  authorizeControl: (peerId) => ipcRenderer.invoke("control:authorize", peerId),
  sendControlInput: (peerId, input) =>
    ipcRenderer.invoke("control:input", peerId, input),
});
