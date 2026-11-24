const {EventEmitter}=require('node:events');
const {MANIFEST_URL,verifyEnvelope,verifyBytes,verifyUpdateInfo,verifyInstaller,fetchReleaseBytes}=require('./update-manifest.cjs');
class UpdateController extends EventEmitter{
 constructor({updater,publicKey,currentVersion,cacheRoot,supported,fetchBytes=fetchReleaseBytes,verifyFile=verifyInstaller}){
  super();Object.assign(this,{updater,publicKey,currentVersion,cacheRoot,fetchBytes,verifyFile});
  this.supported=supported;this.state={status:supported?'idle':'unsupported',appVersion:currentVersion};this.transaction=null;this.inFlight=null;this.installing=false;
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;
  updater.disableWebInstaller=true;updater.disableDifferentialDownload=true;
  updater.on('error',()=>{});
  updater.on('download-progress',event=>{if(this.state.status==='downloading'&&this.transaction)this.set({progress:Math.max(0,Math.min(100,Number(event.percent)||0))});});
 }
 getState(){return{...this.state};}
 set(update){this.state={...this.state,...update};this.emit('state',this.getState());return this.getState();}
 check(){
  if(this.inFlight)return this.inFlight;
  if(!this.supported||this.state.status==='ready'||this.installing)return Promise.resolve(this.getState());
  this.inFlight=this.performCheck().finally(()=>{this.inFlight=null;});return this.inFlight;
 }
 async performCheck(){
  this.transaction=null;this.set({status:'checking',availableVersion:undefined,progress:undefined});
  try{
   const envelope=await this.fetchBytes(MANIFEST_URL,{maxBytes:65536});
   const signed=verifyEnvelope(envelope,this.publicKey,{currentVersion:this.currentVersion});
   if(!signed.newer)return this.set({status:'upToDate'});
   const tx=Object.freeze({...signed});this.transaction=tx;
   const metadata=await this.fetchBytes(tx.feedUrl+'latest.yml',{maxBytes:65536});verifyBytes(metadata,tx.manifest.latestYml);
   this.updater.setFeedURL({provider:'generic',url:tx.feedUrl,channel:'latest',useMultipleRangeRequest:false});
   const result=await this.updater.checkForUpdates();
   if(this.transaction!==tx)throw new Error('UPDATE_TRANSACTION_CHANGED');
   verifyUpdateInfo(result?.updateInfo,tx.manifest);
   this.set({status:'available',availableVersion:tx.manifest.version});
   this.set({status:'downloading',progress:0});
   const paths=await this.updater.downloadUpdate();
   if(this.transaction!==tx||!Array.isArray(paths)||paths.length!==1)throw new Error('INVALID_UPDATE_DOWNLOAD');
   const filename=await this.verifyFile(paths[0],tx.manifest.installer,this.cacheRoot);
   this.transaction=Object.freeze({...tx,filename});
   return this.set({status:'ready',progress:100});
  }catch{
   this.transaction=null;return this.set({status:'error',progress:undefined,message:'更新を確認できませんでした。時間をおいて再試行してください。'});
  }
 }
 install(options={}){
  if(this.installFlight)return this.installFlight;
  this.installFlight=this.performInstall(options).finally(()=>{this.installFlight=null;});return this.installFlight;
 }
 async performInstall({restart=true}={}){
  if(!this.supported||this.state.status!=='ready'||this.installing||!this.transaction?.filename)throw new Error('UPDATE_NOT_READY');
  const tx=this.transaction;
  try{
   verifyEnvelope(tx.envelope,this.publicKey,{currentVersion:this.currentVersion});
   await this.verifyFile(tx.filename,tx.manifest.installer,this.cacheRoot);
   if(tx!==this.transaction)throw new Error('UPDATE_TRANSACTION_CHANGED');
   this.installing=true;this.updater.quitAndInstall(true,restart);
  }catch(error){this.installing=false;this.transaction=null;this.set({status:'error',message:'更新ファイルを確認できませんでした。もう一度更新を確認してください。'});throw error;}
 }
}
module.exports={UpdateController};
