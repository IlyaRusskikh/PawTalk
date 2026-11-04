const { contextBridge } = require('electron');
const calls = [];
const noop = () => () => {};
contextBridge.exposeInMainWorld('desktop', {
 duck: async () => {},
 capabilities: async () => ({ native: true, secureStorage: true }), configureKeys: async () => ({ failed: [] }),
 hostStatus: async () => ({ running: false }), pendingInvitation: async () => '',
 onInvitation: noop, onPtt: noop, onAction: noop, onSuspend: noop, onHostChanged: noop,
 diagnose: async address => { calls.push(['diagnose', address]); return { ok: !address.includes('unreachable'), e2eeRequired: address.includes('encrypted.example.com'), message: 'Test server unavailable' }; },
 connect: async target => { calls.push(['connect', target]); return { error: 'Test connection stopped before media' }; },
 loadPassword: async address => { calls.push(['load', address]); return { password: 'saved-secret' }; },
 savePassword: async input => { calls.push(['save', input]); },
});
contextBridge.exposeInMainWorld('testCalls', () => calls);
