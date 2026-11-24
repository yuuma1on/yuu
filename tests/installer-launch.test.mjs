import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import launch from '../desktop/installer-launch.cjs';
const{launchNsisInstaller}=launch;
const filename=path.join(os.tmpdir(),'verified installer.exe'),installDirectory=path.join(os.tmpdir(),'installed PULSE');
test('NSIS launch uses exact executable and fixed argument array without shell/elevation',async()=>{
 let call,unref=false;const child=new EventEmitter();child.unref=()=>{unref=true;};
 const pending=launchNsisInstaller(filename,{restart:false,installDirectory,spawnProcess:(...args)=>{call=args;return child;}});
 assert.equal(unref,false);child.emit('spawn');await pending;
 assert.deepEqual(call,[filename,['--updated','/S',`/D=${installDirectory}`],{detached:true,stdio:'ignore',windowsHide:true,shell:false}]);assert.equal(unref,true);
});
test('native asynchronous launch errors reject before application exit',async()=>{
 const child=new EventEmitter();child.unref=()=>assert.fail('Failed child must not be detached');
 const pending=launchNsisInstaller(filename,{installDirectory,spawnProcess:()=>child});
 child.emit('error',Object.assign(new Error('Denied'),{code:'EACCES'}));await assert.rejects(pending,{code:'EACCES'});
 await assert.rejects(launchNsisInstaller('relative.exe',{installDirectory}));
});
