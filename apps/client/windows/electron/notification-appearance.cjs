const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{createHash}=require('node:crypto');
const {inspectImage}=require('../../../../shared/image.mjs');
const escapeXML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
function avatarBytes(value){
 if(typeof value!=='string'||value.length>12000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return;
 const bytes=Buffer.from(value.slice(value.indexOf(',')+1),'base64'),metadata=inspectImage(bytes);
 if(!metadata||!value.startsWith(`data:${metadata.mime};base64,`)||metadata.width>512||metadata.height>512)return;
 return bytes;
}
function toastXML(title,body,uri){return `<toast><visual><binding template="ToastGeneric"><image placement="appLogoOverride" hint-crop="circle" src="${escapeXML(uri)}"/><text>${escapeXML(title)}</text><text>${escapeXML(body)}</text></binding></visual><audio silent="true"/></toast>`;}
const avatarSize = 96;

function avatarRasterizer(BrowserWindow) {
 let active;
 return async (webp, initial) => {
  if (!BrowserWindow) return;
  if (!active) {
   const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
   } });
   window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
   window.webContents.on('will-navigate', event => event.preventDefault());
   const markup = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">`;
   active = { window, ready: window.loadURL('data:text/html,' + encodeURIComponent(markup)), users: 0 };
  }
  const current = active;
  current.users++;
  try {
   await current.ready;
   const dataURL = await current.window.webContents.executeJavaScript(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ${avatarSize};
    const ctx = canvas.getContext('2d');
    const src = ${JSON.stringify(webp ?? '')};
    if (src) {
     const image = new Image();
     image.src = src;
     try {
      await image.decode();
      if (image.naturalWidth > 512 || image.naturalHeight > 512) return null;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
     } catch { /* Use the sender's initial if the image cannot be decoded. */ }
    }
    const initial = ${JSON.stringify(initial ?? '')};
    if (!initial) return null;
    ctx.fillStyle = '#6654cb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 48px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL('image/png');
   })()`);
   return typeof dataURL === 'string' ? dataURL : undefined;
  } finally {
   if (--current.users === 0) {
    active = undefined;
    if (!current.window.isDestroyed()) current.window.destroy();
   }
  }
 };
}

function notificationAppearance({directory,nativeImage,BrowserWindow,platform=process.platform}){
 const rasterize = avatarRasterizer(BrowserWindow);
 return async({avatar,authorName,title,body})=>{
  const bytes=avatarBytes(avatar);
  let image=bytes && nativeImage.createFromBuffer(bytes);
  if (!image || image.isEmpty()) {
   const webp = bytes && avatar.startsWith('data:image/webp;') ? `data:image/webp;base64,${bytes.toString('base64')}` : undefined;
   const initial = Array.from(authorName?.trim() ?? '')[0]?.toUpperCase();
   if (!webp && !initial) return {};
   const dataURL = await rasterize(webp, initial);
   if (dataURL) image = nativeImage.createFromDataURL(dataURL);
  }
  if (!image || image.isEmpty()) return {};
  const png=image.resize({width:avatarSize,height:avatarSize}).toPNG();
  if(platform!=='win32')return{icon:image};
  await fs.mkdir(directory,{recursive:true});const file=path.join(directory,createHash('sha256').update(png).digest('hex')+'.png');await fs.writeFile(file,png,{mode:0o600});
  return{icon:image,toastXml:toastXML(title,body,pathToFileURL(file).href)};
 };
}
module.exports={notificationAppearance,avatarBytes,toastXML};
