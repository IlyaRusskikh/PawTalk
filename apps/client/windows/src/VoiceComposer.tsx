import {useEffect,useEffectEvent,useRef,useState} from 'react';
import {Icon} from './Controls';
import {VoicePlayer} from './VoicePlayer';
import {t} from './i18n';
export type VoiceDraft={file:File;duration:number;waveform:number[]};

export function VoiceComposer({onCancel,onSend,busy,sendDisabled,onRecordingChange}:{onCancel():void;onSend(value:VoiceDraft):void;busy:boolean;sendDisabled?:boolean;onRecordingChange?(recording:boolean):void}){
 const recorder=useRef<MediaRecorder>(null);
 const sendWhenStopped=useRef(false);
 const sendDraft=useEffectEvent(onSend);
 const [phase,setPhase]=useState<'starting'|'recording'|'stopping'|'ready'>('starting');
 const [samples,setSamples]=useState<number[]>([]),[sampleAt,setSampleAt]=useState(0),[elapsed,setElapsed]=useState(0);
 const [draft,setDraft]=useState<VoiceDraft>(),[url,setUrl]=useState(''),[error,setError]=useState('');
 useEffect(()=>{
  if(phase!=='recording'||!onRecordingChange)return;
  onRecordingChange(true);
  return()=>onRecordingChange(false);
 },[phase,onRecordingChange]);

 function finishRecording(send:boolean){
  const active=recorder.current;
  if(active?.state!=='recording')return;
  sendWhenStopped.current=send;
  setPhase('stopping');
  active.stop();
 }

 useEffect(()=>{
  let cancelled=false,failed=false;
  let previewUrl:string|undefined;
  let input:MediaStream|undefined,context:AudioContext|undefined,timer:ReturnType<typeof setInterval>|undefined;
  const history:number[]=[];
  const cleanup=()=>{
   clearInterval(timer);
   input?.getTracks().forEach(track=>track.stop());
   if(context&&context.state!=='closed')void context.close();
  };
  const recordingError=()=>t('Не удалось записать голосовое сообщение.');
  const fail=(message:string)=>{
   failed=true;
   cleanup();
   if(cancelled)return;
   setError(message);
   setPhase('ready');
  };
  void(async()=>{
   try{
    input=await navigator.mediaDevices.getUserMedia({audio:true});
    if(cancelled){cleanup();return;}
    context=new AudioContext();
    await context.resume();
    if(cancelled){cleanup();return;}
    const analyser=context.createAnalyser();
    analyser.fftSize=512;
    context.createMediaStreamSource(input).connect(analyser);
    const data=new Uint8Array(analyser.fftSize);
    const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));
    if(!mime)throw Error(recordingError());
    const next=new MediaRecorder(input,{mimeType:mime,audioBitsPerSecond:32000});
    const chunks:BlobPart[]=[];
    let size=0;
    const started=performance.now();
    recorder.current=next;
    next.ondataavailable=event=>{
     if(!event.data.size)return;
     chunks.push(event.data);
     size+=event.data.size;
     if(size>1900000&&next.state==='recording')next.stop();
    };
    next.onerror=()=>fail(recordingError());
    next.onstop=()=>{
     const duration=(performance.now()-started)/1000;
     cleanup();
     if(cancelled||failed)return;
     if(!size){
      setError(recordingError());
      setPhase('ready');
      return;
     }
     const waveform=Array.from({length:64},(_,i)=>{
      const start=Math.floor(i*history.length/64);
      const end=Math.max(start+1,Math.floor((i+1)*history.length/64));
      const values=history.slice(start,end);
      return values.length?Math.max(...values):0;
     });
     const type=mime.split(';')[0];
     const file=new File(chunks,type==='audio/ogg'?'voice.ogg':'voice.webm',{type});
     const recorded={file,duration,waveform};
     setDraft(recorded);
     previewUrl=URL.createObjectURL(file);
     setUrl(previewUrl);
     setPhase('ready');
     if(sendWhenStopped.current)sendDraft(recorded);
    };
    document.dispatchEvent(new CustomEvent('pawtalk-voice-play'));
    next.start(200);
    setPhase('recording');
    timer=setInterval(()=>{
     analyser.getByteTimeDomainData(data);
     const rms=Math.sqrt(data.reduce((sum,value)=>sum+((value-128)/128)**2,0)/data.length);
     history.push(rms<.008?0:Math.min(1,rms*5));
     setSamples([...history]);
     setSampleAt(performance.now());
     setElapsed((performance.now()-started)/1000);
    },80);
   }catch(e){fail((e as Error).message);}
  })();
  return()=>{
   cancelled=true;
   if(recorder.current?.state==='recording')recorder.current.stop();
   cleanup();
   if(previewUrl)URL.revokeObjectURL(previewUrl);
  };
 },[]);

 return <div className="voice-composer">
  <VoicePlayer compact disabled={!!error} url={url||undefined} duration={draft?.duration} waveform={draft?.waveform} recording={phase==='ready'?undefined:{
   values:samples,sampleAt,elapsed,starting:phase!=='recording',onStop:()=>finishRecording(false)
  }}/>
  <button type="button" className="icon-button" aria-label={t('Удалить запись')} disabled={busy||phase==='stopping'} onClick={onCancel}><Icon name="trash" size={19}/></button>
  <button type="button" className="icon-button voice-send" aria-label={t('Отправить')} disabled={busy||sendDisabled||!(phase==='recording'||draft)} onClick={()=>{
   if(draft)onSend(draft);
   else finishRecording(true);
  }}><Icon name="send" size={21}/></button>
  {error&&<span role="alert" className="text-error">{error}</span>}
 </div>;
}
