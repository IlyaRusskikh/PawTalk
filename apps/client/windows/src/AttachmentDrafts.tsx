import {createPortal} from 'react-dom';
import {useState} from 'react';
import {Icon} from './Controls';
import {Modal} from './Modal';
import {t} from './i18n';
import {videoMime,type MediaDraft} from './mediaDraft';
import {VideoViewer} from './VideoViewer';

export function AttachmentDrafts({items,busy,onRemove,onRename}:{items:MediaDraft[];busy:boolean;onRemove(id:string):void;onRename(id:string,name:string):void}){
 const [view,setView]=useState<MediaDraft>(),[edit,setEdit]=useState<MediaDraft>(),[name,setName]=useState('');
 return <><div className="chat-attachment-drafts">{items.map(item=><div className="chat-attachment-card chat-attachment-draft member-compose-context" key={item.id}>
  <button className="attachment-thumbnail" type="button" aria-label={t('Предпросмотр')+' · '+item.file.name} onClick={()=>setView(item)}>{item.posterURL||item.file.type.startsWith('image/')?<img src={item.posterURL||item.url} alt={item.file.name}/>:<Icon name={videoMime(item.file.type)?'video':'download'} size={36}/>}</button>
  <span className="attachment-filename" title={item.file.name}>{item.file.name}</span>
  <div className="attachment-card-actions"><button type="button" className="icon-button" title={t('Предпросмотр')} aria-label={t('Предпросмотр')} onClick={()=>setView(item)}><Icon name="eye" size={18}/></button><button type="button" className="icon-button" disabled={busy} title={t('Редактировать')} aria-label={t('Редактировать')} onClick={()=>{setEdit(item);setName(item.file.name);}}><Icon name="edit" size={18}/></button><button type="button" className="icon-button danger-button" disabled={busy} title={t('Удалить вложение')} aria-label={t('Удалить вложение')} onClick={()=>onRemove(item.id)}><Icon name="trash" size={18}/></button></div>
 </div>)}</div>
 {view&&createPortal(((videoMime(view.file.type)||view.file.type.startsWith('image/'))?<VideoViewer items={items.filter(i=>videoMime(i.file.type)||i.file.type.startsWith('image/')).map(i=>({id:i.id,name:i.file.name,image:i.file.type.startsWith('image/'),load:async()=>i.url}))} initial={items.filter(i=>videoMime(i.file.type)||i.file.type.startsWith('image/')).findIndex(i=>i.id===view.id)} onClose={()=>setView(undefined)}/>:<Modal title={view.file.name} onClose={()=>setView(undefined)}>{view.file.type.startsWith('image/')?<img className="chat-gif-full" src={view.url} alt={view.file.name}/>:<p>{view.file.name}</p>}</Modal>),document.body)}
 {edit&&createPortal(<Modal title={t('Редактировать вложение')} onClose={()=>setEdit(undefined)}><form onSubmit={event=>{event.preventDefault();event.stopPropagation();if(name.trim()){onRename(edit.id,name.trim());setEdit(undefined);}}}><div className="form-fields"><label>{t('Имя файла')}<input autoFocus maxLength={255} value={name} onChange={event=>setName(event.target.value)}/></label></div><div className="modal-actions"><button type="button" onClick={()=>setEdit(undefined)}>{t('Отмена')}</button><button className="primary" disabled={!name.trim()}>{t('Сохранить')}</button></div></form></Modal>,document.body)}</>;
}
