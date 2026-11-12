const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');const path=require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let win;
 try{
  const root=path.resolve(__dirname,'..'),output=path.join(root,'manager/desktop/icons');await fs.mkdir(output,{recursive:true});
  const original=await fs.readFile(path.join(root,'assets/server.svg'),'utf8');
  win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,offscreen:true}});await win.loadURL('data:text/html,<html></html>');
  for(const [state,color]of Object.entries({running:'#72e0a2',transition:'#f1cd68',stopped:'#f08087'})){
   const svg=original.replace('fill="#252032"',`fill="${color}"`).replace('stroke="#fff" stroke-width="5"','stroke="#e9e5ff" stroke-width="5"').replace('<g fill="none" stroke="#fff"','<g fill="none" stroke="#20302b"').replace('<g fill="#fff"><circle','<g fill="#20302b"><circle');
   const frames=[];
   for(const size of [16,20,24,32,40,48,64,128,256]){
    const raw=await win.webContents.executeJavaScript(`(async()=>{const img=new Image();img.src=${JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'))};await img.decode();const c=document.createElement('canvas');c.width=c.height=${size};c.getContext('2d').drawImage(img,0,0,${size},${size});return c.toDataURL('image/png').split(',')[1];})()`);frames.push({size,data:Buffer.from(raw,'base64')});
   }
   const header=Buffer.alloc(6+16*frames.length);header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);let offset=header.length;
   frames.forEach(({size,data},i)=>{const at=6+i*16;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(data.length,at+8);header.writeUInt32LE(offset,at+12);offset+=data.length;});
   await fs.writeFile(path.join(output,`server-${state}.ico`),Buffer.concat([header,...frames.map(f=>f.data)]));
  }
  console.log('PASS generated green/yellow/red server-state icons from the original SVG');win.destroy();app.exit(0);
 }catch(error){console.error(error);win?.destroy();app.exit(1);}
});
