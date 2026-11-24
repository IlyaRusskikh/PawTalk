import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {appId,windowIdentity}=require('../electron/app-identity.cjs');
test('running Client and installed shortcuts share Windows taskbar identity',()=>{
 assert.equal(appId,require('../electron-builder.cjs').appId);
 const executable='C:\\Program Files\\PawTalk\\PawTalk.exe';
 assert.deepEqual(windowIdentity(executable),{appId,appIconPath:executable,appIconIndex:0,relaunchCommand:'"'+executable+'"',relaunchDisplayName:'PawTalk'});
 assert.ok(!windowIdentity(executable).relaunchCommand.includes('--start-in-tray'));
 const entry='C:\\PawTalk review\\review.cjs';
 const icon='C:\\PawTalk review\\pawtalk.ico';
 assert.deepEqual(windowIdentity(executable,icon,entry),{appId,appIconPath:icon,appIconIndex:0,
  relaunchCommand:`"${executable}" "${entry}"`,relaunchDisplayName:'PawTalk'});
});
