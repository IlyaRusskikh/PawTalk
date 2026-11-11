// Rebuild Windows multi-resolution icons and PNGs from the single SVG source.
const fs = require('node:fs/promises');
const path = require('node:path');
if (!process.versions.electron) {
 const { spawn } = require('node:child_process');
 const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
 const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
 child.on('error', e => { console.error(e); process.exit(1); });
 child.on('exit', code => process.exit(code ?? 1));
} else {
 const { app, BrowserWindow } = require('electron');
 app.disableHardwareAcceleration();
 app.whenReady().then(async () => {
  let win;
  try {
   const root = path.join(__dirname, '..');
   const serverOnly = process.argv.includes('--server-only');
   const svg = await fs.readFile(path.join(root, serverOnly ? 'assets/server.svg' : 'assets/pawtalk.svg'), 'utf8');
   win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
   await win.loadURL('data:text/html,<html><body></body></html>');
   const frames = [];
   for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256, 512]) {
    const data = await win.webContents.executeJavaScript(`(async()=>{const img=new Image();img.src=${JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'))};await img.decode();const c=document.createElement('canvas');c.width=c.height=${size};c.getContext('2d').drawImage(img,0,0,${size},${size});return c.toDataURL('image/png').split(',')[1]})()`);
    frames.push({ size, data: Buffer.from(data,'base64') });
   }
   function ico(images) {
    const header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
    let offset=header.length;
    images.forEach(({size,data},i)=>{const at=6+i*16;header[at]=header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(data.length,at+8);header.writeUInt32LE(offset,at+12);offset+=data.length;});
    return Buffer.concat([header,...images.map(v=>v.data)]);
   }
   const asset = name => path.join(root,'assets',name);
   if (serverOnly) {
    await fs.writeFile(asset('server.ico'),ico(frames.filter(v=>v.size<=256)));
    await fs.writeFile(asset('server.png'),frames.find(v=>v.size===256).data);
    console.log('Generated Server icons.');win.destroy();app.exit(0);return;
   }
   await fs.writeFile(asset('pawtalk.ico'),ico(frames.filter(v=>v.size<=256)));
   await fs.writeFile(asset('tray.ico'),ico(frames.filter(v=>v.size<=64)));
   await fs.writeFile(asset('pawtalk.png'),frames.find(v=>v.size===512).data);
   await fs.writeFile(asset('tray.png'),frames.find(v=>v.size===32).data);
   await fs.writeFile(path.join(root,'public/favicon.ico'),ico(frames.filter(v=>[16,32,48].includes(v.size))));
   console.log('Generated application, installer, tray and favicon icons.');win.destroy();app.exit(0);
  } catch(e){console.error(e);win?.destroy();app.exit(1);}
 });
}
