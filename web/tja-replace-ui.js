import {prepareTjaBodyReplacement} from './tja-replace.js';
import {verifyExistingReplacementBackup,overwriteFromVerifiedBackup} from './tja-replace-save.js?v=24';

export function mountTjaReplacement({getContext,document:doc=globalThis.document,platform=globalThis}){
 const ids=['Encoding','File','Open','Name','Preview','Status','Warnings','Old','New','Consent','Copy','BackupDownload','Backup','OverwriteConsent','Overwrite'];
 const el=Object.fromEntries(ids.map(k=>[k,doc.getElementById('replace'+k)]));
 let epoch=0,target=null,preview=null,receipt=null,busy=false,working=false;
 const context=()=>getContext()||{};
 const stamp=()=>{const c=context();return {epoch,revision:c.revision,result:c.result,audioName:c.audioName,confirmedMeter:c.confirmedMeter};};
 const current=s=>{const c=context();return s.epoch===epoch&&s.revision===c.revision&&s.result===c.result&&s.audioName===c.audioName&&s.confirmedMeter===c.confirmedMeter&&!busy;};
 function refresh(){
  const lock=busy||working,valid=preview&&current(preview.stamp),consent=valid&&el.Consent.checked;
  el.File.disabled=el.Encoding.disabled=lock;el.Open.disabled=lock||typeof platform.showOpenFilePicker!=='function';
  el.Preview.disabled=lock||!target||!el.Encoding.value||!context().result;
  el.Consent.disabled=lock||!valid;el.Copy.disabled=lock||!consent;
  el.BackupDownload.disabled=lock||!consent||!target?.handle;
  el.Backup.disabled=lock||!consent||!target?.handle||typeof platform.showOpenFilePicker!=='function';
  el.OverwriteConsent.disabled=lock||!consent||!receipt;el.Overwrite.disabled=lock||!consent||!receipt||!el.OverwriteConsent.checked;
 }
 function clearPreview(){epoch++;preview=null;receipt=null;el.Consent.checked=false;el.OverwriteConsent.checked=false;el.Old.value='';el.New.value='';el.Warnings.replaceChildren();refresh();}
 function invalidate(){clearPreview();target=null;el.File.value='';el.Name.textContent='対象ファイルなし';el.Status.textContent='対象・解析が変わった場合は、もう一度読み込み、プレビューを確認してください。';refresh();}
 function status(text){el.Status.textContent=text;}
 function error(e){status(e?.name==='AbortError'?'キャンセルしました。書き込みを開始していた場合は、保存先の状態を確認してください。':`処理を完了できませんでした。${e?.message||String(e)} 保存先の状態を確認してください。`);}
 async function load(file,handle,s){
  if(file.size>2_000_000)throw Error('対象TJAは2MB以下にしてください。');
  const bytes=new Uint8Array(await file.arrayBuffer());if(!current(s))return;
  target={name:file.name,bytes,handle};el.Name.textContent=file.name+(handle?'（元ファイルへのハンドルあり）':'（コピー保存のみ）');status('読み込みました。まだ変更していません。');
 }
 el.File.addEventListener('change',async()=>{
  if(busy||working)return;const file=el.File.files?.[0];clearPreview();target=null;el.Name.textContent='対象ファイルなし';const s=stamp();working=true;refresh();
  try{if(file)await load(file,null,s);}catch(e){if(current(s))error(e);}finally{working=false;refresh();}
 });
 el.Open.addEventListener('click',async()=>{
  if(busy||working)return;clearPreview();target=null;el.Name.textContent='対象ファイルなし';const s=stamp();working=true;refresh();
  try{const [handle]=await platform.showOpenFilePicker({multiple:false,types:[{description:'TJA',accept:{'text/plain':['.tja']}}]});if(!current(s))return;await load(await handle.getFile(),handle,s);}catch(e){if(current(s))error(e);}finally{working=false;refresh();}
 });
 el.Encoding.addEventListener('change',()=>{clearPreview();status('文字コードを変更しました。再プレビューしてください。');});
 el.Preview.addEventListener('click',()=>{
  if(busy||working||!target)return;clearPreview();const c=context(),s=stamp();
  const prepared=prepareTjaBodyReplacement(target.bytes,c.result,{encoding:el.Encoding.value,audioName:c.audioName,title:c.title,confirmedMeter:c.confirmedMeter});
  if(!prepared.available){status(prepared.reason);refresh();return;}
  preview={prepared,stamp:s};el.Old.value=prepared.oldBody;el.New.value=prepared.newBody;
  for(const text of [...prepared.warnings,...(prepared.draft.warnings||[]).filter(text=>!text.startsWith('全ヘッダーが空欄')),...(prepared.draft.omitted||[]).map(x=>`省略: ${x.start}〜${x.end} 秒 (${x.reason})`)]){const li=doc.createElement('li');li.textContent=text;el.Warnings.append(li);}
  status(`プレビューのみ。ノーツ記号 ${prepared.removed.nonzeroNoteSymbols} 個を含む本体を置換します。${prepared.originalByteLength} → ${prepared.newByteLength} バイト。本体以外は保持します。`);refresh();
 });
 el.Consent.addEventListener('change',()=>{if(!el.Consent.checked){receipt=null;el.OverwriteConsent.checked=false;}refresh();});
 el.OverwriteConsent.addEventListener('change',refresh);
 const filename=suffix=>target.name.replace(/\.tja$/i,'')+suffix+'.tja';
 function download(bytes,suffix){
  const url=platform.URL.createObjectURL(new platform.Blob([bytes],{type:'application/octet-stream'}));
  const a=doc.createElement('a');a.href=url;a.download=filename(suffix);a.hidden=true;
  try{doc.body.append(a);a.click();}catch(e){platform.URL.revokeObjectURL(url);throw e;}finally{a.remove();}
  platform.setTimeout(()=>platform.URL.revokeObjectURL(url),60000);
 }
 el.Copy.addEventListener('click',()=>{
  if(busy||working||!preview||!current(preview.stamp)||!el.Consent.checked)return;
  try{download(preview.prepared.bytes,'.pulse-copy');status('別名コピーのダウンロードを要求しました。保存完了はブラウザーで確認してください。元ファイルは変更していません。');}
  catch{status('ダウンロードを開始できませんでした。元ファイルは変更していません。');}
 });
 el.BackupDownload.addEventListener('click',()=>{
  if(busy||working||!preview||!current(preview.stamp)||!el.Consent.checked||!target?.handle)return;
  try{download(target.bytes,'.original-backup');status('元ファイルのバックアップをダウンロード要求しました。保存を確認し、「バックアップを開いて検証」でその別ファイルを選んでください。');}
  catch{status('バックアップのダウンロードを開始できませんでした。元ファイルは変更していません。');}
 });
 el.Backup.addEventListener('click',async()=>{
  if(busy||working||!preview||!current(preview.stamp)||!el.Consent.checked||!target?.handle)return;
  receipt=null;el.OverwriteConsent.checked=false;const p=preview,t=target,s=p.stamp;working=true;refresh();
  try{const [backupHandle]=await platform.showOpenFilePicker({multiple:false,types:[{description:'TJA',accept:{'text/plain':['.tja']}}]});if(!current(s)||!backupHandle)return;
   const saved=await verifyExistingReplacementBackup({originalHandle:t.handle,backupHandle,originalBytes:t.bytes,replacementBytes:p.prepared.bytes,isCurrent:()=>current(s)});
   if(!current(s))return;receipt=saved;status('別ファイルのバックアップを読み戻して検証しました。元ファイルはまだ変更していません。上書きする場合は別の確認欄を選んでください。');
  }catch(e){receipt=null;if(current(s))status(e?.name==='AbortError'?'バックアップの選択をキャンセルしました。ファイルは変更していません。':e?.message||'バックアップを検証できませんでした。');}finally{working=false;refresh();}
 });
 el.Overwrite.addEventListener('click',async()=>{
  if(busy||working||!receipt||!preview||!current(preview.stamp)||!el.Consent.checked||!el.OverwriteConsent.checked)return;
  const s=preview.stamp,r=receipt,name=target.name;receipt=null;el.OverwriteConsent.checked=false;working=true;refresh();
  try{const saved=await overwriteFromVerifiedBackup(r,{confirmed:true,isCurrent:()=>current(s)});const stale=!current(s)||saved.revisionStillCurrent===false;invalidate();status(`${name} への書き込みと読み戻し検証が完了しました。別ファイルのバックアップを保管してください。${stale?'保存処理中に解析が変わりました。保存内容は確認した以前のプレビューです。':''}`);}
  catch(e){receipt=null;el.OverwriteConsent.checked=false;error(e);}finally{working=false;refresh();}
 });
 refresh();return {invalidate,setBusy(value){busy=Boolean(value);if(busy)invalidate();refresh();}};
}
