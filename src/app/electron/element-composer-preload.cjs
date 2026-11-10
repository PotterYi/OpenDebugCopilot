const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dcComposer', {
  submit: (question) => ipcRenderer.invoke('dc:element-composer:submit', { question }),
  cancel: () => ipcRenderer.invoke('dc:element-composer:cancel'),
});
