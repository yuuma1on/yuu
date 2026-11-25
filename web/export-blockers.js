import {buildTimingDraft} from './tja-export.js?v=34';
export const CONSTANT_UNCERTAINTY_ERROR='未推定・不確かな区間が含まれます。全区間を一定BPMで補完して書き出すことはできません。';
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const LABELS=Object.freeze({missingRate:'BPMが未推定または不正',continuityMarker:'推定の連続性が途切れた印',uncertainSource:'推定元が判定保留',candidateRegion:'独立したBPM候補の領域'});
function reasons(p){const r=[];if(!p||!finite(p.bpm)||p.bpm<=0)r.push('missingRate');if(p?.tempoGap)r.push('continuityMarker');if(p?.tempoSource==='uncertain')r.push('uncertainSource');return r;}
/** Read-only explanation of the EXISTING serializer gate, not a new detector.
 * Sample spans use only actual first/last rejected timestamps. They are not
 * acoustic/silence/change boundaries and never include neighboring valid points.
 */
export function deriveConstantExportBlockers(result){
 const empty={applicable:false,items:[],unlocated:[],rejectedSampleCount:0,regionCount:0};
 let draft;try{draft=buildTimingDraft(result);}catch{return {...empty,otherFailure:'malformed-input-structure'};}
 if(draft.errors?.[0]!==CONSTANT_UNCERTAINTY_ERROR)return {...empty,otherFailure:draft.errors?.[0]||null};
 const duration=result.duration,items=[],unlocated=[];let group=null,rejectedSampleCount=0;
 const flush=()=>{if(group)items.push(group);group=null;};
 const curve=Array.isArray(result.tempoCurve)?result.tempoCurve:[];
 for(let index=0;index<curve.length;index++){
  const point=curve[index],codes=reasons(point);if(!codes.length){flush();continue;}
  rejectedSampleCount++;
  if(!finite(point?.time)||point.time<0||point.time>duration){flush();unlocated.push({kind:'sample',index,reasons:codes,labels:codes.map(c=>LABELS[c]),reason:'時刻が不正または音源範囲外のため場所を特定できません。'});continue;}
  const key=codes.join('|');
  // Display grouping only: require consecutive indices, same reasons and
  // nondecreasing close timestamps. No missing duration is inferred.
  if(group&&group.lastIndex===index-1&&group.reasonKey===key&&point.time>=group.end&&point.time-group.end<=1){group.end=point.time;group.lastIndex=index;group.sampleCount++;}
  else{flush();group={kind:'sample-span',start:point.time,end:point.time,firstIndex:index,lastIndex:index,sampleCount:1,reasons:codes,labels:codes.map(c=>LABELS[c]),reasonKey:key,seekTime:point.time,boundsMeaning:'first-and-last-rejected-sample-times'};}
 }
 flush();
 const regions=Array.isArray(result.tempoRegions)?result.tempoRegions:[];
 for(let index=0;index<regions.length;index++){
  const r=regions[index],base={kind:'candidate-region',index,reasons:['candidateRegion'],labels:[LABELS.candidateRegion]};
  if(!r||!finite(r.start)||!finite(r.end)||r.start<0||r.end<r.start||r.end>duration){unlocated.push({...base,reason:'候補領域の時刻が不正または音源範囲外のため場所を特定できません。'});continue;}
  items.push({...base,start:r.start,end:r.end,seekTime:r.start,boundsMeaning:'existing-candidate-region-not-acoustic-boundaries'});
 }
 if(result.tempoRegions?.length&&!Array.isArray(result.tempoRegions))unlocated.push({kind:'candidate-region',reason:'候補領域のデータ形式が不正です。',reasons:['candidateRegion'],labels:[LABELS.candidateRegion]});
 return {applicable:true,error:CONSTANT_UNCERTAINTY_ERROR,items,unlocated,rejectedSampleCount,regionCount:regions.length,readOnly:true,
  explanation:'表示時刻は拒否された推定サンプルの最初・最後、または既存の候補領域です。実際の変化・無音の境界ではありません。連続性の印にはBPMがある場合もあります。'};
}
