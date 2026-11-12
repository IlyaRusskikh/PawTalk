import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {CredentialStore}=createRequire(import.meta.url)('../electron/credentials.cjs');
test('credential storage isolates servers, delegates encryption and deletes on opt out',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'pawtalk-credential-test-'));
 const encryption={isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from('opaque-encrypted-data'),decryptString:()=>'test-secret'};
 try{
  const store=new CredentialStore(directory,encryption);
  assert.equal(await store.load('https://127.0.0.1'),null);
  await store.save('https://127.0.0.1','test-secret');
  assert.equal(await store.load('https://127.0.0.1'),'test-secret');
  assert.equal(await store.load('https://127.0.0.1:8443'),null);
  const file=(await readdir(directory))[0];assert.ok(!(await readFile(path.join(directory,file))).includes(Buffer.from('test-secret')));
  await store.save('https://127.0.0.1',null);assert.equal(await store.load('https://127.0.0.1'),null);
  encryption.isEncryptionAvailable=()=>false;
  await assert.rejects(store.save('https://127.0.0.1','test-secret'));
  assert.equal((await readdir(directory)).length,0);
 }finally{if(path.dirname(directory)===path.resolve(tmpdir())&&path.basename(directory).startsWith('pawtalk-credential-test-'))await rm(directory,{recursive:true,force:true});}
});

test('password/key snapshots cannot interleave with a bookmark credential replacement',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'pawtalk-credential-test-'));
 let release,started;const gate=new Promise(r=>release=r),blocked=new Promise(r=>started=r);
 const encryption={isEncryptionAvailable:()=>true,encryptString:async value=>{if(value==='new-key'){started();await gate;}return Buffer.from('encrypted:'+value);},decryptString:bytes=>bytes.toString().slice(10)};
 try{
  const store=new CredentialStore(directory,encryption);
  await store.saveMany([['room','old-password'],['e2ee:room','old-key']]);
  const write=store.saveMany([['room','new-password'],['e2ee:room','new-key']]);
  await blocked;
  let readFinished=false;const read=store.loadMany(['room','e2ee:room']).then(value=>{readFinished=true;return value;});
  await new Promise(setImmediate);assert.equal(readFinished,false,'preview must wait for the entire credential pair');
  release();await write;assert.deepEqual(await read,['new-password','new-key']);
  encryption.encryptString=async value=>{if(value==='failed-key')throw Error('encryption failed');return Buffer.from('encrypted:'+value);};
  await assert.rejects(store.saveMany([['room','uncommitted-password'],['e2ee:room','failed-key']]));
  assert.deepEqual(await store.loadMany(['room','e2ee:room']),['new-password','new-key'],'failed encryption may not publish half a new pair');
  await store.saveMany([['room',null],['e2ee:room',null]]);assert.deepEqual(await store.loadMany(['room','e2ee:room']),[null,null]);
 }finally{release();await rm(directory,{recursive:true,force:true});}
});
