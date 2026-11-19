const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url'),{createHash}=require('node:crypto');
const {inspectImage}=require('../../../../shared/image.mjs');
const escapeXML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
function avatarBytes(value){
 if(typeof value!=='string'||value.length>12000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return;
 const bytes=Buffer.from(value.slice(value.indexOf(',')+1),'base64'),metadata=inspectImage(bytes);
 if(!metadata||metadata.width>512||metadata.height>512)return;
 return bytes;
}
function toastXML(title,body,uri){return `<toast><visual><binding template="ToastGeneric"><image placement="appLogoOverride" hint-crop="circle" src="${escapeXML(uri)}"/><text>${escapeXML(title)}</text><text>${escapeXML(body)}</text></binding></visual><audio silent="true"/></toast>`;}
function notificationAppearance({directory,nativeImage,platform=process.platform}){
 return async({avatar,title,body})=>{
  const bytes=avatarBytes(avatar);if(!bytes)return {};
  const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())return {};
  const png=image.resize({width:64,height:64}).toPNG();
  if(platform!=='win32')return{icon:image};
  await fs.mkdir(directory,{recursive:true});const file=path.join(directory,createHash('sha256').update(png).digest('hex')+'.png');await fs.writeFile(file,png,{mode:0o600});
  return{icon:image,toastXml:toastXML(title,body,pathToFileURL(file).href)};
 };
}
module.exports={notificationAppearance,avatarBytes,toastXML};
