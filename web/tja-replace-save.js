/** Browser File System Access orchestration. No picker or permission prompt.
 * Verified backups are private, in-memory receipts, not persistent trust.
 * No atomic compare-and-swap exists: external edits after final read remain a risk.
 */
const receipts=new WeakMap(),MAX=2_000_000;
function fail(code,message){const e=new Error(message);e.code=code;throw e;}
function snapshot(bytes){if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX)fail('INVALID_BYTES','空でない2MB以下のバイト列が必要です。');return bytes.slice();}
function current(...guards){for(const guard of guards)if(typeof guard!=='function'||guard()!==true)fail('STALE_REVISION','プレビュー後に状態が変わりました。最初から確認してください。');}
function equal(a,b){return a.length===b.length&&a.every((v,i)=>v===b[i]);}
async function read(handle){if(!handle||typeof handle.getFile!=='function')fail('INVALID_HANDLE','ファイルハンドルが不正です。');const file=await handle.getFile();if(file.size>MAX)fail('FILE_TOO_LARGE','ファイルが対応サイズを超えています。');return new Uint8Array(await file.arrayBuffer());}
async function abort(stream){try{await stream?.abort();}catch{/* Preserve the original error; no claim rollback succeeded. */}}
export async function verifyExistingReplacementBackup({originalHandle,backupHandle,originalBytes,replacementBytes,isCurrent}={}){
 current(isCurrent);const original=snapshot(originalBytes),replacement=snapshot(replacementBytes);
 if(typeof originalHandle?.isSameEntry!=='function')fail('IDENTITY_UNAVAILABLE','同じファイルか確認できないため停止しました。');
 const same=await originalHandle.isSameEntry(backupHandle);current(isCurrent);
 if(same!==false)fail('SAME_FILE','元ファイルではなく、別ファイルのバックアップを開いてください。');
 const observed=await read(originalHandle);current(isCurrent);
 if(!equal(observed,original))fail('ORIGINAL_CHANGED','元ファイルがプレビュー時から変更されています。');
 const saved=await read(backupHandle);current(isCurrent);
 if(!equal(saved,original))fail('BACKUP_VERIFY_FAILED','バックアップの内容が元ファイルと一致しません。どちらのファイルも変更していません。');
 const receipt=Object.freeze({type:'verified-replacement-backup'});
 receipts.set(receipt,{originalHandle,backupHandle,original,replacement,isCurrent,consumed:false});return receipt;
}
export async function overwriteFromVerifiedBackup(receipt,{confirmed=false,isCurrent}={}){
 if(confirmed!==true)fail('CONFIRMATION_REQUIRED','元ファイル本体の置き換えには、別の最終確認が必要です。');
 const r=receipts.get(receipt);if(!r||r.consumed)fail('INVALID_RECEIPT','有効なバックアップ確認がありません。');
 const guards=[r.isCurrent,isCurrent];current(...guards);
 // One final attempt per receipt prevents concurrent/replayed commits, including
 // retries after a close error whose on-disk outcome may be unknown.
 r.consumed=true;
 if(typeof r.originalHandle.isSameEntry!=='function'||await r.originalHandle.isSameEntry(r.backupHandle)!==false)fail('IDENTITY_UNAVAILABLE','元ファイルとバックアップの区別を再確認できません。');current(...guards);
 if(!equal(await read(r.backupHandle),r.original))fail('BACKUP_CHANGED','バックアップが変更されたため上書きを停止しました。');current(...guards);
 if(!equal(await read(r.originalHandle),r.original))fail('ORIGINAL_CHANGED','元ファイルが変更されたため上書きを停止しました。');current(...guards);
 if(typeof r.originalHandle.createWritable!=='function')fail('WRITE_UNAVAILABLE','元ファイルに書き込めません。');
 let stream;
 try{
  stream=await r.originalHandle.createWritable({keepExistingData:false});current(...guards);
  if(!equal(await read(r.backupHandle),r.original))fail('BACKUP_CHANGED','バックアップが変更されました。');current(...guards);
  // Last read immediately precedes write; not an atomic external-edit lock.
  if(!equal(await read(r.originalHandle),r.original))fail('ORIGINAL_CHANGED','元ファイルが変更されました。');current(...guards);
  await stream.write(r.replacement);current(...guards);await stream.close();stream=null;
 }catch(e){await abort(stream);throw e;}
 const saved=await read(r.originalHandle);
 if(!equal(saved,r.replacement))fail('WRITE_VERIFY_FAILED','書き込み後の内容が一致しません。検証済みバックアップを保持してください。');
 return {written:true,verified:true,byteLength:saved.length,backupRetained:true,revisionStillCurrent:guards.every(g=>g()===true)};
}
