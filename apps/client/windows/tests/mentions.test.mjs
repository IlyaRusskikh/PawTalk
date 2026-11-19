import test from 'node:test';import assert from 'node:assert/strict';import{validMentions,shiftMentions}from '../../../../shared/mentions.mjs';
const person='a'.repeat(64),text='Hello @Alice!',mentions=[{profileId:person,start:6,end:12}];
test('mention ranges bind selected identities and reject malformed encrypted payloads',()=>{
 assert.deepEqual(validMentions(text,mentions),mentions);
 for(const bad of [[{...mentions[0],start:-1}],[{...mentions[0],end:30}],[{...mentions[0],profileId:'bad'}],[...mentions,...mentions]])assert.throws(()=>validMentions(text,bad));
});
test('typing preserves mentions outside edits, shifts offsets and drops changed labels',()=>{
 assert.deepEqual(shiftMentions(text,'Hey '+text,mentions),[{profileId:person,start:10,end:16}]);
 assert.deepEqual(shiftMentions(text,text+'!',mentions),mentions);
 assert.deepEqual(shiftMentions(text,'Hello @Alicia!',mentions),[]);
 assert.deepEqual(shiftMentions(text,'Hello !',mentions),[]);
});
