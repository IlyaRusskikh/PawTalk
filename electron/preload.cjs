const { contextBridge, ipcRenderer } = require('electron');
function listen(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('desktop', {
  copyDiagnosticCommand: (address) => ipcRenderer.invoke('diagnostic-command-copy', address),
  copyInvitation: (address) => ipcRenderer.invoke('invitation-copy', address),
  pendingInvitation: () => ipcRenderer.invoke('invitation-pending'),
  onInvitation: (fn) => listen('invitation', fn),
  startHost: (input) => ipcRenderer.invoke('host-start', input),
  stopHost: () => ipcRenderer.invoke('host-stop'),
  hostStatus: () => ipcRenderer.invoke('host-status'),
  checkHost: (port) => ipcRenderer.invoke('host-check', port),
  cancelHostCheck: () => ipcRenderer.invoke('host-check-cancel'),
  onHostChanged: (fn) => listen('host-changed', fn),
  connect: (input) => ipcRenderer.invoke('connect', input),
  diagnose: (address) => ipcRenderer.invoke('connection-diagnose', address),
  capabilities: () => ipcRenderer.invoke('capabilities'),
  loadPassword: (address) => ipcRenderer.invoke('credentials-load', address),
  savePassword: (input) => ipcRenderer.invoke('credentials-save', input),
  configureKeys: (input) => ipcRenderer.invoke('configure-keys', input),
  duck: (input) => ipcRenderer.invoke('duck', input),
  onPtt: (fn) => listen('ptt', fn),
  onAction: (fn) => listen('action', fn),
  onSuspend: (fn) => listen('suspend', fn),
});
