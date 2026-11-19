export function notificationAvatar(name:string,image?:string):string|undefined {
 if(image)return image;
 const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
 const context=canvas.getContext('2d');if(!context)return;
 const palette=getComputedStyle(document.documentElement);
 context.fillStyle=palette.getPropertyValue('--surface').trim()||'#242731';context.fillRect(0,0,128,128);
 context.globalAlpha=.25;context.fillStyle=palette.getPropertyValue('--accent').trim()||'#8e83ff';context.fillRect(0,0,128,128);context.globalAlpha=1;
 context.fillStyle=palette.getPropertyValue('--text').trim()||'#ffffff';context.font='600 64px system-ui';context.textAlign='center';context.textBaseline='middle';
 context.fillText(Array.from(name.trim())[0]?.toUpperCase()||'?',64,67);
 return canvas.toDataURL('image/png');
}
