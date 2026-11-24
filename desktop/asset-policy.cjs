const path=require('node:path');
const fs=require('node:fs');
const ORIGIN='pulse://app';
function trustedUrl(value){
 try{const u=new URL(value);return u.protocol==='pulse:'&&u.hostname==='app'&&!u.port&&!u.username&&!u.password;}catch{return false;}
}
function resolveAsset(value,roots){
 if(!trustedUrl(value))return null;
 let pathname;try{pathname=decodeURIComponent(new URL(value).pathname);}catch{return null;}
 if(pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').includes('..'))return null;
 if(pathname==='/')pathname='/index.html';
 const desktop=pathname.startsWith('/desktop/');
 const base=desktop?roots.desktop:roots.web;
 const relative=desktop?pathname.slice('/desktop/'.length):pathname.slice(1);
 if(!relative||!/[.](?:html|js|css|json|png|svg|ico)$/.test(relative))return null;
 const candidate=path.resolve(base,relative),inside=path.relative(base,candidate);
 if(inside.startsWith('..'+path.sep)||path.isAbsolute(inside))return null;
 try{
  const realBase=fs.realpathSync(base),real=fs.realpathSync(candidate),rel=path.relative(realBase,real);
  if(rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||!fs.statSync(real).isFile())return null;
  return candidate;
 }catch{return null;}
}
function permittedTjaFile(permission,origin,details={}){
 return permission==='fileSystem'&&trustedUrl(origin)&&details.isDirectory===false&&
  typeof details.filePath==='string'&&path.isAbsolute(details.filePath)&&path.extname(details.filePath).toLowerCase()==='.tja'&&
  ['readable','writable'].includes(details.fileAccessType);
}
module.exports={ORIGIN,trustedUrl,resolveAsset,permittedTjaFile};
