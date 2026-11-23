import {useEffect,useLayoutEffect,useMemo,useRef,useState,useId} from 'react';
import {Icon} from './Controls';
import {t} from './i18n';

let playbackContext:AudioContext|undefined;
const emptyWaveform: number[] = [];
export const voiceTime=(seconds:number)=>`${Math.floor(Math.max(0,seconds)/60)}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
function VoiceWave({values,progress,recording,sampleAt}:{values:number[];progress:number;recording:boolean;sampleAt?:number}) {
 const frame=useRef<HTMLSpanElement>(null),[width,setWidth]=useState(120);
 const count=Math.max(1,Math.ceil(width/6)),base=useRef<SVGGElement>(null),id=useId().replaceAll(':','');
 const barsId = `voice-wave-bars-${id}`, clipId = `voice-wave-clip-${id}`;
 useLayoutEffect(()=>{const node=frame.current;if(!node)return;const update=()=>setWidth(Math.max(6,node.clientWidth));update();const observer=new ResizeObserver(update);observer.observe(node);return()=>observer.disconnect();},[]);
 const samples=recording?emptyWaveform:values;
 const bars=useMemo(()=>Array.from({length:count+1},(_,i)=>{
  const start=Math.floor(i*samples.length/count),end=Math.min(samples.length,Math.max(start+1,Math.floor((i+1)*samples.length/count)));
  let amplitude=0;
  for(let j=start;j<end;j++)amplitude=Math.max(amplitude,samples[j]);
  const height=Math.max(2,Math.min(26,amplitude*26));
  return <rect key={i} x={i*6} y={(28-height)/2} width={2.5} height={height} rx={1.25}/>;
 }),[count,samples]);
 const latest=useRef({values,sampleAt});latest.current={values,sampleAt};
 useEffect(()=>{
  if(!recording)return;
  let raf=0,previous=performance.now(),heights=Array(count+1).fill(2),oldValues:number[]=[];const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const draw=(now:number)=>{const data=latest.current;const dt=Math.min(50,now-previous);previous=now;
   const offset=!reduced?6*Math.max(0,1-(now-(data.sampleAt??0))/80):0;
   const source=data.values;const rolling=source.slice(-(count+1));while(rolling.length<count+1)rolling.unshift(0);
   if(source!==oldValues){heights=[...heights.slice(1),2];oldValues=source;}
   for(let i=0;i<=count;i++){
    const target=Math.max(2,Math.min(26,(rolling[i]||0)*26));heights[i]+= (target-heights[i])*(reduced?1:1-Math.exp(-dt/55));
    const rect=base.current?.children[i];rect?.setAttribute('y',String((28-heights[i])/2));rect?.setAttribute('height',String(heights[i]));
   }
   base.current?.setAttribute('transform','translate('+offset+' 0)');
   raf=requestAnimationFrame(draw);
  };
  raf=requestAnimationFrame(draw);
  return()=>cancelAnimationFrame(raf);
 },[count,recording]);
 return <span ref={frame} className="voice-wave" aria-hidden="true"><svg viewBox={`0 0 ${width} 28`}>
  <g key={recording?'recording':'playback'} id={barsId} ref={base}>{bars}</g>
  {!recording && <>
   <defs><clipPath id={clipId}><rect x={0} y={0} width={Math.max(0,Math.min(1,progress))*width} height={28}/></clipPath></defs>
   <use href={`#${barsId}`} clipPath={`url(#${clipId})`} className="voice-wave-played"/>
  </>}
 </svg></span>;
}
export function VoicePlayer({url:source,load,duration:initial=0,waveform=emptyWaveform,compact=false,disabled=false,recording}:{url?:string;load?():Promise<string>;duration?:number;waveform?:number[];compact?:boolean;disabled?:boolean;recording?:{values:number[];sampleAt:number;elapsed:number;starting:boolean;onStop():void}}){
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
  <div className="voice-timeline"><VoiceWave values={recording?.values??waveform} recording={!!recording} sampleAt={recording?.sampleAt}
   progress={duration?time/duration:0}/><input type="range" min="0" max={duration||1} step="0.01" value={Math.min(time,duration||1)} aria-label={t('Позиция воспроизведения')} disabled={!!recording||disabled||!url||!duration} onChange={event=>{const value=Number(event.target.value);if(audio.current)audio.current.currentTime=value;setTime(value);}}/></div>
  <span className="voice-time">{recording&&<i className="voice-record-dot"/>}{voiceTime(recording?recording.elapsed:playing?Math.max(0,duration-time):time||duration)}</span>
  {!compact&&<><button type="button" className="voice-speed" aria-label={t('Скорость воспроизведения')} onClick={speed}>{rate}×</button><div className="voice-volume" onMouseEnter={()=>setVolumeOpen(true)} onMouseLeave={()=>setVolumeOpen(false)} onFocus={()=>setVolumeOpen(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setVolumeOpen(false);}}><button type="button" className="icon-button" aria-expanded={volumeOpen} aria-label={t('Громкость записи')}><Icon name="sound" size={20}/></button>{volumeOpen&&<label className="voice-volume-popover"><span className="sr-only">{t('Громкость записи')}</span><output>{Math.round(volume*100)}%</output><input aria-label={t('Громкость записи')} type="range" min="0" max="2" step="0.01" value={volume} onChange={event=>{const value=Number(event.target.value);setVolume(value);if(graph.current)graph.current.gain.gain.value=value;}}/></label>}</div></>}
  {error&&<span className="text-error" role="alert">{error}</span>}
 </div>;
}
