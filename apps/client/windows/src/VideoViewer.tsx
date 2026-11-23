import {createPortal} from 'react-dom';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Icon} from './Controls';
import {Avatar} from './Avatar';
import {t} from './i18n';
import {voiceTime} from './VoicePlayer';
import {copyChatImage} from './chatImages';

export type VideoItem={id:string;name:string;load():Promise<string>;image?:boolean;downloadOriginal?():Promise<boolean | void>};
export function VideoViewer({items,initial=0,author,date,avatar,onClose,photoContent,photoStatus,photoCopy}:{photoContent?:ReactNode;photoStatus?:string;photoCopy?:{action():void;disabled:boolean};items:VideoItem[];initial?:number;author?:string;avatar?:string;date?:number;onClose():void}){
 const dialog=useRef<HTMLDialogElement>(null),root=useRef<HTMLDivElement>(null),video=useRef<HTMLVideoElement>(null),generation=useRef(0),timer=useRef<ReturnType<typeof setTimeout>>(undefined),lastExit=useRef(0);
 const graph=useRef<{context:AudioContext;source:MediaElementAudioSourceNode;gain:GainNode}|undefined>(undefined);
 const [index,setIndex]=useState(initial),[playing,setPlaying]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[time,setTime]=useState(0),[duration,setDuration]=useState(0),[volume,setVolume]=useState(1),[volumeOpen,setVolumeOpen]=useState(false),[visible,setVisible]=useState(true),[fullscreen,setFullscreen]=useState(false),[url,setUrl]=useState('');
 const item=items[index],photo=!!item?.image;
 const [savingOriginal,setSavingOriginal]=useState(false),[imageStatus,setImageStatus]=useState('');
 const photoStage=useRef<HTMLDivElement>(null),photoImage=useRef<HTMLImageElement>(null),pan=useRef<{x:number;y:number;left:number;top:number}|undefined>(undefined);
 const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0});
 function limit(point:{x:number;y:number},scale:number){const stage=photoStage.current,img=photoImage.current;if(!stage||!img)return{x:0,y:0};const fit=Math.min(stage.clientWidth/(img.naturalWidth||1),stage.clientHeight/(img.naturalHeight||1)),x=Math.max(0,(img.naturalWidth*fit*scale-stage.clientWidth)/2),y=Math.max(0,(img.naturalHeight*fit*scale-stage.clientHeight)/2);return{x:Math.max(-x,Math.min(x,point.x)),y:Math.max(-y,Math.min(y,point.y))};}
 function changeZoom(value:number){const scale=Math.max(1,Math.min(4,value));setZoom(scale);setOffset(previous=>limit(previous,scale));}
 useEffect(()=>{setZoom(1);setOffset({x:0,y:0});setImageStatus('');},[index]);
 useEffect(()=>{const stage=photoStage.current;if(!photo||photoContent||!stage)return;const wheel=(event:WheelEvent)=>{event.preventDefault();changeZoom(zoom+(event.deltaY<0?.25:-.25));};stage.addEventListener('wheel',wheel,{passive:false});return()=>stage.removeEventListener('wheel',wheel);},[photo,photoContent,zoom]);
 const current=useRef({playing,volumeOpen,items,onClose});current.current={playing,volumeOpen,items,onClose};
 function reveal(){setVisible(true);clearTimeout(timer.current);timer.current=setTimeout(()=>{if(current.current.playing&&!current.current.volumeOpen&&!(root.current?.contains(document.activeElement)&&document.activeElement?.matches('button,input,a')))setVisible(false);},2000);}
 useEffect(()=>{dialog.current?.showModal();root.current?.focus();const element=dialog.current;
  const changed=()=>{const active=document.fullscreenElement===root.current;setFullscreen(active);if(!active)lastExit.current=Date.now();reveal();};document.addEventListener('fullscreenchange',changed);
  const pauseVoice=(event:Event)=>{if((event as CustomEvent).detail!==video.current)video.current?.pause();};document.addEventListener('pawtalk-voice-play',pauseVoice);
  return()=>{generation.current++;clearTimeout(timer.current);video.current?.pause();graph.current?.source.disconnect();graph.current?.gain.disconnect();void graph.current?.context.close().catch(()=>{});element?.close();document.removeEventListener('fullscreenchange',changed);document.removeEventListener('pawtalk-voice-play',pauseVoice);if(root.current&&document.fullscreenElement===root.current)void document.exitFullscreen().catch(()=>{});};
 },[]);
 useEffect(()=>{
  if(photo){setPlaying(false);setVolumeOpen(false);setVisible(true);if(graph.current){graph.current.source.disconnect();graph.current.gain.disconnect();void graph.current.context.close().catch(()=>{});graph.current=undefined;}const request=++generation.current;setLoading(true);setError('');setUrl('');void item.load().then(value=>{if(request===generation.current)setUrl(value);}).catch(()=>{if(request===generation.current)setError(t('Не удалось загрузить. Повторить'));}).finally(()=>{if(request===generation.current)setLoading(false);});return()=>{generation.current++;};}
  const element=video.current;if(!element||!item)return;const request=++generation.current;element.pause();setTime(0);setDuration(0);setUrl('');setLoading(true);setError('');reveal();
  if(!graph.current){try{const context=new AudioContext(),source=context.createMediaElementSource(element),gain=context.createGain();source.connect(gain);gain.connect(context.destination);graph.current={context,source,gain};}catch{/* Native volume remains available up to 100% when Web Audio is unavailable. */}}
  if(graph.current){graph.current.gain.gain.value=volume;void graph.current.context.resume().catch(()=>{});}else element.volume=Math.min(1,volume);
  void item.load().then(async value=>{if(generation.current!==request)return;setUrl(value);element.src=value;await element.play();}).catch(()=>{if(generation.current===request)setError(t('Не удалось воспроизвести видео.'));}).finally(()=>{if(generation.current===request)setLoading(false);});
  return()=>{generation.current++;element.pause();};
 },[index,item?.id,photo]);
 useEffect(()=>{reveal();if(!playing)return;let frame=0;const tick=()=>{if(video.current)setTime(video.current.currentTime);frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[playing]);
 async function toggle(){const element=video.current;if(!element||loading)return;try{if(element.paused){await graph.current?.context.resume();await element.play();}else element.pause();}catch{setError(t('Не удалось воспроизвести видео.'));}reveal();}
 async function full(){try{if(document.fullscreenElement===root.current)await document.exitFullscreen();else await root.current?.requestFullscreen();}catch{setError(t('Не удалось открыть полный экран.'));}}
 function seek(value:number){if(video.current){video.current.currentTime=Math.max(0,Math.min(duration,value));setTime(video.current.currentTime);}reveal();}
 function move(next:number){if(next>=0&&next<items.length)setIndex(next);}
 async function saveOriginal(){
  if(!item?.downloadOriginal||savingOriginal)return;
  const request=generation.current;
  setSavingOriginal(true);
  if (photo) setImageStatus('');
  try {
   const saved = await item.downloadOriginal();
   if (saved === true && photo && request === generation.current) setImageStatus(t('Изображение сохранено'));
  }
  catch{if(request===generation.current)setError(t('Не удалось скачать оригинал.'));}
  finally{setSavingOriginal(false);}
 }
 async function copyPhoto() {
  const image = photoImage.current;
  if (!item || !image?.naturalWidth) return;
  const request = generation.current;
  try {
   await copyChatImage(image, item.name);
   if (request === generation.current) setImageStatus(t('Изображение скопировано'));
  } catch {
   if (request === generation.current) setImageStatus(t('Не удалось сохранить или скопировать изображение.'));
  }
 }
 function close(){if(document.fullscreenElement===root.current)void document.exitFullscreen().catch(()=>{}).finally(onClose);else onClose();}
 return createPortal(<dialog ref={dialog} className={`video-dialog${photo?' image-viewer':''}`} aria-label={t(photo?'Просмотр изображения':'Просмотр видео')} onCancel={event=>{event.preventDefault();if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});else if(Date.now()-lastExit.current>250)onClose();}}>
 <div ref={root} className={`video-viewer${photo?' photo-viewer':''}`} data-controls={visible||!playing||volumeOpen} onPointerMove={reveal} onPointerLeave={()=>{if(playing&&!volumeOpen)setVisible(false);}} onKeyDown={event=>{
  if(event.key==='Escape'){if(document.fullscreenElement){event.preventDefault();event.stopPropagation();void document.exitFullscreen().catch(()=>{});}return;}
  if((event.target as HTMLElement).matches('input,button,a'))return;
  if(event.key===' '){event.preventDefault();void toggle();}else if(event.key==='ArrowRight'){event.preventDefault();seek(time+5);}else if(event.key==='ArrowLeft'){event.preventDefault();seek(time-5);}
 }} onPointerUp={event=>{if((event.target as HTMLElement).closest('button'))((event.target as HTMLElement).closest('button') as HTMLButtonElement).blur();}} tabIndex={-1}>
  <header className={`video-viewer-header video-controls${photo?' modal-heading':''}`}><div className="video-credits">{author&&<Avatar name={author} image={avatar}/>}<div><strong>{author||item?.name}</strong>{date&&<time dateTime={new Date(date).toISOString()}>{new Date(date).toLocaleString()}</time>}</div></div><div className="video-viewer-actions">
   {item?.downloadOriginal
    ? <button type="button" className="icon-button" aria-label={t('Скачать оригинал')} title={t('Скачать оригинал')} disabled={savingOriginal} onClick={()=>void saveOriginal()}><Icon name="download"/></button>
    : <a className="icon-button" aria-label={t('Скачать')} title={t('Скачать')} href={url||undefined} download={item?.name} aria-disabled={!url} onClick={event=>{if(!url)event.preventDefault();}}><Icon name="download"/></a>}
   {photo&&(!photoContent||photoCopy)&&<button type="button" className="icon-button" aria-label={t('Копировать изображение')}
    title={t('Копировать изображение')} disabled={photoCopy?.disabled??!url} onClick={photoCopy?.action??(()=>void copyPhoto())}><Icon name="copy"/></button>}
   <button type="button" className="icon-button" aria-label={t('Закрыть')} onClick={close}><Icon name="close"/></button>
  </div></header>
  {(photoStatus || imageStatus) && <p className="image-action-toast viewer-image-status" role="status">{photoStatus || imageStatus}</p>}
  <div className="video-stage" onClick={event=>{if(event.target===event.currentTarget)close();}}>{photo?(photoContent||<div ref={photoStage} className="photo-zoom-stage" data-zoomed={zoom>1||undefined} onDoubleClick={()=>changeZoom(zoom>1?1:2)} onPointerDown={event=>{if(event.button!==0||zoom<=1)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);pan.current={x:event.clientX,y:event.clientY,left:offset.x,top:offset.y};}} onPointerMove={event=>{if(pan.current)setOffset(limit({x:pan.current.left+event.clientX-pan.current.x,y:pan.current.top+event.clientY-pan.current.y},zoom));}} onPointerUp={()=>{pan.current=undefined;}} onPointerCancel={()=>{pan.current=undefined;}}><img ref={photoImage} className="photo-viewer-image" src={url||undefined} alt={item.name} draggable={false} style={{transform:`translate(${offset.x}px,${offset.y}px) scale(${zoom})`}}/></div>):<video ref={video} playsInline preload="metadata" onClick={()=>{root.current?.focus();void toggle();}} onDoubleClick={()=>void full()} onPlay={()=>{setPlaying(true);document.dispatchEvent(new CustomEvent('pawtalk-voice-play',{detail:video.current}));}} onPause={()=>setPlaying(false)} onEnded={()=>{setPlaying(false);setVisible(true);}} onLoadedMetadata={event=>setDuration(Number.isFinite(event.currentTarget.duration)?event.currentTarget.duration:0)} onDurationChange={event=>{if(Number.isFinite(event.currentTarget.duration))setDuration(event.currentTarget.duration);}} onWaiting={()=>setLoading(true)} onCanPlay={()=>setLoading(false)} onTimeUpdate={event=>setTime(event.currentTarget.currentTime)} onError={()=>{setLoading(false);setError(t('Не удалось воспроизвести видео.'));}}/>}{loading&&<span className="video-loading" role="status">{t('Загрузка…')}</span>}{error&&<p className="video-error text-error" role="alert">{error}</p>}</div>
  {items.length>1&&<><button type="button" className="icon-button video-previous video-controls" disabled={!index} aria-label={t(photo?'Предыдущее изображение':'Предыдущее видео')} onClick={()=>move(index-1)}><Icon name="arrow-left"/></button><button type="button" className="icon-button video-next video-controls" disabled={index===items.length-1} aria-label={t(photo?'Следующее изображение':'Следующее видео')} onClick={()=>move(index+1)}><Icon name="arrow-right"/></button><span className="video-counter video-controls">{index+1} / {items.length}</span></>}
  <footer className="video-viewer-footer video-controls">{photo&&!photoContent&&<div className="photo-zoom-toolbar"><button type="button" className="icon-button" aria-label={t('Уменьшить')} disabled={zoom<=1} onClick={()=>changeZoom(zoom-.25)}><Icon name="zoom-out"/></button><button type="button" className="photo-zoom-fit" onClick={()=>changeZoom(1)}>{Math.round(zoom*100)}%</button><button type="button" className="icon-button" aria-label={t('Увеличить')} disabled={zoom>=4} onClick={()=>changeZoom(zoom+.25)}><Icon name="zoom-in"/></button></div>}{!photo&&<><button type="button" className="icon-button" aria-label={t(playing?'Пауза':'Воспроизвести')} disabled={loading} onClick={()=>void toggle()}><Icon name={playing?'pause':'play'}/></button><span className="video-time">{voiceTime(time)} / {voiceTime(duration)}</span><input className="video-timeline" type="range" min={0} max={duration||1} step="0.01" value={Math.min(time,duration||1)} disabled={!duration} aria-label={t('Позиция воспроизведения')} style={{'--media-progress':`${duration?time/duration*100:0}%`} as React.CSSProperties} onChange={event=>seek(Number(event.target.value))}/>
   <div className="voice-volume video-volume" onMouseEnter={()=>{setVolumeOpen(true);reveal();}} onMouseLeave={()=>{setVolumeOpen(false);reveal();}} onFocus={()=>setVolumeOpen(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setVolumeOpen(false);}}><button type="button" className="icon-button" aria-expanded={volumeOpen} aria-label={t('Громкость видео')} onClick={()=>{const value=volume?0:1;setVolume(value);if(graph.current)graph.current.gain.gain.value=value;else if(video.current)video.current.volume=value;}}><Icon name={volume?'sound':'sound-off'}/></button>{volumeOpen&&<label className="voice-volume-popover"><output>{Math.round(volume*100)}%</output><input type="range" min={0} max={2} step="0.01" value={volume} aria-label={t('Громкость видео')} onChange={event=>{const value=Number(event.target.value);setVolume(value);if(graph.current)graph.current.gain.gain.value=value;else if(video.current)video.current.volume=Math.min(1,value);}}/></label>}</div>
   </>}<button type="button" className="icon-button" aria-label={t(fullscreen?'Выйти из полного экрана':'Полный экран')} onClick={()=>void full()}><Icon name={fullscreen?'fullscreen-exit':'fullscreen'}/></button>
  </footer>
 </div></dialog>,document.body);
}
