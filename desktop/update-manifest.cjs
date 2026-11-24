const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const semver=require('semver');
const APP_ID='app.pulse.rhythmstudio';
const REPOSITORY='yuuma1on/yuu';
const MANIFEST_URL=`https://github.com/${REPOSITORY}/releases/latest/download/pulse-update.json`;
const digest=data=>crypto.createHash('sha512').update(data).digest('base64');
function fail(code){const error=new Error(code);error.code=code;throw error;}
function base64(value,bytes){
 if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail('INVALID_BASE64');
 const b=Buffer.from(value,'base64');if(b.toString('base64')!==value||(bytes&&b.length!==bytes))fail('INVALID_BASE64');return b;
}
function stable(value){return typeof value==='string'&&value.length<48&&/^\d+\.\d+\.\d+$/.test(value)&&semver.valid(value)===value;}
function verifyEnvelope(raw,publicKey,{currentVersion,arch='x64',now=Date.now()}={}){
 const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
 if(bytes.length>65536)fail('MANIFEST_TOO_LARGE');
 let envelope,payload;try{envelope=JSON.parse(bytes.toString('utf8'));}catch{fail('INVALID_ENVELOPE');}
 const data=base64(envelope?.payload),signature=base64(envelope?.signature,64);
 try{if(!crypto.verify(null,data,publicKey,signature))fail('INVALID_SIGNATURE');}catch(error){if(error.code==='INVALID_SIGNATURE')throw error;fail('INVALID_SIGNATURE');}
 try{payload=JSON.parse(data.toString('utf8'));}catch{fail('INVALID_PAYLOAD');}
 const m=payload;
 if(m.schemaVersion!==1||m.appId!==APP_ID||m.repository!==REPOSITORY||m.channel!=='stable'||m.platform!=='win32'||m.arch!==arch)fail('WRONG_UPDATE_TARGET');
 if(!stable(m.version)||!stable(currentVersion))fail('INVALID_VERSION');
 const published=Date.parse(m.publishedAt);if(!Number.isFinite(published)||published>now+86400000)fail('INVALID_PUBLICATION_TIME');
 const expectedName=`PULSE-Setup-${m.version}-${arch}.exe`,expectedBase=`https://github.com/${REPOSITORY}/releases/download/v${m.version}/`;
 if(m.installer?.name!==expectedName||m.installer.url!==expectedBase+expectedName||m.latestYml?.name!=='latest.yml')fail('INVALID_ARTIFACT_URL');
 for(const artifact of[m.installer,m.latestYml]){
  if(!Number.isSafeInteger(artifact.size)||artifact.size<=0||artifact.size>(artifact===m.installer?1024**3:65536))fail('INVALID_ARTIFACT_SIZE');
  base64(artifact.sha512,64);
 }
 Object.freeze(m.installer);Object.freeze(m.latestYml);Object.freeze(m);
 return{manifest:m,newer:semver.gt(m.version,currentVersion),feedUrl:expectedBase,envelope:Buffer.from(bytes)};
}
function verifyBytes(data,artifact){if(data.length!==artifact.size||digest(data)!==artifact.sha512)fail('ARTIFACT_HASH_MISMATCH');}
function verifyUpdateInfo(info,manifest){
 if(!info||info.version!==manifest.version||info.packages||!Array.isArray(info.files)||info.files.length!==1)fail('UNSIGNED_UPDATE_METADATA');
 const file=info.files[0],expected=manifest.installer;
 if(file.url!==expected.name||file.sha512!==expected.sha512||file.size!==expected.size)fail('UNSIGNED_UPDATE_METADATA');
 if(file.isAdminRightsRequired||file.packageInfo||Object.keys(file).some(key=>!['url','sha512','size','blockMapSize','isAdminRightsRequired'].includes(key)))fail('UNSIGNED_UPDATE_METADATA');
 if(info.path!==undefined&&info.path!==expected.name)fail('UNSIGNED_UPDATE_METADATA');
 if(info.sha512!==undefined&&info.sha512!==expected.sha512)fail('UNSIGNED_UPDATE_METADATA');
 return true;
}
async function verifyInstaller(filename,artifact,cacheRoot){
 if(typeof filename!=='string'||!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!=='.exe')fail('INVALID_INSTALLER_PATH');
 const realRoot=await fs.promises.realpath(cacheRoot),real=await fs.promises.realpath(filename),relative=path.relative(realRoot,real);
 if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('INSTALLER_OUTSIDE_CACHE');
 if((await fs.promises.lstat(filename)).isSymbolicLink())fail('INSTALLER_SYMLINK');
 const handle=await fs.promises.open(real,'r');
 try{
  const before=await handle.stat();if(!before.isFile()||before.size!==artifact.size)fail('ARTIFACT_HASH_MISMATCH');
  const hash=crypto.createHash('sha512');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
  const after=await handle.stat();
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash.digest('base64')!==artifact.sha512)fail('ARTIFACT_HASH_MISMATCH');
 }finally{await handle.close();}
 return real;
}
async function fetchReleaseBytes(url,{maxBytes=65536,fetchImpl=fetch,timeoutMs=15000}={}){
 let current=url;
 for(let hop=0;hop<6;hop++){
  const parsed=new URL(current);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname))fail('UNTRUSTED_REDIRECT');
  const response=await fetchImpl(current,{redirect:'manual',signal:AbortSignal.timeout(timeoutMs),headers:{'User-Agent':'PULSE-Desktop','Accept':'application/octet-stream'}});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');if(!location)fail('INVALID_REDIRECT');await response.body?.cancel();current=new URL(location,current).href;continue;
  }
  if(!response.ok)fail('UPDATE_SERVER_UNAVAILABLE');
  const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>maxBytes)fail('DOWNLOAD_TOO_LARGE');
  const chunks=[];let size=0;for await(const part of response.body){size+=part.length;if(size>maxBytes){await response.body.cancel().catch(()=>{});fail('DOWNLOAD_TOO_LARGE');}chunks.push(Buffer.from(part));}
  return Buffer.concat(chunks);
 }
 fail('TOO_MANY_REDIRECTS');
}
module.exports={APP_ID,REPOSITORY,MANIFEST_URL,verifyEnvelope,verifyBytes,verifyUpdateInfo,verifyInstaller,fetchReleaseBytes,digest};
