const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('manager',{
  ready:()=>ipcRenderer.send('manager:ready'),
  status:()=>ipcRenderer.invoke('manager:status'),
  perform:async(action,payload)=>{const result=await ipcRenderer.invoke('manager:perform',action,payload);if(result.error)throw Error(result.error);return result.value;},
  language:value=>ipcRenderer.invoke('manager:language',value),
  hideWindow:()=>ipcRenderer.invoke('manager:hide-window'),
  onStatus:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('manager:status',listener);return()=>ipcRenderer.removeListener('manager:status',listener);},
});
