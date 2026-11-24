/** Inferred/manual timing draft, target OpenTaiko default CTja.cs arithmetic.
 * No notes, source TJA, display scaling, synthetic meter, or inferred musical meter.
 * Compatibility model is source-based; actual engine has not been run.
 */
const MAX_DRIFT=.0001, MAX_BARS=50000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function readMeter(value){
 if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))return null;
 const [numerator,denominator]=value.split('/').map(Number);
 if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||numerator<1||denominator<1||numerator>1e6||denominator>1e6||numerator/denominator>64)return null;
 return {numerator,denominator,text:`${numerator}/${denominator}`};
}
function meta(value,fallback){const s=value===undefined?fallback:value;if(typeof s!=='string'||!s.trim()||s.length>200||/[\x00-\x1f\x7f:#/\\\u2028\u2029]/u.test(s))throw Error('タイトル・音源名に改行、制御文字、コマンド記号、パスは使用できません。');return s.trim();}
export function buildTimingDraft(result,options={}){
 const warnings=['推定・手動編集から作るタイミング下書きです。ノーツはありません。','確認した拍子の完全な小節だけを書き出します。時刻合わせのための架空のMEASUREは作りません。','OpenTaiko標準モードの公開ソースに基づく数値モデルです。実機動作と他エンジンの互換性は未確認です。'];
 const base={available:false,text:null,preview:[],warnings,errors:[],omitted:[],target:'OpenTaiko-default-source-model',referenceUsed:false,displayScaleUsed:false};
 const fail=message=>({...base,errors:[message]});
 if(!result||result.referenceOnly||result.source==='tja-reference')return fail('音声解析または手動編集の結果が必要です。参照TJAは出力元にできません。');
 if(result.tempoAmbiguous)warnings.push('拍単位に複数の解釈があります。現在の元推定をそのまま出力します。');
 if(finite(result.confidence)&&result.confidence<.5)warnings.push('元解析の拍の確信度が低めです。出力精度を保証しません。');
 const duration=result.duration;if(!finite(duration)||duration<=0||duration>86400)return fail('音源の長さが不正です。');
 let sections=[];
 if(result.tempoModel==='manual'){
  if(!Array.isArray(result.sections)||!result.sections.length)return fail('手動区間がありません。');
  if(result.sections.some(s=>!s||typeof s!=='object'))return fail('手動区間の形式が不正です。');
  sections=result.sections.filter(s=>s.manual===true).map(s=>({...s})).sort((a,b)=>a.start-b.start);
  if(!sections.length)return fail('書き出せる手動区間がありません。');
  // A partial selection must never silently drop other existing sections.
  if(result.sections.some(s=>s.manual!==true))return fail('自動推定と手動区間が混在しています。全ての対象区間を手動確認してから書き出してください。');
 }else if(result.tempoModel==='constant-clock'){
  if(!finite(result.bpm)||!finite(result.constantTempo?.bpm)||Math.abs(result.bpm-result.constantTempo.bpm)>1e-8)return fail('一定テンポの元推定が確認できません。');
  if(result.tempoChanges?.length||result.sections?.some(s=>s.manual))return fail('一定テンポの結果に変更・手動情報が混在しています。');
  if(result.tempoRegions?.length||result.tempoCurve?.some(p=>!p||!finite(p.bpm)||p.bpm<=0||p.tempoGap||p.tempoSource==='uncertain'))return fail('未推定・不確かな区間が含まれます。全区間を一定BPMで補完して書き出すことはできません。');
  warnings.push('一定テンポを音源の先頭から末尾まで適用する下書きです。前後の無音も含み、全ての時刻で音響的に検証済みという意味ではありません。');
  sections=[{start:0,end:duration,bpm:result.bpm}];warnings.push('OFFSET 0は音源時計の原点です。最初の拍・小節頭の特定を意味しません。');
 }else return fail('変動テンポの変化候補には確定時刻がありません。対象区間を手動確認してから書き出してください。');
 if(sections.some(s=>!finite(s.start)||!finite(s.end)||!finite(s.bpm)||s.start<0||s.end<=s.start||s.end>duration||s.bpm<=0||s.bpm>2000))return fail('区間の時刻またはBPMが不正です。');
 for(let i=1;i<sections.length;i++)if(sections[i].start!==sections[i-1].end)return fail('手動区間に隙間または重複があります。未推定時間を補間して書き出すことはできません。');
 const start=sections[0].start,end=sections.at(-1).end,ms=Math.round(start*1000),offset=start===0?0:-start;
 if(Math.abs(start*1000-ms)>1e-8||Math.trunc(offset*1000)!==-ms)return fail('開始時刻はミリ秒単位かつOFFSET読込で一致する値が必要です。自動丸めはしません。');
 if(start>0)base.omitted.push({start:0,end:start,reason:'before-manual-range'});
 if(end<duration)base.omitted.push({start:end,end:duration,reason:'after-manual-range'});
 if(base.omitted.length)warnings.push('手動区間の前後は含めません。プレビューの省略範囲を確認してください。');
 const override=options.confirmedMeter===undefined||options.confirmedMeter===null?null:readMeter(options.confirmedMeter);
 if(options.confirmedMeter!=null&&!override)return fail('確認済み拍子の形式が不正です。例: 4/4、6/4。');
 for(const section of sections){
  const own=section.meterConfirmed===true?readMeter(section.meter):null;
  const meter=result.tempoModel==='constant-clock'?override:own;
  if(!meter)return fail('拍子を明示的に確認してください。自動推定や未確認の拍子はMEASUREに使用しません。');
  if(result.tempoModel==='manual'&&((section.numerator!=null&&section.numerator!==meter.numerator)||(section.denominator!=null&&section.denominator!==meter.denominator)))return fail('確認済み拍子と分子・分母が一致しません。');
  section.confirmedMeter=meter;
 }
 let title,audioName;
 try{title=meta(options.title,'PULSE timing draft');audioName=meta(options.audioName,'audio.ogg');}catch(e){return fail(e.message);}
 const headers=['TITLE','SUBTITLE','BPM','WAVE','OFFSET','DEMOSTART','SONGVOL','SEVOL','SCOREMODE','COURSE','LEVEL','BALLOON','SCOREINIT','SCOREDIFF'];
 const metadataSuggestions={TITLE:title,BPM:String(sections[0].bpm),WAVE:audioName,OFFSET:String(offset),COURSE:'Oni',LEVEL:'0'};
 warnings.unshift('全ヘッダーが空欄のテンプレートです。そのままでは読み込めません。BPM・WAVE・OFFSETなど必要なヘッダーを記入してください。');
 const lines=[...headers.map(key=>key+':'),'#START',`#BPMCHANGE ${sections[0].bpm}`];
 let modeled=start,bars=0,maxDrift=0,previousMeter=null,previousBpm=sections[0].bpm;
 for(let i=0;i<sections.length;i++){
  const s=sections[i],meter=s.confirmedMeter;
  const period=240/s.bpm*(meter.numerator/meter.denominator),count=(s.end-s.start)/period,nearest=Math.round(count);
  // Floating-point representation epsilon only, not musical-time rounding.
  const epsilon=64*Number.EPSILON*Math.max(1,Math.abs(s.end),Math.abs(s.start),period*Math.max(1,nearest));
  const aligned=Math.abs((s.start+nearest*period)-s.end)<=epsilon;
  if(i<sections.length-1&&!aligned)return fail('区間の境界が確認済み拍子の小節末と一致しません。小節途中のBPM変更は空小節だけでは表現できないため、時刻を丸めず停止しました。');
  const countBars=aligned?nearest:Math.floor(count);
  if(countBars<1)return fail('完全な小節がない区間は書き出せません。');
  if(bars+countBars>MAX_BARS)return fail('空小節数が上限を超えます。');
  if(i&&s.bpm!==previousBpm)lines.push(`#BPMCHANGE ${s.bpm}`);
  if(meter.text!==previousMeter)lines.push(`#MEASURE ${meter.text}`);
  const ratio=Math.fround(Math.fround(meter.numerator)/Math.fround(meter.denominator));
  for(let n=0;n<countBars;n++){lines.push(',');modeled+=240/s.bpm*ratio;bars++;}
  const nominalEnd=s.start+countBars*period,error=modeled-nominalEnd;
  maxDrift=Math.max(maxDrift,Math.abs(error));
  if(!aligned){base.omitted.push({start:nominalEnd,end:s.end,reason:'incomplete-final-measure'});warnings.push('最後の不完全な小節は省略します。時刻を合わせるために拍子を変更しません。');}
  base.preview.push({start:s.start,end:nominalEnd,requestedEnd:s.end,bpm:s.bpm,meter:meter.text,source:result.tempoModel==='manual'?'manual':'inferred-constant',encodedEnd:modeled,errorSeconds:error,fullBars:countBars});
  previousMeter=meter.text;previousBpm=s.bpm;
 }
 lines.push('#END','');
 const previewText=lines.join('\n'),details={...base,previewText,metadataSuggestions,templateOnly:true,requiresHeaderCompletion:true,barCount:bars,offset,range:{start,end:base.preview.at(-1).end,requestedEnd:end},maxBoundaryErrorSeconds:maxDrift,requiresApproximationPermission:false,engineRuntimeVerified:false};
 if(maxDrift>MAX_DRIFT)return {...details,errors:['数値モデル上の累積時刻誤差が0.1msを超えるため書き出しを停止しました。']};
 warnings.push('確認済み拍子の数値表現に伴う境界差をプレビューに表示します。測定誤差の保証ではありません。');
 return {...details,available:true,text:previewText};
}
