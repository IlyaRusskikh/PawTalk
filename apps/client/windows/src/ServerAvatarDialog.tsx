import {useRef,useState} from 'react';
import {Avatar} from './Avatar';
import {AvatarEditor} from './AvatarEditor';
import {Modal} from './Modal';
import {membership,type ServerState} from './membership';
import {t} from './i18n';
export function ServerAvatarDialog({state,onClose,onSaved}:{state:ServerState;onClose():void;onSaved():void}){
 const [avatar,setAvatar]=useState<string|null>(state.avatar||null),[file,setFile]=useState<File>(),[busy,setBusy]=useState(false),[error,setError]=useState('');const picker=useRef<HTMLInputElement>(null);
 return <><Modal title={t('Аватар сервера')} onClose={()=>{if(!busy)onClose();}}><div className="form-fields"><div className="member-profile-preview"><Avatar name={state.name} image={avatar||undefined}/><button type="button" disabled={busy} onClick={()=>picker.current?.click()}>{t('Изменить аватар')}</button>{avatar&&<button type="button" disabled={busy} onClick={()=>setAvatar(null)}>{t('Удалить аватар')}</button>}</div><input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event=>{setFile(event.target.files?.[0]);event.target.value='';}}/></div>{error&&<p role="alert" className="text-error">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button><button type="button" className="primary" disabled={busy||avatar===(state.avatar||null)} onClick={()=>{setBusy(true);void membership('server.avatar',{serverId:state.serverId,avatar,expectedRevision:state.avatarRevision}).then(()=>{onSaved();onClose();}).catch(error=>setError(error.message)).finally(()=>setBusy(false));}}>{t('Сохранить')}</button></div></Modal>{file&&<AvatarEditor file={file} onClose={()=>setFile(undefined)} onSave={value=>{setAvatar(value);return true;}}/>}</>;
}
