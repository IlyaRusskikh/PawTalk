const { contextBridge } = require('electron');
let update;
const hosts = new Set();
let calls = 0;
const noop = () => () => {};
contextBridge.exposeInMainWorld('desktop', {
  capabilities: async () => ({ native: true, secureStorage: true }), configureKeys: async () => ({ failed: [] }),
  hostStatus: async () => ({ running: false }), pendingInvitation: async () => '', duck: async () => {},
  onInvitation: noop, onPtt: noop, onAction: noop, onSuspend: noop,
  onHostChanged: fn => { hosts.add(fn); return () => { hosts.delete(fn); }; },
  updateState: async () => ({ status: 'idle' }),
  onUpdate: fn => { update = fn; return () => { update = null; }; },
  installUpdate: async () => {
    calls++;
    update?.({ status: 'downloading', version: '0.2.0-beta.1', progress: 35, prerelease: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    return { status: 'failed', version: '0.2.0-beta.1', prerelease: true };
  },
});
contextBridge.exposeInMainWorld('updateTest', {
  offer: () => update?.({ status: 'available', version: '0.2.0-beta.1', prerelease: true }),
  host: () => hosts.forEach(fn => fn({ running: true, name: 'Synthetic room' })),
  calls: () => calls,
});
