const { contextBridge } = require('electron');
const updates = new Set();
let state = { status: 'idle' };
const emit = value => { state = value; updates.forEach(fn => fn(value)); };
const hosts = new Set();
let calls = 0;
const noop = () => () => {};
contextBridge.exposeInMainWorld('desktop', {
  capabilities: async () => ({ native: true, secureStorage: true }), configureKeys: async () => ({ failed: [] }),
  hostStatus: async () => ({ running: false }), pendingInvitation: async () => '', duck: async () => {},
  onInvitation: noop, onPtt: noop, onAction: noop, onSuspend: noop,
  onHostChanged: fn => { hosts.add(fn); return () => { hosts.delete(fn); }; },
  updateState: async () => state,
  onUpdate: fn => { updates.add(fn); return () => updates.delete(fn); },
  installUpdate: async () => {
    calls++;
    emit({ status: 'downloading', version: '0.2.0-beta.1', progress: 35, prerelease: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    return { status: 'failed', version: '0.2.0-beta.1', prerelease: true };
  },
});
contextBridge.exposeInMainWorld('updateTest', {
  offer: () => emit({ status: 'available', version: '0.2.0-beta.1', prerelease: true }),
  host: () => hosts.forEach(fn => fn({ running: true, name: 'Synthetic room' })),
  calls: () => calls,
  unsafe: () => emit({ status: 'security-failed', source: 'Synthetic relay', version: '0.2.0-beta.1' }),
  unsafeCheck: () => emit({ status: 'security-failed', source: 'Synthetic relay' }),
});
