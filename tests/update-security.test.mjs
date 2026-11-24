import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import manifestModule from '../desktop/update-manifest.cjs';
import controllerModule from '../desktop/update-controller.cjs';
const {verifyEnvelope,verifyBytes,verifyUpdateInfo,verifyInstaller,fetchReleaseBytes,digest,MANIFEST_URL}=manifestModule;
const {UpdateController}=controllerModule;
const keys=crypto.generateKeyPairSync('ed25519');
const installer=Buffer.from('MZ signed test installer bytes'),metadata=Buffer.from('version: 1.26.1\n');
function payload(){return{schemaVersion:1,appId:'app.pulse.rhythmstudio',repository:'yuuma1on/yuu',channel:'stable',platform:'win32',arch:'x64',version:'1.26.1',publishedAt:'2026-11-24T00:00:00Z',installer:{name:'PULSE-Setup-1.26.1-x64.exe',size:installer.length,sha512:digest(installer),url:'https://github.com/yuuma1on/yuu/releases/download/v1.26.1/PULSE-Setup-1.26.1-x64.exe'},latestYml:{name:'latest.yml',size:metadata.length,sha512:digest(metadata)}};}
function envelope(m=payload(),key=keys.privateKey){const bytes=Buffer.from(JSON.stringify(m));return Buffer.from(JSON.stringify({payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,key).toString('base64')}));}
const context={currentVersion:'1.26.0',now:Date.parse('2026-11-24T01:00:00Z')};
function info(m=payload()){return{version:m.version,files:[{url:m.installer.name,size:m.installer.size,sha512:m.installer.sha512}],path:m.installer.name,sha512:m.installer.sha512};}

test('exact Ed25519 payload bytes authenticate the intended newer release',()=>{
 const verified=verifyEnvelope(envelope(),keys.publicKey,context);
 assert.equal(verified.newer,true);assert.equal(verified.feedUrl,'https://github.com/yuuma1on/yuu/releases/download/v1.26.1/');assert.ok(Object.isFrozen(verified.manifest.installer));
 verifyBytes(installer,verified.manifest.installer);verifyUpdateInfo(info(),verified.manifest);
});
test('tampered payload, tampered signature, unrelated key and malformed envelopes fail closed',()=>{
 const valid=JSON.parse(envelope());const altered={...valid,payload:Buffer.from(JSON.stringify({...payload(),version:'9.0.0'})).toString('base64')};
 for(const value of[JSON.stringify(altered),JSON.stringify({...valid,signature:Buffer.alloc(64).toString('base64')}),'{}','null','not json'])assert.throws(()=>verifyEnvelope(value,keys.publicKey,context));
 assert.throws(()=>verifyEnvelope(envelope(),crypto.generateKeyPairSync('ed25519').publicKey,context));
});
test('cross-app/repo/channel/platform/architecture, noncanonical versions and wrong URLs are rejected',()=>{
 for(const [field,value]of Object.entries({schemaVersion:2,appId:'other',repository:'other/repo',channel:'beta',platform:'linux',arch:'arm64',version:'1.27.0-beta.1',publishedAt:'not a date'}))assert.throws(()=>verifyEnvelope(envelope({...payload(),[field]:value}),keys.publicKey,context));
 for(const url of['http://github.com/yuuma1on/yuu/releases/download/v1.26.1/PULSE-Setup-1.26.1-x64.exe','https://github.com/attacker/repo/releases/download/v1.26.1/evil.exe','file:///tmp/install.exe']){
  const m=payload();m.installer.url=url;assert.throws(()=>verifyEnvelope(envelope(m),keys.publicKey,context));
 }
});
test('signed old/equal release is never treated as an update',()=>{
 assert.equal(verifyEnvelope(envelope(),keys.publicKey,{...context,currentVersion:'1.26.1'}).newer,false);
 assert.equal(verifyEnvelope(envelope(),keys.publicKey,{...context,currentVersion:'2.0.0'}).newer,false);
});
test('metadata substitution, extra packages/files, unsafe names or elevation cannot alter the signed install',()=>{
 const good=info();
 for(const modify of[
  x=>x.version='9.0.0',x=>x.files[0].url='../evil.exe',x=>x.files[0].sha512=digest(Buffer.from('evil')),x=>x.files[0].size++,
  x=>x.files.push({...x.files[0]}),x=>x.packages={},x=>x.files[0].isAdminRightsRequired=true,x=>x.path='https://evil.example/evil.exe',x=>x.files[0].packageInfo={}
 ]){const value=structuredClone(good);modify(value);assert.throws(()=>verifyUpdateInfo(value,payload()));}
 assert.throws(()=>verifyBytes(Buffer.from('tampered'),payload().installer));
});
test('HTTP redirects outside the pinned GitHub/CDN transport and oversized streams fail',async()=>{
 let calls=0;const fake=async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});};
 await assert.rejects(fetchReleaseBytes(MANIFEST_URL,{fetchImpl:fake}));assert.equal(calls,1);
 await assert.rejects(fetchReleaseBytes(MANIFEST_URL,{maxBytes:4,fetchImpl:async()=>new Response('12345')}));
 const bytes=await fetchReleaseBytes(MANIFEST_URL,{fetchImpl:async()=>new Response('valid')});assert.equal(bytes.toString(),'valid');
});
test('cached installer is constrained to the app cache and verified again after a local mutation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pulse-cache-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cache=path.join(root,'cache');await fs.mkdir(cache);const file=path.join(cache,'update.exe');await fs.writeFile(file,installer);
 assert.equal(await verifyInstaller(file,payload().installer,cache),file);
 const outside=path.join(root,'outside.exe');await fs.writeFile(outside,installer);await assert.rejects(verifyInstaller(outside,payload().installer,cache));
 await fs.writeFile(file,Buffer.alloc(installer.length));await assert.rejects(verifyInstaller(file,payload().installer,cache));
});

async function setup(t,{badEnvelope=false,badInfo=false,supported=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pulse-update-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'cached.exe');await fs.writeFile(file,installer);
 class Updater extends EventEmitter{constructor(){super();this.checks=0;this.downloads=0;this.installs=[];}setFeedURL(value){this.feed=value;}async checkForUpdates(){this.checks++;return{updateInfo:badInfo?{...info(),version:'9.0.0'}:info()};}async downloadUpdate(){this.downloads++;this.emit('download-progress',{percent:70});return[file];}quitAndInstall(...args){this.installs.push(args);}}
 const updater=new Updater();let fetches=0;
 const controller=new UpdateController({updater,publicKey:keys.publicKey,currentVersion:'1.26.0',cacheRoot:root,supported,fetchBytes:async url=>{fetches++;return url===MANIFEST_URL?(badEnvelope?Buffer.from('{}'):envelope()):metadata;}});
 return{controller,updater,file,fetches:()=>fetches};
}
test('single-flight check authenticates before download and installs only after final recheck',async t=>{
 const{controller:c,updater:u}=await setup(t);const a=c.check(),b=c.check();assert.equal(a,b);assert.equal((await a).status,'ready');assert.equal(u.checks,1);assert.equal(u.downloads,1);
 assert.equal(u.autoDownload,false);assert.equal(u.autoInstallOnAppQuit,false);assert.equal(u.disableDifferentialDownload,true);assert.equal(u.disableWebInstaller,true);
 const i=c.install(),j=c.install();assert.equal(i,j);await i;assert.deepEqual(u.installs,[[true,true]]);
});
test('unsigned or mismatched metadata never download or install',async t=>{
 for(const options of[{badEnvelope:true},{badInfo:true}]){const{controller:c,updater:u}=await setup(t,options);assert.equal((await c.check()).status,'error');assert.equal(u.downloads,0);assert.equal(u.installs.length,0);await assert.rejects(c.install());}
});
test('unrelated downloaded event cannot authorize install; cache tampering at restart is rejected',async t=>{
 const{controller:c,updater:u,file}=await setup(t);u.emit('update-downloaded',{downloadedFile:file});assert.notEqual(c.getState().status,'ready');await c.check();await fs.writeFile(file,Buffer.alloc(installer.length));await assert.rejects(c.install());assert.equal(u.installs.length,0);assert.equal(c.getState().status,'error');
});
test('unpackaged/non-Windows builds never check or install updates',async t=>{
 const{controller:c,updater:u,fetches}=await setup(t,{supported:false});assert.equal((await c.check()).status,'unsupported');assert.equal(fetches(),0);assert.equal(u.downloads,0);await assert.rejects(c.install());
});
