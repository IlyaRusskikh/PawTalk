const {app}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {createClient}=require('../../../client/windows/tests/membership-electron-client.cjs');
app.setPath('userData',path.join(process.env.PAWTALK_APP_TEST_DIR,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const input=JSON.parse(await fs.readFile(process.env.PAWTALK_APP_TEST_INPUT,'utf8')),profile=app.getPath('userData'),client=createClient(path.join(profile,'credentials'));
 let state;
 if(input.mode==='join'||input.mode==='audio-new'){
  state=await client.join(input.address,'same-name','Synthetic native PC');
  await client.send(state.serverId,state.channels.find(channel=>channel.kind==='text'&&channel.protected).id,{text:'Manager API 2 encrypted restore fixture'});
 }else{
  const record=(await client.registry())[0];assert.ok(record,'native client lost its protected membership');
  state=await client.connect({...record,...(input.address?{address:input.address}:{})});await client.remember(client.connections.get(state.serverId));
 }
 assert.equal(state.self.role,'admin');
 const page=await client.messages(state.serverId,state.channels.find(channel=>channel.kind==='text'&&channel.protected).id);
 assert.ok(page.messages.some(message=>message.content.text==='Manager API 2 encrypted restore fixture'),'encrypted message lost after host lifecycle');
 if(input.mode==='audio'||input.mode==='audio-new'){
  const guest=createClient(path.join(profile,'guest-credentials')),saved=await guest.registry();
  if(saved.length)await guest.connect(saved[0]);else await guest.join(await client.invite(state.serverId,'single'),'same-name','Synthetic guest PC');
 }
 const result={serverId:state.serverId,profile,address:client.connections.get(state.serverId).address};
 await fs.writeFile(process.env.PAWTALK_APP_TEST_OUTPUT,JSON.stringify(result),{mode:0o600});
 console.log('PASS native OS-protected API 2 client: '+input.mode);app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
