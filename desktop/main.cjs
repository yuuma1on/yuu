const {app,BrowserWindow,protocol,net,ipcMain,Menu,shell,dialog}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {autoUpdater}=require('electron-updater');
const {UpdateController}=require('./update-controller.cjs');
const {launchNsisInstaller}=require('./installer-launch.cjs');
const {resolveSmokeOutput}=require('./smoke-output.cjs');
const {ORIGIN,trustedUrl,resolveAsset,permittedTjaFile,createTjaPermissions}=require('./asset-policy.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'pulse',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
const CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const updateSmoke=process.argv.includes('--update-smoke-test');
const smoke=updateSmoke||process.argv.includes('--smoke-test');
let mainWindow,updates,checkTimer,periodicTimer,quitFallback=false;
if(!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();}});
 app.whenReady().then(start).catch(error=>{if(smoke)finishSmoke({ok:false,error:error.message},1);else{console.error('PULSE startup failed:',error.message);app.exit(1);}});
}
function validSender(event){return mainWindow&&!mainWindow.isDestroyed()&&event.sender===mainWindow.webContents&&event.senderFrame===mainWindow.webContents.mainFrame&&trustedUrl(event.senderFrame?.url);}
function requireSender(event){if(!validSender(event))throw new Error('Untrusted application frame');}
async function start(){
 app.setAppUserModelId('app.pulse.rhythmstudio');
 const roots={web:path.join(app.getAppPath(),'web'),desktop:path.join(__dirname,'renderer')};
 protocol.handle('pulse',async request=>{
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
  const filename=resolveAsset(request.url,roots);if(!filename)return new Response('Not found',{status:404});
  const original=await net.fetch(pathToFileURL(filename).href);
  const headers=new Headers(original.headers);headers.set('Content-Security-Policy',CSP);headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');
  return new Response(request.method==='HEAD'?null:original.body,{status:original.status,headers});
 });
 mainWindow=new BrowserWindow({width:1440,height:960,minWidth:390,minHeight:650,show:!smoke,backgroundColor:'#f8f7f4',title:'PULSE',icon:path.join(app.getAppPath(),'assets','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,spellcheck:false,backgroundThrottling:!smoke}});
 const wc=mainWindow.webContents,ses=wc.session;
 const filePermissions=createTjaPermissions();
 const safePermission=(contents,permission,origin,details)=>contents===wc&&trustedUrl(wc.getURL())&&permittedTjaFile(permission,origin,details);
 ses.setPermissionCheckHandler((contents,permission,origin,details)=>safePermission(contents,permission,origin,details)&&filePermissions.check(permission,origin,details));
 ses.setPermissionRequestHandler((contents,permission,callback,details)=>{
  const permitted=safePermission(contents,permission,details.requestingUrl||details.requestingOrigin||wc.getURL(),details);
  if(!permitted)return callback(false);
  if(details.fileAccessType==='readable')return callback(true);
  const origin=details.requestingUrl||details.requestingOrigin||wc.getURL();
  dialog.showMessageBox(mainWindow,{type:'question',title:'譜面の保存',message:'選択したTJAファイルへの保存を許可しますか？',detail:path.basename(details.filePath),buttons:['許可','キャンセル'],defaultId:1,cancelId:1}).then(r=>callback(r.response===0&&filePermissions.grantWrite(permission,origin,details))).catch(()=>callback(false));
 });
 ses.on('file-system-access-restricted',(_event,_details,callback)=>callback('deny'));
 ses.on('will-download',(event,item,contents)=>{
  if(contents!==wc||!trustedUrl(wc.getURL())||!item.getURL().startsWith('blob:'+ORIGIN+'/'))return event.preventDefault();
  const name=path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  item.setSaveDialogOptions({title:'解析結果・譜面を保存',defaultPath:path.join(app.getPath('downloads'),name),buttonLabel:'保存'});
 });
 wc.setWindowOpenHandler(()=>({action:'deny'}));
 wc.on('will-navigate',(event,url)=>{if(!trustedUrl(url)||new URL(url).pathname!=='/index.html')event.preventDefault();});
 wc.on('will-attach-webview',event=>event.preventDefault());
 wc.on('did-start-navigation',(_event,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)filePermissions.clear();});
 autoUpdater.logger={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}};
 const cacheBase=process.platform==='win32'?(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local')):(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'));
 updates=new UpdateController({updater:autoUpdater,publicKey:fs.readFileSync(path.join(__dirname,'update-public-key.pem')),currentVersion:app.getVersion(),cacheRoot:path.join(cacheBase,'pulse-rhythm-desktop-updater'),supported:process.platform==='win32'&&process.arch==='x64'&&app.isPackaged,launchInstaller:(filename,options)=>launchNsisInstaller(filename,{...options,installDirectory:path.dirname(app.getPath('exe'))})});
 updates.on('state',state=>{if(!wc.isDestroyed())wc.send('pulse:update-state',state);});
 ipcMain.handle('pulse:update-state',event=>{requireSender(event);return updates.getState();});
 ipcMain.handle('pulse:update-check',event=>{requireSender(event);return updates.check();});
 ipcMain.handle('pulse:update-install',async event=>{requireSender(event);await updates.install({restart:true});app.quit();});
 Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'ファイル',submenu:[{label:'ダウンロードフォルダーを開く',accelerator:'Ctrl+J',click:()=>shell.openPath(app.getPath('downloads'))},{type:'separator'},{label:'終了',accelerator:'Alt+F4',click:()=>app.quit()}]},
  {label:'編集',submenu:[{role:'undo',label:'元に戻す'},{role:'redo',label:'やり直す'},{type:'separator'},{role:'cut',label:'切り取り'},{role:'copy',label:'コピー'},{role:'paste',label:'貼り付け'},{role:'selectAll',label:'すべて選択'}]},
  {label:'表示',submenu:[{role:'resetZoom',label:'元の大きさ'},{role:'zoomIn',label:'拡大'},{role:'zoomOut',label:'縮小'},{role:'togglefullscreen',label:'全画面'}]},
  {label:'ヘルプ',submenu:[{label:'更新を確認',click:()=>updates.check()},{label:'配布ページを開く',click:()=>shell.openExternal('https://github.com/yuuma1on/yuu/releases')},{label:'PULSEについて',click:()=>dialog.showMessageBox(mainWindow,{type:'info',title:'PULSE',message:`PULSE ${app.getVersion()}`,detail:'音源を端末内で解析します。BPMと拍子は推定候補です。'})}]}
 ]));
 if(smoke)wc.once('did-finish-load',()=>Promise.resolve().then(()=>updateSmoke?runUpdateSmoke():runSmoke()).catch(error=>finishSmoke({ok:false,error:error.message},1)));
 await mainWindow.loadURL(ORIGIN+'/index.html');
 if(!smoke){checkTimer=setTimeout(()=>updates.check(),10000);periodicTimer=setInterval(()=>updates.check(),6*60*60*1000);}
}
async function runSmoke(){
 const result=await mainWindow.webContents.executeJavaScript(`(async()=>{
  const basic={nodeAvailable:typeof process!=='undefined',secureContext:window.isSecureContext,workerAvailable:typeof Worker==='function',desktopBridge:typeof window.pulseDesktop?.getUpdateState==='function'};
  const state=await window.pulseDesktop.getUpdateState();
  const button=document.getElementById('demoBtn');if(!button)throw new Error('Demo control missing');button.click();
  for(let i=0;i<300;i++){
   await new Promise(r=>setTimeout(r,100));
   if(!document.getElementById('results').hidden&&!button.disabled){const bpm=Number(document.getElementById('bpmValue').textContent);return {...basic,appVersion:state.appVersion,bpm,ok:!basic.nodeAvailable&&basic.secureContext&&basic.workerAvailable&&basic.desktopBridge&&Math.abs(bpm-120)<.05};}
  }throw new Error('Audio analysis smoke timed out');
 })()`);
 finishSmoke(result,result.ok?0:1);
}
function finishSmoke(result,code){
 try{writeSmoke(result);}catch(error){console.error(error.message);code=1;}
 app.exit(code);
}
function writeSmoke(result){
  console.log(JSON.stringify(result));
  const arg=process.argv.find(v=>v.startsWith('--smoke-output='));
  if(arg){const output=resolveSmokeOutput(arg.slice('--smoke-output='.length),[app.getPath('temp'),os.tmpdir(),process.env.RUNNER_TEMP]);fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});}
}
async function runUpdateSmoke(){
 const state=await updates.check();
 if(state.status!=='ready')throw new Error('Authenticated update did not become ready: '+state.status);
 const installed=await updates.install({restart:false});
 writeSmoke({ok:true,fromVersion:app.getVersion(),targetVersion:installed.version,authenticated:true,installerLaunched:installed.installerLaunched});
 app.quit();
}
app.on('before-quit',event=>{
 if(!smoke&&!quitFallback&&updates?.getState().status==='ready'&&!updates.installing){event.preventDefault();updates.install({restart:false}).then(()=>app.quit()).catch(()=>{quitFallback=true;app.quit();});}
 clearTimeout(checkTimer);clearInterval(periodicTimer);
});
app.on('window-all-closed',()=>app.quit());
