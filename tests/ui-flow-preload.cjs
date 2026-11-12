const { contextBridge } = require('electron');
const calls = [];
const noop = () => () => {};
let cancelCheck;
let active = true, activeListener, presenceReads = 0, autoStart = false, inTray = false;
let autoUpdate = true;
let lockedPreviews = false;
let connectNeedsCredentials=false;
let savedCredentials={password:'saved-secret'};
let updateChannel = 'preview';
contextBridge.exposeInMainWorld('desktop', {
 windowActive: async () => active,
 onWindowActive: fn => { activeListener = fn; return () => { activeListener = null; }; },
 roomPresence: async () => { presenceReads++; return 3; },
 roomPreview: async () => { presenceReads++; return lockedPreviews ? {status:'locked',participants:99,unread:88,people:[{name:'Private fixture name'}]} : {status:'online',participants:3,unread:0,people:[],details:false}; },
 getAutoStart: async () => autoStart,
 setAutoStart: async value => { autoStart = value; return value; },
 getStartInTray: async () => inTray,
 setStartInTray: async value => { inTray = value; return value; },
 getAutoUpdate: async () => autoUpdate,
 setAutoUpdate: async value => { autoUpdate = value; calls.push(['auto-update', value]); return value; },
 getUpdateChannel: async () => updateChannel,
 setUpdateChannel: async value => { updateChannel = value; calls.push(['update-channel', value]); return value; },
 checkUpdate: async () => { calls.push(['check-update', autoUpdate]); return { status: 'idle' }; },
 copyServerKey: async value => { calls.push(['copy-server-key', value]); },
 duck: async () => {},
 capabilities: async () => ({ native: true, secureStorage: true, platform: 'win32', packaged: true }), configureKeys: async () => ({ failed: [] }),
 hostStatus: async () => ({ running: false }), pendingInvitation: async () => '',
 checkHost: port => {
  calls.push(['host-check', port]);
  return new Promise(resolve => {
   const finish = state => { clearTimeout(timer); cancelCheck = null; resolve({ state, tcp: [state === 'internet', state === 'internet'], udp: state === 'internet', ...(state === 'error' ? {reason:'checker-unavailable'} : {}) }); };
   const timer = setTimeout(() => finish(port === 18443 ? 'internet' : port === 18444 ? 'unconfirmed' : 'error'), port === 18446 ? 10000 : 200);
   cancelCheck = () => finish('cancelled');
  });
 },
 cancelHostCheck: async () => { if (cancelCheck) { calls.push(['host-check-cancel']); cancelCheck(); } },
 onInvitation: noop, onPtt: noop, onAction: noop, onSuspend: noop, onHostChanged: noop,
 diagnose: async address => { calls.push(['diagnose', address]); return { ok: !address.includes('unreachable'), e2eeRequired: address.includes('encrypted.example.com') || address.includes('/' + 'e'.repeat(64)), message: 'Test server unavailable' }; },
 connect: async target => { calls.push(['connect', target]); return { error: 'Test connection stopped before media',credentialsRequired:connectNeedsCredentials }; },
 loadPassword: async address => { calls.push(['load', address]); return savedCredentials; },
 savePassword: async input => { calls.push(['save', input]); },
});
contextBridge.exposeInMainWorld('testCalls', () => calls);

contextBridge.exposeInMainWorld('testWindowActive', value => { active = value; activeListener?.(value); });
contextBridge.exposeInMainWorld('testPresenceReads', () => presenceReads);
contextBridge.exposeInMainWorld('testLockedPreviews', value => { lockedPreviews = value; });
contextBridge.exposeInMainWorld('testConnectNeedsCredentials',value=>{connectNeedsCredentials=value;});
contextBridge.exposeInMainWorld('testSavedCredentials',value=>{savedCredentials=value;});
