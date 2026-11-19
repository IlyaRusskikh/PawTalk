import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {config}=createRequire(import.meta.url)('../../../../tooling/dev/review-app-config.cjs');
test('review lifecycle restricts components and confines named profiles to generated output',()=>{
 for(const component of ['client','manager']){
  const a=config(component),b=config(component,'phone');
  assert.notEqual(a.runtime,b.runtime);assert.ok(a.runtime.includes('release'));assert.ok(b.userData.includes(component+'-phone'));
 }
 for(const component of ['server','installed','../client'])assert.throws(()=>config(component));
 for(const profile of ['..','a/b','a\\b','x'.repeat(41),'$(whoami)'])assert.throws(()=>config('client',profile));
});
