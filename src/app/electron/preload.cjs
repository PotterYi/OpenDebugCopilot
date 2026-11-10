const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'dc:config',
  'dc:databases',
  'dc:browser',
  'dc:element',
  'dc:capture',
  'dc:logs',
  'dc:diagnose',
  'dc:runs',
  'dc:devserver',
  'dc:fixes',
  'dc:verify',
  'dc:followup',
  'dc:profiles',
]);

const EVENTS = new Set([
  'dc:capture:event',
  'dc:diagnose:progress',
  'dc:followup:progress',
  'dc:devserver:event',
  'dc:element:event',
  'dc:database:open',
  'dc:model:open',
]);

contextBridge.exposeInMainWorld('dc', {
  invoke(channel, payload) {
    if (!CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(event, handler) {
    if (!EVENTS.has(event)) {
      throw new Error(`IPC event not allowed: ${event}`);
    }
    const listener = (_event, data) => handler(data);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
