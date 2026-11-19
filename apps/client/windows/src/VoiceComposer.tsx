import {useEffect,useRef,useState} from 'react';
import {Icon} from './Controls';
import {VoicePlayer} from './VoicePlayer';
import {t} from './i18n';
export type VoiceDraft={file:File;duration:number;waveform:number[]};

export function VoiceComposer({onCancel,onSend,busy}:{onCancel():void;onSend(value:VoiceDraft):void;busy:boolean}){
 const recorder=useRef<MediaRecorder|undefined>(undefined),stop=useRef(false);
 const [phase,setPhase]=useState<'starting'|'recording'|'ready'>('starting'),[samples,setSamples]=useState<number[]>([]),[sampleAt,setSampleAt]=useState(0),[elapsed,setElapsed]=useState(0),[draft,setDraft]=useState<VoiceDraft>(),[url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let cancelled=false,input:MediaStream|undefined,context:AudioContext|undefined,timer:ReturnType<typeof setInterval>|undefined;const history:number[]=[];
  const cleanup=()=>{clearInterval(timer);input?.getTracks().forEach(track=>track.stop());if(context&&context.state!=='closed')void context.close();};
  void(async()=>{try{input=await navigator.mediaDevices.getUserMedia({audio:true});if(cancelled){cleanup();return;}context=new AudioContext();await context.resume();if(cancelled){cleanup();return;}const analyser=context.createAnalyser();analyser.fftSize=512;context.createMediaStreamSource(input).connect(analyser);const data=new Uint8Array(analyser.fftSize);
   const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));if(!mime)throw Error(t('Не удалось записать голосовое сообщение.'));
   const next=new MediaRecorder(input,{mimeType:mime,audioBitsPerSecond:32000}),chunks:BlobPart[]=[];let size=0;const started=performance.now();recorder.current=next;
   next.ondataavailable=event=>{if(event.data.size){chunks.push(event.data);size+=event.data.size;if(size>1900000&&next.state==='recording')next.stop();}};
   next.onerror=()=>{if(!cancelled)setError(t('Не удалось записать голосовое сообщение.'));cleanup();};
   next.onstop=()=>{const duration=(performance.now()-started)/1000;cleanup();if(cancelled)return;const waveform=Array.from({length:64},(_,i)=>{const values=history.slice(Math.floor(i*history.length/64),Math.max(Math.floor((i+1)*history.length/64),Math.floor(i*history.length/64)+1));return values.length?Math.max(...values):0;});const type=mime.split(';')[0],file=new File(chunks,'voice.'+(type==='audio/ogg'?'ogg':'webm'),{type});setDraft({file,duration,waveform});setUrl(URL.createObjectURL(file));setPhase('ready');};
   document.dispatchEvent(new CustomEvent('pawtalk-voice-play'));next.start(200);setPhase('recording');timer=setInterval(()=>{analyser.getByteTimeDomainData(data);const rms=Math.sqrt(data.reduce((sum,value)=>sum+((value-128)/128)**2,0)/data.length);history.push(rms<.008?0:Math.min(1,rms*5));setSamples([...history]);setSampleAt(performance.now());setElapsed((performance.now()-started)/1000);if(stop.current&&next.state==='recording')next.stop();},80);
  }catch(e){cleanup();if(!cancelled)setError((e as Error).message);}})();
  return()=>{cancelled=true;if(recorder.current?.state==='recording')recorder.current.stop();cleanup();};
 },[]);
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
 return <div className="voice-composer"><VoicePlayer compact url={url||undefined} duration={draft?.duration} waveform={draft?.waveform} recording={phase==='ready'?undefined:{values:samples,sampleAt,elapsed,starting:phase==='starting',onStop:()=>{stop.current=true;if(recorder.current?.state==='recording')recorder.current.stop();}}}/>
 <button type="button" className="icon-button" aria-label={t('Удалить запись')} disabled={busy} onClick={onCancel}><Icon name="trash" size={19}/></button><button type="button" className="icon-button voice-send" aria-label={t('Отправить')} disabled={busy||!draft||!draft.file.size} onClick={()=>draft&&onSend(draft)}><Icon name="send" size={21}/></button>{error&&<span role="alert" className="text-error">{error}</span>}</div>;
}
