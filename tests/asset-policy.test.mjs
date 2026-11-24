import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import policy from '../desktop/asset-policy.cjs';
const{trustedUrl,resolveAsset,permittedTjaFile,createTjaPermissions}=policy;
test('trusted origin checks scheme/host/credentials rather than URL.origin null',()=>{
 assert.equal(trustedUrl('pulse://app/index.html'),true);
 for(const value of['https://app/index.html','pulse://attacker/index.html','pulse://app.attacker/index.html','pulse://user@app/index.html','file:///tmp/index.html','data:text/html,hello'])assert.equal(trustedUrl(value),false);
});
test('TJA writes require an explicit per-file grant and are revoked on navigation',()=>{
 const grants=createTjaPermissions(),origin='pulse://app',file={filePath:path.join(os.tmpdir(),'chosen.tja'),isDirectory:false,fileAccessType:'writable'};
 assert.equal(grants.check('fileSystem',origin,{...file,fileAccessType:'readable'}),true);
 assert.equal(grants.check('fileSystem',origin,file),false);
 assert.equal(grants.grantWrite('fileSystem','https://evil.example',file),false);
 assert.equal(grants.grantWrite('fileSystem',origin,file),true);assert.equal(grants.check('fileSystem',origin,file),true);
 assert.equal(grants.check('fileSystem',origin,{...file,filePath:path.join(os.tmpdir(),'other.tja')}),false);
 grants.clear();assert.equal(grants.check('fileSystem',origin,file),false);
});
test('asset resolver serves only local web/UI files and rejects escaped/symlinked files',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-assets-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const web=path.join(root,'web'),desktop=path.join(root,'ui');fs.mkdirSync(web);fs.mkdirSync(desktop);fs.writeFileSync(path.join(web,'index.html'),'app');fs.writeFileSync(path.join(desktop,'update-ui.js'),'ui');
 assert.equal(resolveAsset('pulse://app/index.html?v=33',{web,desktop}),path.join(web,'index.html'));
 assert.equal(resolveAsset('pulse://app/desktop/update-ui.js',{web,desktop}),path.join(desktop,'update-ui.js'));
 for(const url of['pulse://app/%2f..%2fsecret.js','pulse://app/desktop/main.cjs','pulse://app/desktop/update-public-key.pem','pulse://evil/index.html'])assert.equal(resolveAsset(url,{web,desktop}),null);
 if(process.platform!=='win32'){fs.writeFileSync(path.join(root,'secret.js'),'secret');fs.symlinkSync(path.join(root,'secret.js'),path.join(web,'leak.js'));assert.equal(resolveAsset('pulse://app/leak.js',{web,desktop}),null);}
});
test('file permissions are limited to user-picked TJA files without granting directories or other capabilities',()=>{
 const details={filePath:path.join(os.tmpdir(),'chosen.tja'),isDirectory:false,fileAccessType:'writable'};
 assert.equal(permittedTjaFile('fileSystem','pulse://app',details),true);
 for(const value of[{...details,isDirectory:true},{...details,filePath:path.join(os.tmpdir(),'chosen.exe')},{...details,fileAccessType:'unknown'}])assert.equal(permittedTjaFile('fileSystem','pulse://app',value),false);
 assert.equal(permittedTjaFile('media','pulse://app',details),false);assert.equal(permittedTjaFile('fileSystem','https://evil.example',details),false);
});
