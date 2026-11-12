import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';
const require=createRequire(import.meta.url),{trayItems,stopAndExit}=require('../manager/desktop/tray-model.cjs'),words=require('../manager/desktop/strings.json');
test('Manager tray follows real service states, keeps actions compact and offers manual updates',()=>{
 for(const language of ['ru','en'])for(const state of ['running','stopped','starting','stopping','unknown']){
  const actions=[],strings=words[language],handlers={toggle:action=>actions.push(action),show:()=>actions.push('settings'),update:()=>actions.push('update'),exit:()=>actions.push('exit'),hide:()=>actions.push('hide')};
  const items=trayItems({state,busy:null,update:{status:'available'}},strings,handlers),find=id=>items.find(item=>item.id===id);
  assert.deepEqual(items.filter(item=>item.id).map(item=>item.id),['status','toggle','settings','update','exit','hide']);
  assert.equal(find('toggle').enabled,['running','stopped'].includes(state));
  assert.equal(find('toggle').label,state==='running'?strings.stop:strings.start);
  assert.ok(find('status').label.includes(strings.states[state]||strings.states.unavailable));
  find('hide').click();assert.deepEqual(actions,['hide'],'hiding cannot stop the service or exit');
  assert.equal(trayItems({state:'running',busy:'apply',update:{status:'current'}},strings,handlers).find(item=>item.id==='exit').enabled,false);
 }
});
test('Exit Manager waits for a confirmed stop and remains open on stop failure',async()=>{
 const events=[];await stopAndExit(async()=>events.push('stop'),async()=>events.push('exit'));assert.deepEqual(events,['stop','exit']);
 await assert.rejects(stopAndExit(async()=>{throw Error('stop failed');},async()=>events.push('unsafe exit')));
 assert.deepEqual(events,['stop','exit']);
});
