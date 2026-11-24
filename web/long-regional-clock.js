import {verifySteadyClock} from './steady-clock.js?v=30';
import {buildRegionalReference as buildLegacyReference,compareRegionalClockEvidence} from './regional-clocks.js?v=29';
const good=x=>Number.isFinite(x)&&x>0;
const distance=(a,b)=>good(a)&&good(b)?Math.abs(Math.log2(a/b)):Infinity;
const median=a=>{a=[...a].filter(Number.isFinite).sort((x,y)=>x-y);return a[Math.floor(a.length/2)]||0;};
const alias=(a,b)=>distance(a,b)>.12&&[.5,2/3,1.5,2,3].some(r=>distance(a/b,r)<.08);
function localAt(local,frame,fps){if(typeof local.evidenceAtFrame==='function')return local.evidenceAtFrame(frame);let best=null;for(const p of local.curve){const f=Number.isFinite(p.frame)?p.frame:p.time*fps;if(!best||Math.abs(f-frame)<best.distance)best={point:p,distance:Math.abs(f-frame)};}return best?.point;}
const integer=(a,b)=>{const r=Math.max(a/b,b/a),n=Math.round(r);return n>=2&&distance(r,n)<.04;};

export function automaticStableBlocks(automatic,fps,options={}){
 const values=(automatic.chosen||[]).map((p,i)=>({time:(automatic.centers?.[i]??p.frame)/fps,bpm:p.bpm})).filter(p=>Number.isFinite(p.time)&&good(p.bpm)),blocks=[];
 for(let i=0;i<values.length;){const first=i;let rates=[];while(i<values.length){const next=[...rates,values[i].bpm],rate=median(next);if(rates.length&&(Math.max(...next)-Math.min(...next))/rate>(options.maxRateSpread??.025))break;rates=next;i++;}const start=values[first].time,end=values[i-1].time;if(end>start)blocks.push({start,end,bpm:median(rates),span:end-start,rateSpread:(Math.max(...rates)-Math.min(...rates))/median(rates),samples:rates.length});}
 return blocks;
}
function rateClusters(curve,start,end){
 const points=(curve||[]).filter(p=>p.time>=start&&p.time<=end&&p.supported===true&&good(p.bpm)),groups=[];
 for(const p of points){let g=groups.find(g=>distance(g.bpm,p.bpm)<.04);if(!g){g={bpm:p.bpm,values:[]};groups.push(g);}g.values.push(p.bpm);g.bpm=median(g.values);}
 return groups.filter(g=>g.values.length>=3&&g.values.length>=points.length*.1).map(g=>g.bpm);
}
function crop(data,start,end,lowOnly=false){const a=Math.max(0,Math.round(start*data.fps)),b=Math.min(data.count,Math.round(end*data.fps));return{fps:data.fps,count:b-a,bandFlux:(lowOnly?[data.bandFlux[0]]:data.bandFlux).map(v=>v.slice(a,b))};}

/** Independent regional pulse-unit evidence. No final BPM values are supplied.
 * Fine unknowns do not establish or destroy the long audio clock, but every
 * query must retain original fine support and must not cross real inactivity.
 */
export function buildLongRegionalReference(data,automatic,original,firstLocal,referenceBpm,options={}){
 if(!(data?.fps>0)||!Number.isFinite(data.fps)||!Number.isInteger(data.count)||data.count<4||!Array.isArray(data.bandFlux)||data.bandFlux.length<2||data.bandFlux.slice(0,2).some(b=>!b||b.length<data.count)||typeof automatic?.tempoAtFrame!=='function'||!Array.isArray(automatic.chosen)||!Array.isArray(original?.curve)||!Array.isArray(firstLocal?.curve)||!good(referenceBpm))throw new TypeError('Verified regional clocks require complete native paths and two body bands.');
 const fps=data.fps,count=data.count,periodWindow=options.windowSeconds??4,minBlock=options.minBlockSeconds??12,blocks=automaticStableBlocks(automatic,fps,options),diagnostics=[],runs=[];
 const fine=original.curve.map(p=>({...p,frame:Number.isFinite(p.frame)?p.frame:p.time*fps}));
 const fineValid=p=>p?.supported===true&&good(p.bpm)&&Number.isFinite(p.coherence)&&p.coherence>=.04&&!p.tempoGap&&!p.manual&&!p.imputed;
 const lower=frame=>{let a=0,b=fine.length;while(a<b){let m=(a+b)>>>1;if(fine[m].frame<frame)a=m+1;else b=m;}return a;};
 const fineAt=frame=>{const i=lower(frame),b=fine[i],a=fine[Math.max(0,i-1)];return a&&b&&fineValid(a)&&fineValid(b)&&b.frame-a.frame<=fps*.5?{a,b}:null;};
 const energy=Float64Array.from({length:count},(_,i)=>Math.max(0,data.bandFlux[0][i]||0)+Math.max(0,data.bandFlux[1][i]||0)),positive=Array.from(energy).filter(good).sort((a,b)=>a-b),scale=positive[Math.floor((positive.length-1)*.9)]||0,prefix=new Float64Array(count+1);
 for(let i=0;i<count;i++)prefix[i+1]=prefix[i]+energy[i];
 const active=(frame,bpm)=>{const radius=Math.ceil(fps*Math.max(.16,45/bpm)),a=Math.max(0,Math.floor(frame-radius)),b=Math.min(count,Math.ceil(frame+radius+1));return scale>0&&b>a&&(prefix[b]-prefix[a])/(b-a)>=scale*(options.minActivityFraction??.025);};
 const silence=[];for(let i=0;i<count;){if(energy[i]>scale*.001){i++;continue;}const a=i;while(i<count&&energy[i]<=scale*.001)i++;if((i-a)/fps>=.32)silence.push({start:a/fps,end:i/fps});}
 const silent=(frame,bpm=automatic.tempoAtFrame(frame))=>silence.some(s=>s.end-s.start>=Math.max(.32,90/bpm)&&frame/fps>=s.start&&frame/fps<s.end);
 const sourceRates=blocks.map(b=>({time:b.start,bpm:b.bpm,span:b.span}));
 for(const block of blocks){
  if(block.span<minBlock)continue;
  const currentRates=rateClusters(firstLocal.curve,block.start,block.end);
  const hypotheses=[...currentRates,...rateClusters(original.curve,block.start,block.end),...rateClusters(original.curve,0,block.start),...rateClusters(firstLocal.curve,0,block.start),referenceBpm,automatic.referenceBpm,...sourceRates.filter(p=>p.time<block.start&&p.span>=4).map(p=>p.bpm)].filter(good),alternatives=[];
  for(const value of hypotheses)if(alias(block.bpm,value)&&alternatives.every(a=>distance(a.seed,value)>.008))alternatives.push({seed:value,current:currentRates.some(r=>distance(r,value)<.008)});
  const meaningful=alternatives.filter(a=>!integer(block.bpm,a.seed));
  if(!meaningful.length){diagnostics.push({block,status:'no-nonshared-alternative'});continue;}
  // Refine only the already-existing alternative hypotheses; do not search for
  // source-specific rates or infer a new main clock from these fits.
  const wholeLow=crop(data,block.start,block.end,true);
  for(const alt of alternatives){const c=verifySteadyClock(wholeLow,alt.seed,[],{minDuration:minBlock});alt.bpm=c.bpm||alt.seed;}
  const vetoes=[];
  for(let time=block.start;time<=block.end;time+=.5){
   const frame=time*fps;if(frame<periodWindow/2*fps||frame>count-periodWindow/2*fps)continue;if(!active(frame,block.bpm)||silent(frame,block.bpm)){vetoes.push({time,reason:'inactivity'});continue;}
   for(const alt of alternatives){if(integer(block.bpm,alt.bpm))continue;const proof=compareRegionalClockEvidence(data,frame,block.bpm,alt.bpm,{windowSeconds:periodWindow});if(proof.bands?.some(b=>b.oldDirect)){vetoes.push({time,reason:'returning-alternative-fundamental',alternative:alt.bpm});break;}}
  }
  const inactive=silence.filter(s=>s.end-s.start>=Math.max(.32,90/block.bpm)&&s.end>block.start&&s.start<block.end),epochs=[];let start=block.start;
  for(const gap of inactive){if(gap.start>start)epochs.push({start,end:Math.min(block.end,gap.start)});start=Math.max(start,gap.end);}if(start<block.end)epochs.push({start,end:block.end});
  for(const epoch of epochs){
   const stop=vetoes.find(v=>v.time>=epoch.start+periodWindow/2&&v.time<epoch.end),end=stop?stop.time:epoch.end;
   if(end-epoch.start<minBlock){diagnostics.push({block,epoch:{start:epoch.start,end},status:'insufficient-uncontradicted-span',stop});continue;}
   const segment=crop(data,epoch.start,end),clock=verifySteadyClock(segment,block.bpm,[],{minDuration:minBlock}),low=verifySteadyClock({...segment,bandFlux:[segment.bandFlux[0]]},block.bpm,[],{minDuration:minBlock}),h1=low.clocks?.find(c=>c.band===0&&c.harmonic===1);
   const lowH1=!!h1&&h1.globalCoherence>=.025&&h1.resultant>=.98&&h1.coverage>=.95&&h1.positiveCoverage>=.95;
   const comparisons=meaningful.map(alt=>({alternative:alt.bpm,current:alt.current,proof:compareRegionalClockEvidence(segment,segment.count/2,low.bpm||block.bpm,alt.bpm,{windowSeconds:segment.count/fps})}));
   const exclusive=comparisons.some(c=>c.current&&c.proof.supported)&&!comparisons.some(c=>c.proof.bands?.some(b=>b.oldDirect));
   const accepted=clock.accepted&&low.accepted&&lowH1&&exclusive,entry={block,epoch:{start:epoch.start,end},status:accepted?'verified-long-regional-clock':'unproved',clock,low,h1,lowH1,comparisons,stop};diagnostics.push(entry);
   if(accepted)runs.push({start:epoch.start,end,referenceBpm:block.bpm,verifiedBpm:low.bpm,evidenceStart:epoch.start,evidenceEnd:end,source:'long-verified-regional-clock',requiresReview:true,alternatives:alternatives.map(a=>a.bpm),stop});
  }
 }
 const globalSeeds=[referenceBpm,automatic.referenceBpm,...sourceRates.filter(p=>p.span>=4).map(p=>p.bpm),...rateClusters(original.curve,0,count/fps),...rateClusters(firstLocal.curve,0,count/fps)].filter(good);
 const queryCache=new Map(),integerRefusals=new Map();
 const queryGuard=frame=>{
  if(queryCache.has(frame))return queryCache.get(frame);
  let result=null;
  if(Number.isFinite(frame)&&frame>=periodWindow/2*fps&&frame<=count-periodWindow/2*fps&&!silent(frame)){
   const before=fineAt(frame),candidate=automatic.tempoAtFrame(frame),current=localAt(firstLocal,frame,fps);
   const integerAlternative=current?.supported===true&&good(current.bpm)&&distance(current.bpm,candidate)>.12&&integer(current.bpm,candidate);
   if(before&&good(candidate)&&active(frame,candidate)&&distance(before.a.bpm,candidate)<.10&&distance(before.b.bpm,candidate)<.10){
    const values=[...globalSeeds,...runs.filter(r=>frame/fps>=r.start&&frame/fps<r.end).flatMap(r=>r.alternatives),current?.supported?current.bpm:null],alternatives=[];
    for(const value of values)if(good(value)&&distance(value,candidate)>.12&&!integer(value,candidate)&&alternatives.every(a=>distance(a,value)>.008))alternatives.push(value);
    let opposed=false;
    for(const alternative of alternatives){const proof=compareRegionalClockEvidence(data,frame,candidate,alternative,{windowSeconds:periodWindow});if(proof.bands?.some(b=>b.oldDirect)){opposed=true;break;}}
    if(!opposed){if(integerAlternative)integerRefusals.set(frame,{candidateBpm:candidate,alternativeBpm:current.bpm});else result={candidate};}
   }
  }
  queryCache.set(frame,result);return result;
 };
 const queryProof=frame=>{if(!runs.some(r=>frame/fps>=r.start&&frame/fps<r.end))return null;const q=queryGuard(frame);if(!q)return null;const run=runs.find(r=>frame/fps>=r.start&&frame/fps<r.end&&distance(q.candidate,r.referenceBpm)<=.10);return run?{...q,run}:null;};
 const supportsFrame=frame=>!!queryProof(frame),referenceAtFrame=frame=>queryProof(frame)?.candidate??referenceBpm,evidenceAtFrame=frame=>{const q=queryProof(frame);return q?{supported:true,bpm:q.candidate,source:q.run.source,requiresReview:true}:{supported:false,bpm:null,source:'uncertain'};};
 const integerAmbiguityAtFrame=frame=>{queryGuard(frame);return integerRefusals.get(frame)||null;};
 return{runs,diagnostics,supportsFrame,referenceAtFrame,evidenceAtFrame,silence,queryGuard,integerAmbiguityAtFrame};
}

export function buildRegionalReference(data,automatic,original,firstLocal,referenceBpm,options={}){
 const legacy=buildLegacyReference(data,automatic,original,firstLocal,referenceBpm,options),long=buildLongRegionalReference(data,automatic,original,firstLocal,referenceBpm,options);
 const contains=frame=>Number.isFinite(frame)&&[...legacy.runs,...long.runs].some(run=>frame/data.fps>=run.start&&frame/data.fps<run.end);
 const supportsFrame=frame=>contains(frame)&&!!long.queryGuard(frame)&&(long.supportsFrame(frame)||legacy.supportsFrame(frame));
 const referenceAtFrame=frame=>!contains(frame)||!long.queryGuard(frame)?referenceBpm:long.supportsFrame(frame)?long.referenceAtFrame(frame):legacy.referenceAtFrame(frame);
 const integerAmbiguityAtFrame=frame=>contains(frame)?long.integerAmbiguityAtFrame(frame):null;
 const evidenceAtFrame=frame=>!supportsFrame(frame)?{supported:false,bpm:null,source:'uncertain'}:{supported:true,bpm:referenceAtFrame(frame),source:long.supportsFrame(frame)?'long-verified-regional-clock':'regional-clock',requiresReview:true};
 return {runs:[...legacy.runs,...long.runs],supportsFrame,referenceAtFrame,evidenceAtFrame,integerAmbiguityAtFrame};
}
