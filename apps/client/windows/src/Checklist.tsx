import {Icon} from './Controls';
import {useEffect,useRef,useState,useId} from 'react';
import {Modal} from './Modal';
import {MessageText} from './MessageText';
import {membership,effectiveProfile,type Message,type ServerState} from './membership';
import {t} from './i18n';

export function ChecklistItems({items,checked,disabled,onCheck}:{
 items:{id:string;text:string}[];checked:Record<string,boolean>;disabled:boolean;onCheck(id:string,checked:boolean):void;
}){
 return <>{items.map(item=><label className="checklist-item" key={item.id} data-checked={!!checked[item.id]}>
   <input type="checkbox" checked={!!checked[item.id]} disabled={disabled} onChange={event=>onCheck(item.id,event.target.checked)}/>
   <span><MessageText text={item.text}/></span>
 </label>)}</>;
}

export type ChecklistContent = {text:string;checklist:{everyone:boolean;items:{id:string;text:string}[]}};

export function ChecklistDialog({serverId,channelId,message,initialContent,onClose,onPosted,commit,canSubmit=true}:{
 serverId:string;channelId:string;message?:Message;onClose():void;onPosted():void;canSubmit?:boolean;
 initialContent?:ChecklistContent;
 commit?(content:ChecklistContent,operationId:string):Promise<void>;
}){
 const initial=initialContent??message?.content;
 const [title,setTitle]=useState(initial?.text||''),[everyone,setEveryone]=useState(initial?.checklist?.everyone??true);
 const [items,setItems]=useState(initial?.checklist?.items||[{id:crypto.randomUUID().replaceAll('-',''),text:''}]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const formId=useId();
 const pending=useRef<{signature:string;id:string} | undefined>(undefined);
 async function submit(){
  if(busy||!canSubmit)return;
  setBusy(true);setError('');
  try{
   const content={text:title.trim(),checklist:{everyone,items}},signature=JSON.stringify(content);
   if(pending.current?.signature!==signature)pending.current={signature,id:crypto.randomUUID().replaceAll('-','')};
   if(commit)await commit(content,pending.current.id);
   else await membership('send',{serverId,channelId,content,original:message,requestId:pending.current.id});
   onPosted();onClose();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 return <Modal title={t('Интерактивный список')} className="poll-dialog checklist-dialog" footer={<div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button><button form={formId} type="submit" className="primary" disabled={busy||!canSubmit||!title.trim()||items.some(item=>!item.text.trim())}>{t(initial?'Сохранить':'Отправить')}</button></div>} onClose={()=>{if(!busy)onClose();}}><form id={formId} onSubmit={e=>{e.preventDefault();void submit();}}><div className="form-fields"><label>{t('Название')}<input autoFocus value={title} maxLength={300} required disabled={busy} placeholder={t('Название списка')} onChange={e=>setTitle(e.target.value)}/><small className="poll-question-limit">{Array.from(title).length} / 300</small></label><fieldset disabled={busy} className="poll-options"><legend>{t('Пункты списка')}</legend><div className="form-fields">{items.map((item,i)=><div className="poll-option-field" key={item.id}><input aria-label={t('Пункт {0}',i+1)} placeholder={t('Пункт {0}',i+1)} required maxLength={300} value={item.text} onChange={e=>setItems(items.map(row=>row.id===item.id?{...row,text:e.target.value}:row))}/><button className="icon-button" type="button" disabled={items.length===1} aria-label={t('Удалить пункт')} onClick={()=>setItems(items.filter(row=>row.id!==item.id))}>×</button></div>)}<button type="button" className="poll-add-option" disabled={items.length>=100} onClick={()=>setItems([...items,{id:crypto.randomUUID().replaceAll('-',''),text:''}])}>+ {t('Добавить пункт')}</button></div></fieldset><label>{t('Кто может отмечать пункты')}<select disabled={busy} value={everyone?'all':'author'} onChange={e=>setEveryone(e.target.value==='all')}><option value="all">{t('Все участники')}</option><option value="author">{t('Только автор')}</option></select></label></div>{error&&<p className="text-error" role="alert">{error}</p>}</form></Modal>;
}

export function ChecklistCard({message,state,onEdit}:{message:Message;state:ServerState;onEdit():void}){
 const def=message.content.checklist!,own=effectiveProfile(state,message.authorProfileId)===state.self.effectiveProfileId;
 const [loaded,setLoaded]=useState(false);
 const [checked,setChecked]=useState<Record<string,boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const version=useRef(-1),refreshState=useRef<()=>Promise<void>>(async()=>{});
 function apply(data:{revision?:number;checked:Record<string,boolean>}){const next=data.revision??0;if(next<version.current||!data.checked)return;version.current=next;setChecked(data.checked);setLoaded(true);}
 useEffect(()=>{let disposed=false,pending=false;version.current=-1;setLoaded(false);
  const refresh=async()=>{if(pending)return;pending=true;try{const data=await membership<{revision?:number;checked:Record<string,boolean>}>('checklist.state',{serverId:state.serverId,messageId:message.id});if(!disposed)apply(data);}catch(e){if(!disposed)setError((e as Error).message);}finally{pending=false;}};refreshState.current=refresh;
  const off=window.desktop?.onMembershipServerEvent?.(event=>{if(event.serverId!==state.serverId)return;if(event.type==='resync'){void refresh();return;}for(const update of event.checklists||[])if(update.messageId===message.id)apply(update);});
  void refresh();const timer=state.eventsLive&&state.capabilities?.includes('checklist-events-v1')?undefined:setInterval(()=>void refresh(),3000);
  return()=>{disposed=true;clearInterval(timer);off?.();};
 },[state.serverId,message.id,message.editedAt,state.eventsLive,state.capabilities?.includes('checklist-events-v1')]);
 async function toggle(item:string,value:boolean){if(busy)return;setBusy(true);setError('');setChecked(old=>({...old,[item]:value}));try{const data=await membership<{revision?:number;checked:Record<string,boolean>}>('checklist.check',{serverId:state.serverId,messageId:message.id,item,checked:value,requestId:crypto.randomUUID().replaceAll('-','')});if(data?.checked)apply(data);else await refreshState.current();}catch(e){setError((e as Error).message);await refreshState.current();}finally{setBusy(false);}}
 return <div className="chat-checklist" aria-busy={!loaded||busy}><strong><MessageText text={message.content.text}/></strong><ChecklistItems items={def.items} checked={checked} disabled={!loaded||busy||!(def.everyone||own)} onCheck={toggle}/>{own&&<button type="button" className="checklist-edit icon-button" title={t('Редактировать')} aria-label={t('Редактировать')} onClick={onEdit}><Icon name="edit" size={16}/></button>}{error&&<p className="text-error" role="alert">{error}</p>}</div>;
}
