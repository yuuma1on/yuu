import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const source=path.resolve(process.argv[2]||path.join(root,'../pulse-source'));
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
const packageInfo=JSON.parse(execFileSync('git',['show',`${commit}:package.json`],{cwd:source,encoding:'utf8'}));
const files=execFileSync('git',['ls-tree','-r','--name-only',commit,'dist'],{cwd:source,encoding:'utf8'}).trim().split('\n');
const manifest={upstreamCommit:commit,engineVersion:packageInfo.version,files:{}};
fs.mkdirSync(path.join(root,'web'),{recursive:true});
for(const name of files){
 if(!name.startsWith('dist/')||!/[.](?:js|css|html|svg|png|ico|json)$/.test(name))throw new Error(`Unexpected web asset ${name}`);
 let data=execFileSync('git',['show',`${commit}:${name}`],{cwd:source});
 const originalSha256=crypto.createHash('sha256').update(data).digest('hex');
 if(name==='dist/index.html'){
  const html=data.toString('utf8').replace('</head>','  <link rel="stylesheet" href="./desktop/update-ui.css">\n</head>').replace('</body>','  <script type="module" src="./desktop/update-ui.js"></script>\n</body>').replace(/[ \t]+$/gm,'');
  data=Buffer.from(html);
 }
 const destination=path.join(root,'web',name.slice(5));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,data);
 manifest.files[name.slice(5)]={upstreamSha256:originalSha256,packagedSha256:crypto.createHash('sha256').update(data).digest('hex')};
}
fs.writeFileSync(path.join(root,'source-info.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Copied ${files.length} tracked web assets from ${commit}; analysis code unchanged.`);
