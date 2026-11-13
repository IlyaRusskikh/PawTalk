// Parent Windows SCM smoke is elevated; only its isolated host/root are used.
const {Broker}=require('../manager/desktop/backend.cjs');
const {spawn}=require('node:child_process');
const path=require('node:path');
const assert=require('node:assert/strict');
const [stage,root]=process.argv.slice(2);
const broker=new Broker(path.join(stage,'pawtalk-server-tray.exe'),root,async(file,args)=>{
 const child=spawn(file,args,{windowsHide:true,stdio:'ignore'});child.unref();
});
(async()=>{
 try{
  let completed=false;
  const check=broker.request('check-updates').finally(()=>completed=true);
  await new Promise(resolve=>setTimeout(resolve,250));
  const logs=await broker.request('logs');
  const snapshot=await broker.request('snapshot');
  assert.equal(typeof logs.text,'string');assert.ok(snapshot.values);
  assert.equal(completed,false,'read-only actions must finish while slow metadata discovery is pending');
  assert.equal((await check).status,'current');
  console.log('PASS actual Electron broker protocol/Go/Python: slow synthetic network check does not block logs or settings');
  const created=await broker.request('backup-create');
  assert.ok(created.backups.some(value=>value.name===created.name));
  const deleted=await broker.request('backup-delete',{name:created.name});
  assert.equal(deleted.backups.some(value=>value.name===created.name),false);
  assert.deepEqual(deleted.values,snapshot.values);
  assert.equal(deleted.serverVersion,snapshot.serverVersion);
  console.log('PASS actual broker backup creation/deletion: selected directory removed, refreshed list returned and room configuration preserved');
 }finally{broker.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
