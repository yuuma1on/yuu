/** Single-action new-file UI; serializer validates freshly on each click. */
export function getTjaExportAction({result,busy=false,saving=false,confirmedMeter=null,eligibilityError=null}={}){
 if(busy)return {code:'busy',message:'解析中です。',canSave:false};
 if(saving)return {code:'saving',message:'保存先を選択・保存しています。',canSave:false};
 if(!result)return {code:'no-result',message:'音源を解析すると保存できます。',canSave:false};
 if(result.tempoModel==='constant-clock'&&!confirmedMeter)return {code:'choose-meter',message:'拍子を選んでから保存してください。表示中の選択欄で確認した拍子を指定します。',canSave:true};
 if(!['constant-clock','manual'].includes(result.tempoModel))return {code:'variable-unconfirmed',message:'変化の時刻が未確定のためTJAは保存できません。対象区間のBPM・開始/終了・拍子を手動確認してください。',canSave:true};
 if(eligibilityError)return {code:'blocked',message:eligibilityError,canSave:true};
 return {code:'ready',message:'保存できます。',canSave:true};
}
/** Synchronous user-gesture request, NOT proof a browser saved the file. */
export function requestTjaDownload({text,fileName,document:doc=globalThis.document,urlApi=globalThis.URL,BlobClass=globalThis.Blob,schedule=globalThis.setTimeout}){
 if(typeof text!=='string'||!text||typeof fileName!=='string'||!fileName)throw Error('ダウンロード内容がありません。');
 const url=urlApi.createObjectURL(new BlobClass(['\ufeff'+text],{type:'text/plain;charset=utf-8'}));
 const anchor=doc.createElement('a');anchor.href=url;anchor.download=fileName;anchor.hidden=true;
 try{doc.body.append(anchor);anchor.click();}catch(error){urlApi.revokeObjectURL(url);throw error;}finally{anchor.remove();}
 schedule(()=>urlApi.revokeObjectURL(url),60000);
 return {status:'requested'};
}
