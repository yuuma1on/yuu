const path=require('node:path');
const {spawn}=require('node:child_process');

// Unlike electron-updater.quitAndInstall (void), resolve only after Windows has
// actually created the child process. No shell or elevation fallback is used.
function launchNsisInstaller(filename,{restart=true,installDirectory,spawnProcess=spawn}={}){
 if(!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!=='.exe'||!path.isAbsolute(installDirectory||''))return Promise.reject(new Error('INVALID_INSTALLER_PATH'));
 const args=['--updated','/S'];
 if(restart)args.push('--force-run');
 args.push(`/D=${installDirectory}`);
 return new Promise((resolve,reject)=>{
  let child;
  try{
   child=spawnProcess(filename,args,{detached:true,stdio:'ignore',windowsHide:true,shell:false});
   child.once('error',reject);
   child.once('spawn',()=>{child.unref();resolve();});
  }catch(error){reject(error);}
 });
}
module.exports={launchNsisInstaller};
