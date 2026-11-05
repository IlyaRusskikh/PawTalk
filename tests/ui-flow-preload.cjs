const { contextBridge } = require('electron');
const calls = [];
const noop = () => () => {};
let cancelCheck;
contextBridge.exposeInMainWorld('desktop', {
 duck: async () => {},
 capabilities: async () => ({ native: true, secureStorage: true }), configureKeys: async () => ({ failed: [] }),
 hostStatus: async () => ({ running: false }), pendingInvitation: async () => '',
 checkHost: port => {
  calls.push(['host-check', port]);
  return new Promise(resolve => {
   const finish = state => { clearTimeout(timer); cancelCheck = null; resolve({ state, tcp: [state === 'internet', state === 'internet'], udp: state === 'internet' }); };
   const timer = setTimeout(() => finish(port === 18443 ? 'internet' : port === 18444 ? 'unconfirmed' : 'error'), port === 18446 ? 10000 : 200);
   cancelCheck = () => finish('cancelled');
  });
 },
 cancelHostCheck: async () => { if (cancelCheck) { calls.push(['host-check-cancel']); cancelCheck(); } },
 onInvitation: noop, onPtt: noop, onAction: noop, onSuspend: noop, onHostChanged: noop,
 diagnose: async address => { calls.push(['diagnose', address]); return { ok: !address.includes('unreachable'), e2eeRequired: address.includes('encrypted.example.com'), message: 'Test server unavailable' }; },
 connect: async target => { calls.push(['connect', target]); return { error: 'Test connection stopped before media' }; },
 loadPassword: async address => { calls.push(['load', address]); return { password: 'saved-secret' }; },
 savePassword: async input => { calls.push(['save', input]); },
});
contextBridge.exposeInMainWorld('testCalls', () => calls);
