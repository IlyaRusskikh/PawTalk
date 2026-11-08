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
