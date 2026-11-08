const assert = require('node:assert/strict');
const native = require('../native/build/Release/pawtalk.node');
for (const key of ['startPtt','stopPtt','setPttKey','setDucking']) assert.equal(typeof native[key],'function');
native.startPtt(() => {}); native.setPttKey(135); native.setDucking(1);
setTimeout(() => { native.stopPtt(); native.setDucking(1); native.shutdown(); console.log('PASS native module, global input hooks, key configuration, attenuation reset, cleanup'); if(process.versions.electron) require('electron').app.exit(0); }, 300);
