const { contextBridge } = require('electron');
let listener;
contextBridge.exposeInMainWorld('desktop', {
  capabilities: async () => ({ native: false, platform: 'win32', packaged: false }),
  configureKeys: async () => ({ failed: [] }),
  onPtt: () => () => {}, onAction: () => () => {}, onSuspend: () => () => {},
  hostStatus: async () => ({ running: false }), onHostChanged: () => () => {},
  pendingInvitation: async () => '', onInvitation: () => () => {},
  updateState: async () => ({ status: 'idle' }),
  onUpdate: callback => { listener = callback; return () => { listener = undefined; }; },
});
contextBridge.exposeInMainWorld('offerTestUpdate', () => listener?.({ status: 'available', version: '99.0.0' }));
