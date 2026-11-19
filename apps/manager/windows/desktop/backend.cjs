const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');

const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const ps = value => "'" + value.replaceAll("'", "''") + "'";
function elevate(file, args) {
  return new Promise((resolve, reject) => {
    const command = `Start-Process -FilePath ${ps(file)} -ArgumentList ${ps(args.map(quote).join(' '))} -Verb RunAs -WindowStyle Hidden`;
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',command], { windowsHide:true,timeout:120000 }, error => error ? reject(Object.assign(Error('permission'),{code:'permission'})) : resolve());
  });
}

class Broker {
  constructor(host, root, launch = elevate) { this.host=host;this.root=root;this.launch=launch;this.pending=new Map();this.next=0; }
  ensure() {
    if(this.socket && !this.socket.destroyed)return Promise.resolve();
    if(this.connecting)return this.connecting;
    this.connecting=new Promise((resolve,reject)=>{
      const pipe=String.raw`\\.\pipe\PawTalk.Manager.Broker.${randomBytes(32).toString('hex')}`,token=randomBytes(32).toString('hex');
      const timer=setTimeout(()=>{this.close();reject(Object.assign(Error('permission'),{code:'permission'}));},120000);
      this.server=net.createServer(socket=>{
        if(this.socket){socket.destroy();return;}
        let buffer='',authenticated=false;
        socket.setEncoding('utf8');
        socket.on('data',data=>{
          buffer+=data.toString('utf8');if(buffer.length>2*1024*1024){socket.destroy();return;}
          let index;
          while((index=buffer.indexOf('\n'))>=0){
            let response;try{response=JSON.parse(buffer.slice(0,index));}catch{socket.destroy();return;}buffer=buffer.slice(index+1);
            if(!authenticated){
              if(response.token!==token || this.socket){socket.destroy();return;}
              authenticated=true;this.socket=socket;clearTimeout(timer);resolve();continue;
            }
            const pending=this.pending.get(response.id);if(!pending)continue;this.pending.delete(response.id);clearTimeout(pending.timer);
            response.error?pending.reject(Object.assign(Error(response.error),{code:response.error})):pending.resolve(response.value);
          }
        });
        socket.on('error',()=>{});
        socket.once('close',()=>{if(this.socket===socket){this.socket=undefined;this.connecting=undefined;this.server?.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(Error('disconnected'),{code:'disconnected'}));}this.pending.clear();}});
      });
      this.server.once('error',error=>{clearTimeout(timer);this.connecting=undefined;reject(error);});
      this.server.listen(pipe,()=>{this.launch(this.host,['--desktop-broker',pipe,token,this.root]).catch(error=>{clearTimeout(timer);this.server?.close();this.connecting=undefined;reject(error);});});
    });
    return this.connecting;
  }
  async request(action,payload={}) {
    await this.ensure();
    return new Promise((resolve,reject)=>{
      const id=++this.next;
      const timer=setTimeout(()=>{this.pending.delete(id);this.close();reject(Object.assign(Error('timeout'),{code:'timeout'}));},190000);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.write(JSON.stringify({id,action,payload})+'\n');
    });
  }
  close(){this.socket?.destroy();this.server?.close();this.socket=undefined;this.connecting=undefined;}
}
module.exports={Broker,quote};
