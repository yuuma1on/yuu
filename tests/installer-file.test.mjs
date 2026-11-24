import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import manifest from '../desktop/update-manifest.cjs';

const {verifyInstaller,digest}=manifest;
const bytes=Buffer.from('MZ verified installer fixture bytes');
const artifact={size:bytes.length,sha512:digest(bytes)};
async function fixture(t){
 const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'pulse-installer-file-'));
 t.after(()=>fs.promises.rm(root,{recursive:true,force:true}));
 const cache=path.join(root,'cache');await fs.promises.mkdir(cache);
 const filename=path.join(cache,'update.exe');await fs.promises.writeFile(filename,bytes);
 return{root,cache,filename};
}
// Capture the second descriptor stat first, then perform a real filesystem
// change before returning it. This deterministically models replacement just
// after hashing/fstat, without changing what the verified descriptor names.
async function afterHashStat(filename,action,run){
 // Windows temporary directories may use an 8.3 alias; the verifier opens
 // realpath's canonical long spelling rather than the caller's input string.
 const canonical=await fs.promises.realpath(filename),original=fs.promises.open;let changed=false;
 fs.promises.open=async function(file,...args){
  const handle=await original.call(this,file,...args);
  if(file===canonical){
   const stat=handle.stat.bind(handle);let calls=0;
   handle.stat=async function(...options){
    const snapshot=await stat(...options);
    if(++calls===2){await action();changed=true;}
    return snapshot;
   };
  }
  return handle;
 };
 try{await run();assert.equal(changed,true,'the attack must actually occur after the hashed descriptor snapshot');}
 finally{fs.promises.open=original;}
}

test('an ordinary cached installer returns its canonical path and preserves bytes',async t=>{
 const f=await fixture(t);assert.equal(await verifyInstaller(f.filename,artifact,f.cache),await fs.promises.realpath(f.filename));assert.deepEqual(await fs.promises.readFile(f.filename),bytes);
});

test('rename replacement after hashing cannot substitute different bytes behind a verified descriptor',async t=>{
 const f=await fixture(t),retired=path.join(f.cache,'verified-old.exe'),replacement=Buffer.alloc(bytes.length,0x58);
 await afterHashStat(f.filename,async()=>{await fs.promises.rename(f.filename,retired);await fs.promises.writeFile(f.filename,replacement);},async()=>{
  await assert.rejects(verifyInstaller(f.filename,artifact,f.cache),{code:'INSTALLER_FILE_CHANGED'});
 });
 assert.deepEqual(await fs.promises.readFile(retired),bytes);assert.deepEqual(await fs.promises.readFile(f.filename),replacement);
});

test('same-byte replacement is still rejected because the returned pathname no longer names the verified file',async t=>{
 const f=await fixture(t),retired=path.join(f.cache,'verified-old.exe');
 await afterHashStat(f.filename,async()=>{await fs.promises.rename(f.filename,retired);await fs.promises.writeFile(f.filename,bytes);},async()=>{
  await assert.rejects(verifyInstaller(f.filename,artifact,f.cache),{code:'INSTALLER_FILE_CHANGED'});
 });
 assert.deepEqual(await fs.promises.readFile(f.filename),bytes,'content equality must not disguise a different file identity');
});

test('deleting the verified pathname after the descriptor snapshot is rejected',async t=>{
 const f=await fixture(t);
 await afterHashStat(f.filename,()=>fs.promises.rename(f.filename,path.join(f.cache,'retired.exe')),async()=>{await assert.rejects(verifyInstaller(f.filename,artifact,f.cache),{code:'ENOENT'});});
});

test('an already symlinked installer is refused even when its target has the signed bytes',async t=>{
 const f=await fixture(t),link=path.join(f.cache,'linked.exe');
 try{await fs.promises.symlink(f.filename,link,'file');}
 catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('host policy does not permit creating file symlinks');return;}throw error;}
 await assert.rejects(verifyInstaller(link,artifact,f.cache),{code:'INSTALLER_SYMLINK'});
});

test('a pathname replaced by a symlink after hashing is refused even when it leads to the verified file',async t=>{
 const f=await fixture(t),retired=path.join(f.cache,'verified-old.exe'),probe=path.join(f.cache,'symlink-probe.exe');
 try{await fs.promises.symlink(f.filename,probe,'file');await fs.promises.unlink(probe);}
 catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('host policy does not permit creating file symlinks');return;}throw error;}
 await afterHashStat(f.filename,async()=>{await fs.promises.rename(f.filename,retired);await fs.promises.symlink(retired,f.filename,'file');},async()=>{
  await assert.rejects(verifyInstaller(f.filename,artifact,f.cache),{code:'INSTALLER_SYMLINK'});
 });
});

test('a file changed in place after verification remains rejected',async t=>{
 const f=await fixture(t);await verifyInstaller(f.filename,artifact,f.cache);
 await fs.promises.writeFile(f.filename,Buffer.alloc(bytes.length));await assert.rejects(verifyInstaller(f.filename,artifact,f.cache),{code:'ARTIFACT_HASH_MISMATCH'});
});

test('outside-cache and non-executable paths remain rejected',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside.exe'),other=path.join(f.cache,'update.txt');
 await fs.promises.writeFile(outside,bytes);await fs.promises.writeFile(other,bytes);
 await assert.rejects(verifyInstaller(outside,artifact,f.cache),{code:'INSTALLER_OUTSIDE_CACHE'});
 await assert.rejects(verifyInstaller(other,artifact,f.cache),{code:'INVALID_INSTALLER_PATH'});
});
