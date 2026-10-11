const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("dropbridge", {
  invoke: (action, payload) =>
    ipcRenderer.invoke("dropbridge:action", action, payload),
  dropped: (files) =>
    ipcRenderer.invoke(
      "dropbridge:action",
      "addFiles",
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    ),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("dropbridge:state", listener);
    return () => ipcRenderer.removeListener("dropbridge:state", listener);
  },
});
