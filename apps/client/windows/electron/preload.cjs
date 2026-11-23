const { contextBridge, ipcRenderer } = require('electron');
async function invokeHost(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result.error) throw new Error(result.error);
  return result.value;
}
function listen(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
contextBridge.exposeInMainWorld('desktop', {
  membership: (action,input) => ipcRenderer.invoke('membership',action,input),
  recordClientPerformance: (stage, ms) => { void ipcRenderer.invoke('client-performance', stage, ms).catch(() => {}); },
  onMembershipServerEvent: callback=>listen('membership-server-event',callback),
  onMembershipLiveStatus: callback=>listen('membership-live-status',callback),
  onMembershipProtectedEvent: callback=>listen('membership-protected-event',callback),
  onMembershipChatChanged: callback=>listen('membership-chat-changed',callback),
  onMembershipChanged: callback=>listen('membership-changed',callback),
  onMembershipVoiceLost: callback=>listen('membership-voice-lost',callback),
  onMembershipOpenChannel: callback=>listen('membership-open-channel',callback),
  copyChatText: text => ipcRenderer.invoke('chat-text-copy', text),
  copyChatImage: input => ipcRenderer.invoke('chat-image-copy', input),
  saveChatImage: input => ipcRenderer.invoke('chat-image-save', input),
  windowActive: () => ipcRenderer.invoke('window-active'),
  onWindowActive: (fn) => listen('window-active-changed', fn),
  getStartInTray: () => ipcRenderer.invoke('start-in-tray-get'),
  setStartInTray: (value) => ipcRenderer.invoke('start-in-tray-set', value),
  getAutoStart: () => ipcRenderer.invoke('autostart-get'),
  setAutoStart: (enabled) => ipcRenderer.invoke('autostart-set', enabled),
  getLanguage: () => ipcRenderer.invoke('language-get'),
  setLanguage: (value) => ipcRenderer.invoke('language-set', value),
  updateState: () => ipcRenderer.invoke('update-state'),
  setUpdateRooms: rooms => ipcRenderer.invoke('update-rooms-set', rooms),
  getAutoUpdate: () => ipcRenderer.invoke('update-preference-get'),
  setAutoUpdate: value => ipcRenderer.invoke('update-preference-set', value),
  getUpdateChannel: () => ipcRenderer.invoke('update-channel-get'),
  setUpdateChannel: value => ipcRenderer.invoke('update-channel-set', value),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdate: (fn) => listen('update-changed', fn),
  copyDiagnosticCommand: (address) => ipcRenderer.invoke('diagnostic-command-copy', address),
  copyInvitation: (address) => ipcRenderer.invoke('invitation-copy', address),
  pendingInvitation: () => ipcRenderer.invoke('invitation-pending'),
  onInvitation: (fn) => listen('invitation', fn),
  startHost: (input) => invokeHost('host-start', input),
  stopHost: () => invokeHost('host-stop'),
  hostStatus: () => ipcRenderer.invoke('host-status'),
  checkHost: (port) => invokeHost('host-check', port),
  cancelHostCheck: () => invokeHost('host-check-cancel'),
  onHostChanged: (fn) => listen('host-changed', fn),
  diagnose: (address) => ipcRenderer.invoke('connection-diagnose', address),
  capabilities: () => ipcRenderer.invoke('capabilities'),
  configureKeys: (input) => ipcRenderer.invoke('configure-keys', input),
  duck: (input) => ipcRenderer.invoke('duck', input),
  onPtt: (fn) => listen('ptt', fn),
  onAction: (fn) => listen('action', fn),
  onSuspend: (fn) => listen('suspend', fn),
});
