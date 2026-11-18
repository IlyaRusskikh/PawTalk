function trayItems(view,strings,handlers){
 const pending=!!view.busy||['starting','stopping'].includes(view.state);
 const items=[{id:'status',label:strings.status+': '+(strings.states[view.state]||strings.states.unavailable),enabled:false},
  {type:'separator'},
  {id:'toggle',label:view.state==='running'?strings.stop:strings.start,enabled:!pending&&['running','stopped'].includes(view.state),click:()=>handlers.toggle(view.state==='running'?'stop':'start')},
  {id:'settings',label:strings.openSettings,click:handlers.show}];
 if(view.update?.status==='available')items.push({id:'update',label:strings.trayUpdate,enabled:!pending,click:handlers.update});
 items.push({type:'separator'},{id:'exit',label:strings.exitManager,enabled:!pending,click:handlers.exit},{id:'hide',label:strings.hideManager,click:handlers.hide});
 return items;
}
async function stopAndExit(stop,exit){await stop();await exit();}
module.exports={trayItems,stopAndExit};
