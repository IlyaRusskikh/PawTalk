import type {Message} from './membership';

type Block={messages:Message[]};
const ordered=(messages:Message[])=>[...new Map(messages.map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);

// Blocks represent verified contiguous history pages. Disjoint reply jumps stay
// cached without pretending the unrequested gap between them has been loaded.
export class ChatHistory {
  blocks:Block[]=[];
  active:Block={messages:[]};
  get messages(){return this.active.messages;}
  get all(){return this.blocks.flatMap(block=>block.messages);}
  find(id:number){return this.blocks.find(block=>block.messages.some(message=>message.id===id));}
  activate(id:number){const block=this.find(id);if(!block)return;this.active=block;return block.messages;}
  latest(last:number){return last?this.activate(last):undefined;}
  page(messages:Message[],connect=false){
    if(!messages.length)return this.active.messages;
    let rows=ordered(messages),joined=new Set<Block>();
    if(connect&&this.active.messages.length){joined.add(this.active);rows=ordered([...this.active.messages,...rows]);}
    let changed=true;
    while(changed){changed=false;for(const block of this.blocks){if(joined.has(block)||!block.messages.length)continue;
      if(block.messages[0].id<=rows.at(-1)!.id&&block.messages.at(-1)!.id>=rows[0].id){joined.add(block);rows=ordered([...block.messages,...rows]);changed=true;}
    }}
    this.active={messages:rows};this.blocks=[...this.blocks.filter(block=>!joined.has(block)),this.active].sort((a,b)=>a.messages[0].id-b.messages[0].id);
    return rows;
  }
  update(messages:Message[],deleted:number[]=[],previousLast?:number){
    const updates=new Map(messages.map(m=>[m.id,m])),removed=new Set(deleted),tail=previousLast===undefined?undefined:this.find(previousLast);
    for(const block of this.blocks)block.messages=block.messages.filter(m=>!removed.has(m.id)).map(m=>updates.get(m.id)||m);
    const fresh=previousLast===undefined?[]:messages.filter(m=>m.id>previousLast&&!removed.has(m.id));
    if(fresh.length){if(tail)tail.messages=ordered([...tail.messages,...fresh]);else{const block={messages:ordered(fresh)};this.blocks.push(block);if(!this.active.messages.length)this.active=block;}}
    this.blocks=this.blocks.filter(block=>block.messages.length);
    return this.active.messages;
  }
  // Used only after a real memory-pressure signal, keeping the current viewport.
  trim(anchor:number,count:number){
    const rows=this.active.messages,index=Math.max(0,rows.findIndex(m=>m.id>=anchor)),start=Math.min(Math.max(0,index-Math.floor(count/2)),Math.max(0,rows.length-count));
    this.active={messages:rows.slice(start,start+count)};this.blocks=this.active.messages.length?[this.active]:[];return this.active.messages;
  }
  clear(){this.blocks=[];this.active={messages:[]};}
}
