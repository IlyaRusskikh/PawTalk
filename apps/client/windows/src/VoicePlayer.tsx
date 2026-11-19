import {useEffect,useLayoutEffect,useRef,useState,useId} from 'react';
import {Icon} from './Controls';
import {t} from './i18n';

let playbackContext:AudioContext|undefined;
export const voiceTime=(seconds:number)=>`${Math.floor(Math.max(0,seconds)/60)}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
export function VoiceWave({values,progress=0,recording=false,sampleAt=0}:{values:number[];progress?:number;recording?:boolean;sampleAt?:number}){
 const frame=useRef<HTMLSpanElement>(null),base=useRef<SVGGElement>(null),played=useRef<SVGGElement>(null),clip=useRef<SVGRectElement>(null),id=useId().replaceAll(':','');
 const latest=useRef({values,progress,recording,sampleAt});latest.current={values,progress,recording,sampleAt};
 const wake=useRef<(()=>void)|undefined>(undefined);
 const [width,setWidth]=useState(120),count=Math.max(1,Math.ceil(width/6));
 useLayoutEffect(()=>{const node=frame.current;if(!node)return;const update=()=>setWidth(Math.max(6,node.clientWidth));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[]);
 useEffect(()=>{let raf=0,previous=performance.now(),heights=Array(count+1).fill(2),oldValues:number[]=[];const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const draw=(now:number)=>{raf=0;const data=latest.current;let moving=data.recording;const dt=Math.min(50,now-previous);previous=now;
   const offset=data.recording&&!reduced?6*Math.max(0,1-(now-data.sampleAt)/80):0;
   const source=data.values;const rolling=source.slice(-(count+1));while(rolling.length<count+1)rolling.unshift(0);
   if(data.recording&&source!==oldValues){heights=[...heights.slice(1),2];oldValues=source;}
   for(let i=0;i<=count;i++){let value=0;if(data.recording)value=rolling[i]||0;else{const start=Math.floor(i*source.length/count),end=Math.max(start+1,Math.floor((i+1)*source.length/count));for(let j=start;j<Math.min(end,source.length);j++)value=Math.max(value,source[j]);}
    const target=Math.max(2,Math.min(26,value*26));if(Math.abs(target-heights[i])>.02)moving=true;heights[i]+= (target-heights[i])*(reduced?1:1-Math.exp(-dt/55));
    for(const group of [base.current,played.current]){const rect=group?.children[i];rect?.setAttribute('y',String((28-heights[i])/2));rect?.setAttribute('height',String(heights[i]));}
   }
   base.current?.setAttribute('transform','translate('+offset+' 0)');played.current?.setAttribute('transform','translate('+offset+' 0)');clip.current?.setAttribute('width',String(data.recording?0:Math.max(0,Math.min(1,data.progress))*width));
   if(moving)schedule();
  };const schedule=()=>{if(!raf)raf=requestAnimationFrame(draw);};wake.current=schedule;schedule();return()=>{cancelAnimationFrame(raf);wake.current=undefined;};
 },[count,width]);
 useEffect(()=>wake.current?.(),[values,progress,recording,sampleAt]);
 const bars=Array.from({length:count+1},(_,i)=><rect key={i} x={i*6} y={13} width={2.5} height={2} rx={1.25}/>);
 return <span ref={frame} className="voice-wave" aria-hidden="true"><svg viewBox={`0 0 ${width} 28`}><defs><clipPath id={id}><rect ref={clip} x={0} y={0} width={0} height={28}/></clipPath></defs><g ref={base}>{bars}</g><g clipPath={`url(#${id})`} className="voice-wave-played"><g ref={played}>{bars}</g></g></svg></span>;
}
export function VoicePlayer({url:source,load,duration:initial=0,waveform=[],compact=false,disabled=false,recording}:{url?:string;load?():Promise<string>;duration?:number;waveform?:number[];compact?:boolean;disabled?:boolean;recording?:{values:number[];sampleAt:number;elapsed:number;starting:boolean;onStop():void}}){
 const audio=useRef<HTMLAudioElement>(null),alive=useRef(true),graph=useRef<{source:MediaElementAudioSourceNode;gain:GainNode}|undefined>(undefined);
 const [url,setUrl]=useState(source||''),[playing,setPlaying]=useState(false),[busy,setBusy]=useState(false),[time,setTime]=useState(0),[duration,setDuration]=useState(initial),[rate,setRate]=useState(1),[volume,setVolume]=useState(1),[volumeOpen,setVolumeOpen]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setDuration(initial);},[initial]);
 // Let the media element own src: React reapplying it after an async load can abort play().
 useEffect(()=>{if(source&&audio.current){audio.current.src=source;setUrl(source);}},[source]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;audio.current?.pause();graph.current?.source.disconnect();graph.current?.gain.disconnect();};},[]);
 useEffect(()=>{const pauseOther=(event:Event)=>{if((event as CustomEvent).detail!==audio.current)audio.current?.pause();};document.addEventListener('pawtalk-voice-play',pauseOther);return()=>document.removeEventListener('pawtalk-voice-play',pauseOther);},[]);
 useEffect(()=>{if(!playing)return;let frame=0;const update=()=>{if(audio.current)setTime(audio.current.currentTime);frame=requestAnimationFrame(update);};frame=requestAnimationFrame(update);return()=>cancelAnimationFrame(frame);},[playing]);
 async function toggle(){const element=audio.current;if(!element||busy||disabled)return;if(!element.paused){element.pause();return;}setError('');setBusy(true);try{let target=url;if(!target&&load){target=await load();if(!alive.current)return;setUrl(target);}if(!target)return;if(element.getAttribute('src')!==target)element.src=target;if(!playbackContext||playbackContext.state==='closed')playbackContext=new AudioContext();if(!graph.current){const source=playbackContext.createMediaElementSource(element),gain=playbackContext.createGain();source.connect(gain);gain.connect(playbackContext.destination);graph.current={source,gain};}graph.current.gain.gain.value=volume;await playbackContext.resume();element.playbackRate=rate;element.volume=1;if(element.ended)element.currentTime=0;await element.play();}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}}
 function speed(){const rates=[1,1.5,2,.75],next=rates[(rates.indexOf(rate)+1)%rates.length];setRate(next);if(audio.current)audio.current.playbackRate=next;}
 return <div className={`voice-player${compact?' voice-player-compact':''}`} onClick={event=>event.stopPropagation()}>
  <audio ref={audio} preload="metadata" onPlay={()=>{setPlaying(true);document.dispatchEvent(new CustomEvent('pawtalk-voice-play',{detail:audio.current}));}} onPause={()=>setPlaying(false)} onEnded={()=>{setPlaying(false);setTime(0);}} onLoadedMetadata={event=>{if(Number.isFinite(event.currentTarget.duration))setDuration(event.currentTarget.duration);}} onTimeUpdate={event=>setTime(event.currentTarget.currentTime)} onError={()=>{setPlaying(false);setBusy(false);setError(t('Не удалось воспроизвести запись.'));}}/>
  <button type="button" className={recording?'icon-button voice-stop':'voice-play'} disabled={busy||disabled||recording?.starting} aria-label={t(recording?'Остановить запись':playing?'Пауза':'Прослушать')} onClick={()=>recording?recording.onStop():void toggle()}>{recording?<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>:playing?<svg viewBox="0 0 24 24"><path d="M7 5h3v14H7zm7 0h3v14h-3z"/></svg>:<svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z"/></svg>}</button>
  <div className="voice-timeline"><VoiceWave values={recording?.values||waveform} recording={!!recording} sampleAt={recording?.sampleAt} progress={duration?time/duration:0}/><input type="range" min="0" max={duration||1} step="0.01" value={Math.min(time,duration||1)} aria-label={t('Позиция воспроизведения')} disabled={!!recording||disabled||!url||!duration} onChange={event=>{const value=Number(event.target.value);if(audio.current)audio.current.currentTime=value;setTime(value);}}/></div>
  <span className="voice-time">{recording&&<i className="voice-record-dot"/>}{voiceTime(recording?recording.elapsed:playing?Math.max(0,duration-time):time||duration)}</span>
  {!compact&&<><button type="button" className="voice-speed" aria-label={t('Скорость воспроизведения')} onClick={speed}>{rate}×</button><div className="voice-volume" onMouseEnter={()=>setVolumeOpen(true)} onMouseLeave={()=>setVolumeOpen(false)} onFocus={()=>setVolumeOpen(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setVolumeOpen(false);}}><button type="button" className="icon-button" aria-expanded={volumeOpen} aria-label={t('Громкость записи')}><Icon name="sound" size={20}/></button>{volumeOpen&&<label className="voice-volume-popover"><span className="sr-only">{t('Громкость записи')}</span><output>{Math.round(volume*100)}%</output><input aria-label={t('Громкость записи')} type="range" min="0" max="2" step="0.01" value={volume} onChange={event=>{const value=Number(event.target.value);setVolume(value);if(graph.current)graph.current.gain.gain.value=value;}}/></label>}</div></>}
  {error&&<span className="text-error" role="alert">{error}</span>}
 </div>;
}
