import {buildTimingDraft} from './tja-export.js?v=34';
const MAX_BYTES=2_000_000;
const COMMANDS=new Set(['BPMCHANGE','MEASURE','SCROLL','GOGOSTART','GOGOEND','BARLINEON','BARLINEOFF','LYRIC']);
const basename=s=>s.replace(/\\/g,'/').split('/').at(-1).normalize('NFC').toLowerCase();
const numeric=s=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)&&Number.isFinite(Number(s));
/** Pure preparation only: never writes files or mutates target/analysis.
 * UTF-8 or CP932-compatible WHATWG shift_jis must be explicitly selected.
 * No target timing is used to generate the body. Prefix/suffix bytes survive.
 */
export function prepareTjaBodyReplacement(originalBytes,result,options={}){
 const no=reason=>({available:false,reason,bytes:null});
 if(!(originalBytes instanceof Uint8Array)||!originalBytes.length||originalBytes.length>MAX_BYTES)return no('対象ファイルは空でない2MB以下のバイト列が必要です。');
 if(!['utf-8','shift_jis'].includes(options.encoding))return no('文字コードをUTF-8またはCP932として明示的に確認してください。');
 let decoder,text;
 try{decoder=new TextDecoder(options.encoding,{fatal:true});text=decoder.decode(originalBytes);}catch{return no('指定した文字コードで正しく読み取れません。');}
 const bom=originalBytes.length>=3&&originalBytes[0]===239&&originalBytes[1]===187&&originalBytes[2]===191;
 if(bom&&options.encoding!=='utf-8')return no('BOMと指定した文字コードが一致しません。');
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))return no('未対応の制御文字があります。');
 const crlf=(text.match(/\r\n/g)||[]).length,lf=(text.match(/\n/g)||[]).length;
 if(/\r(?!\n)/.test(text)||crlf&&crlf!==lf)return no('改行形式が混在しているか未対応です。');
 const newline=crlf?'\r\n':'\n';
 const lines=[];let a=0;
 for(let i=0;i<=originalBytes.length;i++)if(i===originalBytes.length||originalBytes[i]===10){let contentEnd=i;if(contentEnd>a&&originalBytes[contentEnd-1]===13)contentEnd--;let value;try{value=decoder.decode(originalBytes.subarray(a,contentEnd));}catch{return no('行単位の文字コードが不正です。');}lines.push({start:a,end:contentEnd,text:value});a=i+1;}
 const visible=s=>s.split('//')[0].trim();
 const starts=[],ends=[];
 for(let i=0;i<lines.length;i++){const t=visible(lines[i].text);if(/^#START\b/i.test(t))starts.push(i);if(/^#END\b/i.test(t))ends.push(i);}
 if(starts.length!==1||ends.length!==1||starts[0]>=ends[0])return no('最初の対応は単一コースのみです。START/ENDが複数または不明瞭なファイルは変更できません。');
 const si=starts[0],ei=ends[0];
 if(visible(lines[si].text).toUpperCase()!=='#START'||visible(lines[ei].text).toUpperCase()!=='#END')return no('プレイヤー指定など付加情報のあるSTART/ENDは未対応です。');
 const metadata=new Map();let noteSymbols=0,commands=0,emptyMeasures=0;
 for(let i=0;i<lines.length;i++){
  const t=visible(lines[i].text);if(!t||i===si||i===ei)continue;
  if(i>si&&i<ei){
   if(/^[A-Z][A-Z0-9_]*\s*:/i.test(t))return no('本体内にメタデータがあるため、安全に置き換えられません。');
   if(t.startsWith('#')){const name=/^#([A-Z]+)(?:\s|$)/i.exec(t)?.[1].toUpperCase();if(!COMMANDS.has(name))return no('分岐・DELAY・未知のコマンドを含む本体は未対応です。');commands++;}
   else if(/^[0-9AB,\s]+$/i.test(t)){noteSymbols+=(t.match(/[1-9AB]/gi)||[]).length;emptyMeasures+=(t.match(/,/g)||[]).length;}
   else return no('未知の譜面データがあり、安全に置き換えられません。');
  }else{
   if(t.startsWith('#'))return no('本体の外にコマンドがあります。');
   const match=/^([A-Z][A-Z0-9_]*)\s*:(.*)$/i.exec(t);
   if(!match)return no('ヘッダーの構造が不明瞭です。');
   const key=match[1].toUpperCase();if(metadata.has(key))return no('同じメタデータ項目が重複しています。');
   metadata.set(key,{value:match[2].trim(),line:i});
  }
 }
 for(const key of ['BPM','WAVE','OFFSET'])if(!metadata.has(key)||metadata.get(key).line>si)return no('BPM・WAVE・OFFSETは本体より前に一度ずつ必要です。');
 const wave=metadata.get('WAVE').value,offset=metadata.get('OFFSET').value,bpm=metadata.get('BPM').value;
 if(!wave||typeof options.audioName!=='string'||basename(wave)!==basename(options.audioName))return no('対象TJAのWAVEと現在の音源名が一致しません。');
 if(!numeric(offset)||!numeric(bpm)||Number(bpm)<=0)return no('保持するBPMまたはOFFSETヘッダーが不正です。');
 const draft=buildTimingDraft(result,options);
 if(!draft.available)return {...no('現在の解析・手動編集から安全な本体を生成できません。'),draft};
 if(Number(offset)!==draft.offset||Math.trunc(Number(offset)*1000)!==Math.trunc(draft.offset*1000))return no('保持するOFFSETと現在の下書き開始位置が一致しません。ヘッダーは自動変更しません。');
 const body=draft.text.slice(draft.text.indexOf('#START\n')).trimEnd();
 if(!body.startsWith('#START\n#BPMCHANGE ')||!body.endsWith('#END')||/[^\x00-\x7f]/.test(body))return no('生成本体が安全なASCII形式ではありません。');
 const replacement=new TextEncoder().encode(body.replaceAll('\n',newline));
 const from=lines[si].start,to=lines[ei].end;
 const bytes=new Uint8Array(from+replacement.length+originalBytes.length-to);
 bytes.set(originalBytes.subarray(0,from));bytes.set(replacement,from);bytes.set(originalBytes.subarray(to),from+replacement.length);
 return {available:true,bytes,draft,encoding:options.encoding,newline,bomPreserved:bom,
  metadataUnchanged:true,outsideBodyBytesUnchanged:true,originalByteLength:originalBytes.length,newByteLength:bytes.length,
  bodyByteRange:{start:from,end:to},oldBody:decoder.decode(originalBytes.subarray(from,to)),newBody:body.replaceAll('\n',newline),
  removed:{nonzeroNoteSymbols:noteSymbols,commands,measureCommas:emptyMeasures},
  warnings:['選択したSTART〜ENDの本体全体を置き換えます。元のノーツ・歌詞・スクロール等は削除されます。','本体以外のバイトは保持します。まだファイルへ書き込んでいません。','先頭のBPMCHANGEは現在の推定・手動BPMです。既存BPMヘッダーは変更しません。'],
  requiresExplicitReplacementConfirmation:true,writesPerformed:false};
}
