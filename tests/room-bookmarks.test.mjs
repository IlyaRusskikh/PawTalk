import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bookmarkAddress,sameBookmark,reconcileBookmarks,loadBookmarks} from '../shared/room-bookmarks.mjs';
const pin='a'.repeat(64),roomId='b'.repeat(64);
const address=`pawtalk://192.0.2.10:18443/${pin}`;
test('share links, bare addresses and password rotations identify one verified room',()=>{
 const original={address:'https://192.0.2.10:18443',name:'My room'};
 const verified={address:address+'#password=new-secret&name=Shared& e2ee=ignored',roomId};
 const duplicate={address:address+'#password=old-secret',name:'Duplicate'};
 const result=reconcileBookmarks([original,duplicate],verified);
 assert.deepEqual(result,[{address,name:'My room',roomId}]);
 assert.equal(JSON.stringify(result).includes('secret'),false);
 assert.equal(bookmarkAddress(address+'#password=secret'),address);
 assert.equal(sameBookmark(result[0],{address:address+'#password=different',roomId}),true);
 assert.equal(sameBookmark(result[0],{address:`pawtalk://203.0.113.10:18443/${pin}`,roomId}),true);
});
test('different verified rooms or replaced certificates are never silently merged',()=>{
 const item={address,name:'Original',roomId};
 assert.equal(sameBookmark(item,{address,roomId:'c'.repeat(64)}),false);
 assert.equal(sameBookmark({address},{address:address.replace(pin,'d'.repeat(64))}),false);
 const different={address:address.replace(pin,'d'.repeat(64)),roomId:'c'.repeat(64)};
 assert.equal(reconcileBookmarks([item],different)[0],item);
});
test('legacy duplicates migrate to the pinned route without persisting secrets',()=>{
 const bookmarks=loadBookmarks([{address:'https://192.0.2.10:18443',name:'First',password:'must-not-persist'},{address,name:'Duplicate'},{address:address+'#password=secret',name:'Invalid saved fragment'}]);
 assert.deepEqual(bookmarks,[{address,name:'First'}]);
 assert.doesNotMatch(JSON.stringify(bookmarks),/secret|password|must-not/);
});
