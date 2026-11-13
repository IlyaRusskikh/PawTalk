// Synthetic management transport; renderer and Chromium controls are real.
const {contextBridge}=require('electron');
let view={state:'stopped',language:'ru',busy:null,version:'0.4.0',update:{status:'available',version:'0.5.0'}};
let values={PAWTALK_PUBLIC_IP:'203.0.113.10',PAWTALK_PORT:'18443',PAWTALK_E2EE:'false',PAWTALK_E2EE_KEY_ID:'',PAWTALK_CHAT_MAX_MB:'128',PAWTALK_SERVER_AUTO_UPDATE:'false',PAWTALK_MANAGER_AUTO_UPDATE:'false',PAWTALK_LANGUAGE:'ru',PAWTALK_UPDATE_PROXY:'true',PAWTALK_BACKUP_KEEP:'5'};
const listeners=new Set(),calls=[];let failure='',hold=false,holdAction='apply',release,startupBusy=1;
let serverUpdate={status:'idle'},backups=[{name:'backup-0123456789ab',created:1794448800}];
const emit=()=>listeners.forEach(fn=>fn({...view,operations:[...(view.busy?[view.busy]:[]),...(view.operations||[])]}));
const snapshot=()=>({values:{...values},serverVersion:'0.10.1',managerVersion:'0.4.0',update:view.update,serverUpdate,backups:backups.map(value=>({...value}))});
contextBridge.exposeInMainWorld('manager',{
 ready:()=>{},
 status:async()=>({...view,operations:[...(view.busy?[view.busy]:[]),...(view.operations||[])]}),
 language:async language=>{view.language=language;emit();},
 hideWindow:async()=>calls.push({action:'hide-window'}),
 onStatus:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 perform:async(action,payload={})=>{
  calls.push({action,payload});const checking=['check-updates','check-server-updates'].includes(action);if(checking)view.operations=[...(view.operations||[]),action];else view.busy=action;emit();
  try{
   if(hold&&action===holdAction){hold=false;await new Promise(resolve=>release=resolve);}
   if(failure){const code=failure;failure='';throw Error(code);}
   if(action==='snapshot'){if(startupBusy-->0)throw Error('busy');return snapshot();}
   if(action==='apply'){values={...values,...payload.values};return snapshot();}
   if(action==='start'||action==='stop'){view.state=action==='start'?'running':'stopped';return true;}
   if(action==='check-updates'){view.update={status:'available',version:'0.5.0'};return view.update;}
   if(action==='check-server-updates'){serverUpdate={status:'available',version:'0.10.2'};return serverUpdate;}
   if(action==='select-server-package')return {id:'a'.repeat(64),version:'0.10.1',sha256:'a'.repeat(64),verified:false,size:100};
   if(action==='install-server-package')return {...snapshot(),serverLocal:true};
   if(action==='install-manager-update'){view.update={status:'installing',version:'0.5.0'};return view.update;}
   if(action.startsWith('copy-')||action==='reset-password')return {copied:true};
   if(action==='backup-create'){if(!backups.length)backups.push({name:'backup-0123456789ab',created:1794448800});return {...snapshot(),name:'backup-0123456789ab'};}
   if(action==='backup-delete'){backups=backups.filter(value=>value.name!==payload.name);return snapshot();}
   if(action==='backup-restore'||action==='install-server-update')return snapshot();
   if(action==='diagnostics')return {running:view.state==='running',managerRunning:true,freeMiB:2048};
   if(action==='logs')return {text:'Synthetic server health check passed.'};
   throw Error('invalid');
  }finally{if(checking)view.operations=(view.operations||[]).filter(value=>value!==action);else view.busy=null;emit();}
 }
});
contextBridge.exposeInMainWorld('managerFixture',{
 calls:()=>calls,
 state:value=>{view={...view,...value};emit();},
 failNext:code=>failure=code,
 holdNext:(action='apply')=>{hold=true;holdAction=action;},
 release:()=>release?.(),
});
