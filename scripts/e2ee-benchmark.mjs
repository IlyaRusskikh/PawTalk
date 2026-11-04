import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const folder = await mkdtemp(path.join(os.tmpdir(), 'voicecord-e2ee-'));
const wav = path.join(folder, 'markers.wav');
// Continuous voiced synthetic signal with a raised marker every 1.13 seconds.
// Continuous floor avoids measuring only Opus silence/DTX. No personal recording.
const rate = 48000, samples = rate * 24;
const buffer = Buffer.alloc(44 + samples*2);
buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length-8,4); buffer.write('WAVEfmt ',8);
buffer.writeUInt32LE(16,16); buffer.writeUInt16LE(1,20); buffer.writeUInt16LE(1,22);
buffer.writeUInt32LE(rate,24); buffer.writeUInt32LE(rate*2,28); buffer.writeUInt16LE(2,32); buffer.writeUInt16LE(16,34);
buffer.write('data',36); buffer.writeUInt32LE(samples*2,40);
for (let i=0;i<samples;i++) {
  const t=i/rate, phase=t%1.13, pulse=phase>.25 && phase<.39 ? Math.min(1,(phase-.25)/.01,(.39-phase)/.01) : 0;
  const value=(.035+.25*pulse)*(Math.sin(2*Math.PI*233*t)+.5*Math.sin(2*Math.PI*467*t)+.3*Math.sin(2*Math.PI*937*t))/1.8;
  buffer.writeInt16LE(Math.round(value*32767),44+i*2);
}
await writeFile(wav,buffer);
function run(command,args,env=process.env) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,windowsHide:true,stdio:'inherit'});
    child.once('error',reject); child.once('close',code=>code===0?resolve():reject(Error(`${command} exited ${code}`)));
  });
}
let vite;
try {
  if (process.platform === 'win32' && !process.argv.includes('--security-only')) {
    const script = path.join(folder,'synthesize.ps1');
    await writeFile(script,`param([string]$OutputFile)
$ErrorActionPreference='Stop'
$voice=New-Object -ComObject SAPI.SpVoice
foreach($installed in $voice.GetVoices()){if($installed.GetDescription().Contains('Zira')){$voice.Voice=$installed;break}}
$stream=New-Object -ComObject SAPI.SpFileStream
$stream.Format.Type=38
$stream.Open($OutputFile,3,$false)
try {
 $voice.AudioOutputStream=$stream
 $voice.Rate=1
 $text='This is a local test of a private voice connection. We compare the same speech with encryption enabled and disabled. The quick brown fox jumps over the lazy dog. Every participant should hear a clear voice while the server forwards the packets. '
 $null=$voice.Speak($text+$text+$text+$text)
} finally {$stream.Close()}
`);
    await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-OutputFile',wav]);
  }
  await run(process.execPath,['scripts/prepare-server.mjs']);
  await run('docker',['build','-f','server/standalone.Dockerfile','-t','voicecord-server:local','.']);
  vite=await createServer({server:{host:'127.0.0.1',port:5194,strictPort:true}}); await vite.listen();
  const audioFile=process.argv.find(a=>a.startsWith('--audio-file='))?.slice('--audio-file='.length);
  const env={...process.env,VOICECORD_BENCH_WAV:audioFile?path.resolve(audioFile):wav,VOICECORD_BENCH_SOURCE:audioFile?'provided WAV':process.platform==='win32'?'locally synthesized SAPI speech':'synthetic tones'}; delete env.ELECTRON_RUN_AS_NODE;
  await run(require('electron'),['tests/e2ee-benchmark.cjs',...process.argv.slice(2)],env);
  if (!process.argv.includes('--security-only') && !process.argv.includes('--latency')) await run(process.execPath,['scripts/summarize-e2ee.mjs']);
} finally {
  await vite?.close();
  if (path.dirname(folder)===os.tmpdir() && path.basename(folder).startsWith('voicecord-e2ee-')) await rm(folder,{recursive:true,force:true});
}
