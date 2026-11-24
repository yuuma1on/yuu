import { detectSmallTempoSteps } from './small-tempo-steps.js?v=17';
export const METRICAL_ALIAS_RATIOS=Object.freeze([1/3,.5,2/3,3/4,4/3,1.5,2,3]);
const positive=value=>Number.isFinite(value)&&value>0;
export function isMetricalAlias(fromBpm,toBpm,tolerance=.035){
  return positive(fromBpm)&&positive(toBpm)&&METRICAL_ALIAS_RATIOS.some(ratio=>Math.abs(Math.log2(fromBpm/toBpm/ratio))<=tolerance);
}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const median=a=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:NaN;};
const quantile=(a,q)=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.floor((s.length-1)*q)]:NaN;};
function linear(points){
  const x0=points[0].time,n=points.length;let x=0,y=0,xx=0,xy=0,yy=0;
  for(const p of points){const t=p.time-x0;x+=t;y+=p.bpm;xx+=t*t;xy+=t*p.bpm;yy+=p.bpm*p.bpm;}
  const slope=(xy-x*y/n)/Math.max(1e-9,xx-x*x/n),intercept=y/n-slope*x/n;
  const explained=slope*slope*(xx-x*x/n),r2=explained/Math.max(1e-9,yy-y*y/n);
  return {slope,intercept,x0,r2,predict:t=>intercept+slope*(t-x0)};
}
function endpoint(points,a,b){
  const selected=points.filter(p=>!p.imputed&&p.time>=a&&p.time<=b),values=selected.map(p=>p.bpm);
  const center=median(values),spread=values.length?(quantile(values,.9)-quantile(values,.1))/center:Infinity;
  return {bpm:center,spread,count:values.length,span:selected.length?selected.at(-1).time-selected[0].time:0,
    start:selected[0]?.time,end:selected.at(-1)?.time,ambiguousCount:selected.filter(p=>p.tempoAmbiguous).length,startsAfterGap:!!selected[0]?.tempoGap};
}

function directOnsetBoundary(times,center,fromBpm,toBpm){
  if(!Array.isArray(times)||times.length<8||Math.abs(Math.log(toBpm/fromBpm))<.08)return null;
  const before=60/fromBpm,after=60/toBpm,reach=Math.max(1.5,after*2);
  let best=null;
  for(let i=3;i+3<times.length;i++){
    if(Math.abs(times[i]-center)>reach)continue;
    const left=[times[i-2]-times[i-3],times[i-1]-times[i-2],times[i]-times[i-1]];
    const right=[times[i+1]-times[i],times[i+2]-times[i+1],times[i+3]-times[i+2]];
    if(left.some(p=>Math.abs(p/before-1)>.08)||right.some(p=>Math.abs(p/after-1)>.08))continue;
    const error=left.reduce((sum,p)=>sum+Math.abs(p/before-1),0)+right.reduce((sum,p)=>sum+Math.abs(p/after-1),0);
    if(!best||error<best.error)best={time:times[i],error};
  }
  return best;
}

/** Detect supported changes in the fine audio-derived tempo curve. A verified
 * fixed clock wins over local phase noise. Short unresolved staircases remain
 * broad trends; this function does not infer hidden stage counts.
 */
export function detectTempoChanges(points,duration,options={}){
  if(options.constantClock||options.constant||options.tempoModel==='constant-clock')return [];
  const raw=points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.bpm)&&p.bpm>0).sort((a,b)=>a.time-b.time);
  if(raw.length<8)return [];
  const dt=median(raw.slice(1).map((p,i)=>p.time-raw[i].time).filter(v=>v>0)),minEvidence=options.minEvidence??.04;
  const valid=raw.filter(p=>p.supported!==false&&(!Number.isFinite(p.coherence??p.tempoEvidence)||(p.coherence??p.tempoEvidence)>=minEvidence));
  if(valid.length<8)return [];
  // Interpolate only short unsupported gaps; differentiation of rejected raw
  // aliases would invent extra changes. Keep these gaps in timing uncertainty.
  const filled=[];
  for(let i=0;i<valid.length;i++){
    const p=valid[i],previous=valid[i-1];
    if(previous&&p.time-previous.time>dt*1.75&&p.time-previous.time<=1.28){
      for(let t=previous.time+dt;t<p.time-dt*.4;t+=dt){const f=(t-previous.time)/(p.time-previous.time);filled.push({time:t,bpm:previous.bpm*(1-f)+p.bpm*f,imputed:true,gap:p.time-previous.time});}
    }filled.push({...p,tempoGap:!!p.tempoGap&&(!previous||p.time-previous.time>1.28)});
  }
  const blocks=[];for(const p of filled){const b=blocks.at(-1);if(!b||p.tempoGap||p.time-b.at(-1).time>Math.max(1.5,dt*4))blocks.push([p]);else b.push(p);}
  const events=[];
  for(const block of blocks){
    if(block.length<8||block.at(-1).time-block[0].time<2)continue;
    const filtered=block.map((p,i)=>({...p,bpm:median(block.slice(Math.max(0,i-1),Math.min(block.length,i+2)).map(q=>q.bpm))}));
    const interior=filtered.filter(p=>p.time>=block[0].time+1&&p.time<=block.at(-1).time-1&&!p.imputed);
    if(interior.length<6)continue;
    const model=linear(interior),span=interior.at(-1).time-interior[0].time,total=model.slope*span,rate=median(interior.map(p=>p.bpm));
    let forward=0,comparisons=0;
    for(let i=0;i<interior.length;i++){let j=i+1;while(j<interior.length&&interior[j].time-interior[i].time<.8)j++;if(j<interior.length){comparisons++;if(Math.sign(total)*(interior[j].bpm-interior[i].bpm)>-.0015*rate)forward++;}}
    const start=Math.max(0,block[0].time),end=Math.min(duration,block.at(-1).time);
    const first=endpoint(filtered,start,start+1),last=endpoint(filtered,end-1,end);
    const from=model.predict(start),to=model.predict(end),endpointTolerance=Math.max(2,rate*.025);
    // A high overall R² can still extend a ramp through a final plateau, even
    // below zero. Only use a whole-block line when both observed ends agree.
    const linearEnds=Number.isFinite(from)&&Number.isFinite(to)&&from>0&&to>0&&
      Math.abs(from-first.bpm)<=endpointTolerance&&Math.abs(to-last.bpm)<=endpointTolerance;
    if(span>=10&&Math.abs(total)/rate>(options.minTrendChange??.025)&&model.r2>.92&&forward/Math.max(1,comparisons)>.72&&linearEnds){
      events.push({start,end,fromBpm:from,toBpm:to,type:total>0?'accelerando':'ritardando',confidence:clamp(.5+.45*model.r2,0,.95),timeUncertainty:Math.max(.32,dt*2),source:'tempo-curve',rateSupport:{before:first,after:last}});continue;
    }
    const slopes=filtered.map((p,i)=>{
      const window=filtered.filter(q=>Math.abs(q.time-p.time)<=Math.max(.49,dt*3.1));
      let x=0,y=0,xx=0,xy=0;for(const q of window){const t=q.time-p.time,v=Math.log(q.bpm);x+=t;y+=v;xx+=t*t;xy+=t*v;}
      return (xy-x*y/window.length)/Math.max(1e-9,xx-x*x/window.length);
    });
    const threshold=options.slopeThreshold??.018;
    const activity=slopes.map((s,i)=>filtered[i].time<2||filtered[i].time>duration-2?0:s>threshold?1:s< -threshold?-1:0);
    // Fill short holes only between changes with the same direction.
    for(let i=1;i<activity.length-1;i++)if(activity[i]===0){let j=i;while(j<activity.length&&activity[j]===0)j++;if(j<activity.length&&filtered[j].time-filtered[i-1].time<=(options.mergeGap??1.4)&&activity[i-1]===activity[j])for(let k=i;k<j;k++)activity[k]=activity[j];i=j-1;}
    const runs=[];for(let i=0;i<activity.length;){if(!activity[i]){i++;continue;}const a=i,sign=activity[i];while(i<activity.length&&activity[i]===sign)i++;if(i-a>=2)runs.push({a,b:i-1,sign});}
    for(let r=0;r<runs.length;r++){
      const run=runs[r],start0=filtered[run.a].time,end0=filtered[run.b].time;
      // Small oscillations in phase estimates must not block the stable context
      // of a real change. Large excursions and broad trends still delimit it.
      const delimiting=q=>filtered[q.b].time-filtered[q.a].time>=3||Math.abs(Math.log(filtered[q.b].bpm/filtered[q.a].bpm))>.04;
      const left=runs.slice(0,r).filter(delimiting).at(-1),right=runs.slice(r+1).find(delimiting);
      const previous=left?filtered[left.b].time+.24:block[0].time,next=right?filtered[right.a].time-.24:block.at(-1).time;
      let before=endpoint(filtered,Math.max(previous,start0-10),start0-.24),after=endpoint(filtered,end0+.24,Math.min(next,end0+10));
      // Adjacent rising/falling trends share a turning region rather than a
      // plateau. For broad changes retain the observed endpoint of that region.
      if(end0-start0>=3&&Math.abs(Math.log(filtered[run.b].bpm/filtered[run.a].bpm))>.04){
        if(before.count<3)before=endpoint(filtered,start0,start0+.64);
        if(after.count<3)after=endpoint(filtered,end0-.64,end0);
      }
      if(before.count<3||after.count<3)continue;
      const delta=Math.log(after.bpm/before.bpm),relative=Math.abs(delta),persistent=before.spread<.025&&after.spread<.025;
      if(Math.sign(delta)!==run.sign||relative<(persistent?.014:.04))continue;
      if(relative<.04&&(before.span<.75||after.span<.75))continue;
      const differences=filtered.slice(run.a,run.b+1).slice(1).map((p,i)=>run.sign*Math.log(p.bpm/filtered[run.a+i].bpm));
      const monotonic=differences.filter(v=>v>-.002).length/Math.max(1,differences.length);
      const runModel=linear(filtered.slice(run.a,run.b+1));
      if(monotonic<.6&&runModel.r2<.85)continue;
      const width=end0-start0,center=(start0+end0)/2;
      const anchors=(options.anchors||[]).filter(a=>Number.isFinite(a.time)&&Math.abs(a.time-center)<=Math.max(.35,dt*2.5));
      const step=width<=1.5||(anchors.length===1&&width<=2.2&&persistent);
      let start=start0,end=end0,uncertainty=Math.max(.32,dt*2);
      if(step){
        const direct=directOnsetBoundary(options.onsets,center,before.bpm/(options.onsetScale||1),after.bpm/(options.onsetScale||1));
        const midpoint=direct?direct.time:anchors.length===1?anchors[0].time:center;
        uncertainty=direct||anchors.length===1?Math.max(.12,dt):Math.min(.65,Math.max(.32,width/2));
        start=Math.max(0,midpoint-uncertainty);end=Math.min(duration,midpoint+uncertainty);
      }
      const missing=filtered.slice(run.a,run.b+1).filter(p=>p.imputed),largestGap=Math.max(0,...missing.map(p=>p.gap||0));uncertainty=Math.max(uncertainty,largestGap/2);
      const effect=clamp(relative/.06,0,1),stability=persistent?1:.6,confidence=clamp(.28+.28*effect+.24*stability+.15*monotonic-.18*(missing.length/Math.max(1,run.b-run.a+1)),.2,.95);
      events.push({start,end,fromBpm:before.bpm,toBpm:after.bpm,type:step?'step':delta>0?'accelerando':'ritardando',confidence,timeUncertainty:uncertainty,source:'tempo-curve',rateSupport:{before,after}});
    }
  }
  for(const candidate of detectSmallTempoSteps(points,duration))if(!events.some(event=>event.end>=candidate.start-2&&event.start<=candidate.end+2))events.push(candidate);
  return events.sort((a,b)=>a.start-b.start);
}

/** Review guard only: never changes rate, time, event type, or curve samples.
 * Apply again after beat-step/ramp merges in analysis.js. A compatible ratio is
 * a possible change of metrical interpretation, not proof the event is false.
 */
export function annotateTempoChangeEvidence(changes,points,options={}){
  const cap=options.confidenceCap??.65,near=options.fallbackSeconds??.75;
  const ordered=points.filter(point=>Number.isFinite(point.time)).sort((a,b)=>a.time-b.time);
  return changes.map(change=>{
    const out={...change},declared=[change.rateSupport?.before,change.rateSupport?.after].filter(s=>s&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>=s.start);
    const supports=declared.length?declared:[{start:Number.isFinite(change.supportStart)?change.supportStart:change.start-near,end:Number.isFinite(change.supportEnd)?change.supportEnd:change.end+near}];
    const start=Math.min(...supports.map(s=>s.start)),end=Math.max(...supports.map(s=>s.end));
    const inSupport=point=>supports.some(s=>point.time>=s.start-1e-8&&point.time<=s.end+1e-8);
    const reasons=new Set(change.reviewReasons||[]);
    const rateSupportDeclared=declared.length>0||Number.isFinite(change.supportStart)&&Number.isFinite(change.supportEnd);
    const rateSupportAmbiguous=rateSupportDeclared&&(supports.some(s=>s.ambiguousCount>0)||ordered.some(point=>point.tempoAmbiguous&&inSupport(point)));
    const transitionAmbiguous=ordered.some(point=>point.tempoAmbiguous&&point.time>=change.start-near&&point.time<=change.end+near);
    const supportAmbiguous=rateSupportAmbiguous||transitionAmbiguous;
    const unknownInside=ordered.some(point=>point.time>=start-1e-8&&point.time<=end+1e-8&&(!positive(point.bpm)||point.supported===false||point.tempoSource==='uncertain'));
    const beginsAfterUnknown=supports.some(s=>{
      if(s.startsAfterGap)return true;
      const first=ordered.find(point=>point.time>=s.start-1e-8&&point.time<=s.end+1e-8),index=ordered.indexOf(first),previous=ordered[index-1];
      return first?.tempoGap||previous&&first.time-previous.time<=near&&(!positive(previous.bpm)||previous.supported===false);
    });
    const independent=change.beatTimingVerified===true||['regular-beat-timing-step','verified-beat-timing-step','verified-beat-timing-trend','beat-phase-ramp'].includes(change.source);
    const unresolvedRatio=isMetricalAlias(change.fromBpm,change.toBpm)&&!independent;
    if(rateSupportAmbiguous)reasons.add('metrical-ambiguity-in-rate-support');
    if(transitionAmbiguous)reasons.add('metrical-ambiguity-near-transition');
    if(unresolvedRatio)reasons.add('metrical-ratio-without-independent-timing');
    if(unknownInside)reasons.add('unknown-in-rate-support');
    if(beginsAfterUnknown)reasons.add('rate-support-begins-after-unknown');
    if(reasons.size){
      out.requiresReview=true;out.confidence=Math.min(cap,Number.isFinite(change.confidence)?change.confidence:.5);out.reviewReasons=[...reasons];
      if(supportAmbiguous||unresolvedRatio)out.ambiguity=change.ambiguity||'metrical-level';
    }
    return out;
  });
}
