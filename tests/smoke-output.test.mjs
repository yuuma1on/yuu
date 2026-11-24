import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outputPolicy from '../desktop/smoke-output.cjs';

const{resolveSmokeOutput}=outputPolicy;
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-smoke-output-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const allowed=path.join(root,'allowed'),other=path.join(root,'other');
 fs.mkdirSync(allowed);fs.mkdirSync(other);
 return{root,allowed,other};
}
function directoryAlias(t,target,alias){
 try{fs.symlinkSync(target,alias,'junction');return true;}
 catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('host policy does not permit directory aliases');return false;}throw error;}
}

test('returns a canonical new output without creating a file',t=>{
 const{allowed}=fixture(t),requested=path.join(allowed,'result.json');
 const result=resolveSmokeOutput(requested,[allowed]);
 assert.equal(result,path.join(fs.realpathSync(allowed),'result.json'));
 assert.equal(fs.existsSync(result),false);
});

test('accepts a second explicit temporary root when the first is different or unavailable',t=>{
 const{root,allowed,other}=fixture(t),requested=path.join(other,'runner-result.json');
 assert.equal(resolveSmokeOutput(requested,[allowed,undefined,'',path.join(root,'missing'),other]),path.join(fs.realpathSync(other),'runner-result.json'));
 assert.throws(()=>resolveSmokeOutput(requested,[allowed]),{code:'SMOKE_OUTPUT_OUTSIDE_TEMP'});
});

test('canonicalizes aliases in both the requested parent and the allowed root',t=>{
 const{root,allowed}=fixture(t),alias=path.join(root,'alias');
 if(!directoryAlias(t,allowed,alias))return;
 const expected=path.join(fs.realpathSync(allowed),'alias-result.json');
 assert.equal(resolveSmokeOutput(path.join(alias,'alias-result.json'),[allowed]),expected);
 assert.equal(resolveSmokeOutput(path.join(allowed,'alias-result.json'),[alias]),expected);
 assert.equal(resolveSmokeOutput(path.join(alias,'alias-result.json'),[alias]),expected);
});

test('rejects sibling prefix paths, parent traversal, and the root directory itself',t=>{
 const{root,allowed}=fixture(t),sibling=path.join(root,'allowed-extra');fs.mkdirSync(sibling);
 for(const requested of[path.join(sibling,'result.json'),path.join(allowed,'..','outside.json'),allowed]){
  assert.throws(()=>resolveSmokeOutput(requested,[allowed]),{code:'SMOKE_OUTPUT_OUTSIDE_TEMP'});
 }
});

test('rejects an existing parent alias that escapes the allowed root',t=>{
 const{allowed,other}=fixture(t),escape=path.join(allowed,'escape');
 if(!directoryAlias(t,other,escape))return;
 assert.throws(()=>resolveSmokeOutput(path.join(escape,'result.json'),[allowed]),{code:'SMOKE_OUTPUT_OUTSIDE_TEMP'});
 assert.equal(fs.existsSync(path.join(other,'result.json')),false);
});

test('leaves exclusive creation to wx and never overwrites an existing ordinary file',t=>{
 const{allowed}=fixture(t),requested=path.join(allowed,'existing.json');fs.writeFileSync(requested,'preserve');
 const result=resolveSmokeOutput(requested,[allowed]);
 assert.throws(()=>fs.writeFileSync(result,'replacement',{flag:'wx'}),{code:'EEXIST'});
 assert.equal(fs.readFileSync(requested,'utf8'),'preserve');
});

test('refuses an existing final-component symlink even when its target is outside the root',t=>{
 const{allowed,other}=fixture(t),target=path.join(other,'target.json'),link=path.join(allowed,'result.json');fs.writeFileSync(target,'preserve');
 try{fs.symlinkSync(target,link,'file');}
 catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('host policy does not permit file symlinks');return;}throw error;}
 assert.throws(()=>resolveSmokeOutput(link,[allowed]),{code:'SMOKE_OUTPUT_SYMLINK'});
 assert.equal(fs.readFileSync(target,'utf8'),'preserve');
});

test('requires an existing parent and at least one usable absolute directory root',t=>{
 const{allowed}=fixture(t),requested=path.join(allowed,'result.json');
 assert.throws(()=>resolveSmokeOutput(path.join(allowed,'missing','result.json'),[allowed]),{code:'ENOENT'});
 for(const roots of[[],[undefined,'','relative-root'],[requested]])assert.throws(()=>resolveSmokeOutput(requested,roots),{code:'SMOKE_OUTPUT_OUTSIDE_TEMP'});
 for(const invalid of['','relative.json',null])assert.throws(()=>resolveSmokeOutput(invalid,[allowed]),{code:'INVALID_SMOKE_OUTPUT'});
 assert.throws(()=>resolveSmokeOutput(requested,null),{code:'INVALID_SMOKE_OUTPUT'});
});
