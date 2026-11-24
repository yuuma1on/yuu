const fs=require('node:fs');
const path=require('node:path');

function refuse(code){const error=new Error('Smoke output must be a new file inside an allowed temporary directory');error.code=code;throw error;}

// The CLI smoke harness and Electron may spell Windows temporary paths
// differently (including 8.3 aliases). Compare existing canonical directories,
// then let the caller create the returned filename with the exclusive wx flag.
function resolveSmokeOutput(requested,roots){
 if(typeof requested!=='string'||!requested||!path.isAbsolute(requested)||!Array.isArray(roots))refuse('INVALID_SMOKE_OUTPUT');
 const absolute=path.resolve(requested),parent=fs.realpathSync(path.dirname(absolute));
 if(!fs.statSync(parent).isDirectory())refuse('INVALID_SMOKE_OUTPUT');
 const output=path.join(parent,path.basename(absolute));
 const allowed=roots.some(root=>{
  if(typeof root!=='string'||!root||!path.isAbsolute(root))return false;
  try{
   const canonical=fs.realpathSync(root);
   if(!fs.statSync(canonical).isDirectory())return false;
   const relative=path.relative(canonical,output);
   return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
  }catch{return false;}
 });
 if(!allowed)refuse('SMOKE_OUTPUT_OUTSIDE_TEMP');
 // Existing ordinary files are left to the caller's wx check. An existing
 // symlink must never be presented as a confined output filename.
 try{if(fs.lstatSync(output).isSymbolicLink())refuse('SMOKE_OUTPUT_SYMLINK');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 return output;
}

module.exports={resolveSmokeOutput};
