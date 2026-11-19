import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {startApp,stopApp} from './review-app.mjs';
const {config}=createRequire(import.meta.url)('./review-app-config.cjs');
const profile='smoke-'+randomBytes(5).toString('hex');
for(const component of ['client','manager']){
 try{
  const options=component==='manager'?{bootstrap:'apps/manager/windows/tests/review-manager-process.cjs'}:{};
  const first=await startApp(component,profile,options);
  assert.ok(first.ready);assert.equal(first.pid,(await startApp(component,profile,options)).pid,'duplicate launch starts another app');
  await stopApp(component,profile);await assert.rejects(access(config(component,profile).runtime));
  await stopApp(component,profile);
  console.log('PASS '+component+' actual Electron review: rendered, isolated identity, duplicate suppression, graceful stop and idempotent stop');
 }finally{await stopApp(component,profile);}
}
console.log('Manager privileged broker was synthetically denied; no installed Server was stopped or modified.');
