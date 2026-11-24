const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('pulseDesktop',Object.freeze({
 getUpdateState:()=>ipcRenderer.invoke('pulse:update-state'),
 checkForUpdates:()=>ipcRenderer.invoke('pulse:update-check'),
 installUpdate:()=>ipcRenderer.invoke('pulse:update-install'),
 onUpdateState:callback=>{
  if(typeof callback!=='function')throw new TypeError('callback required');
  const listener=(_event,state)=>callback(state);ipcRenderer.on('pulse:update-state',listener);
  return()=>ipcRenderer.removeListener('pulse:update-state',listener);
 }
}));
