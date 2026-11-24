/** Review-only contrasts across explicitly unestimated curve samples.
 * Frozen before corpus evaluation. Not a tempo detector, confidence estimate,
 * interpolation, or assertion that any change happened inside the bracket.
 */
export const UNRESOLVED_GAP_CRITERIA = Object.freeze({
  minBracketSeconds: 1, maxBracketSeconds: 15, neighborSeconds: 4,
  minObservedSpanSeconds: 2, maxSampleSpacingSeconds: .5,
  withinMedianRelativeTolerance: .02, minStableFraction: .8,
  minMedianEvidence: .04, minRelativeContrast: .05,
});
const finite = x => typeof x === 'number' && Number.isFinite(x);
const rate = x => finite(x) && x > 0;
const median = xs => { const s = [...xs].sort((a,b)=>a-b), n=s.length; return n%2?s[n>>1]:(s[n/2-1]+s[n/2])/2; };
const EPS=1e-9;
function windowSummary(curve, index, direction) {
  const c=UNRESOLVED_GAP_CRITERIA, anchor=curve[index].time, samples=[];
  for(let i=index;i>=0&&i<curve.length;i+=direction){
    const p=curve[i];
    if(!rate(p.bpm)||Math.abs(p.time-anchor)>c.neighborSeconds+EPS)break;
    if(samples.length&&Math.abs(p.time-samples.at(-1).time)>c.maxSampleSpacingSeconds+EPS)break;
    samples.push(p);
  }
  if(samples.length<2)return null;
  const start=Math.min(samples[0].time,samples.at(-1).time), end=Math.max(samples[0].time,samples.at(-1).time);
  if(end-start<c.minObservedSpanSeconds-EPS)return null;
  const bpm=median(samples.map(p=>p.bpm));
  const deviations=samples.map(p=>Math.abs(p.bpm/bpm-1));
  const stableCount=deviations.filter(d=>d<=c.withinMedianRelativeTolerance+EPS).length;
  // Missing evidence is not silently dropped from the denominator.
  const medianEvidence=median(samples.map(p=>finite(p.tempoEvidence)&&p.tempoEvidence>=0?p.tempoEvidence:0));
  if(stableCount/samples.length<c.minStableFraction-EPS||medianEvidence<c.minMedianEvidence-EPS)return null;
  return {start,end,bpm,sampleCount:samples.length,observedSpanSeconds:end-start,
    stableSampleCount:stableCount,stableFraction:stableCount/samples.length,medianEvidence,
    medianRelativeDeviation:median(deviations),maxRelativeDeviation:Math.max(...deviations),
    minBpm:Math.min(...samples.map(p=>p.bpm)),maxBpm:Math.max(...samples.map(p=>p.bpm))};
}
export function deriveUnresolvedTempoIntervals(result) {
  if(!result||result.tempoModel==='constant-clock'||result.tempoModel==='manual'||result.manual===true)return [];
  const curve=result.tempoCurve;
  if(!Array.isArray(curve)||curve.length<3||curve.length>1000000)return [];
  if(curve.some((p,i)=>!p||!finite(p.time)||p.time<0||p.manual===true||(i>0&&p.time<=curve[i-1].time)))return [];
  if(Array.isArray(result.sections)&&result.sections.some(p=>p?.manual===true))return [];
  const changes=Array.isArray(result.tempoChanges)?result.tempoChanges:[];
  // Fail closed if existing event bounds cannot be used for duplicate suppression.
  if(changes.some(p=>!p||!finite(p.start)||!finite(p.end)||p.end<p.start))return [];
  const out=[],c=UNRESOLVED_GAP_CRITERIA;
  for(let i=0;i<curve.length;i++){
    if(rate(curve[i].bpm))continue;
    const first=i; while(i+1<curve.length&&!rate(curve[i+1].bpm))i++;
    const last=i;
    if(first===0||last===curve.length-1)continue;
    const start=curve[first-1].time,end=curve[last+1].time,width=end-start;
    if(width<c.minBracketSeconds-EPS||width>c.maxBracketSeconds+EPS)continue;
    // Sparse timestamps are not represented as explicit missing observations.
    let sparse=false;
    for(let j=first;j<=last+1;j++)if(curve[j].time-curve[j-1].time>c.maxSampleSpacingSeconds+EPS){sparse=true;break;}
    if(sparse||changes.some(p=>p.start<=end+EPS&&p.end>=start-EPS))continue;
    const before=windowSummary(curve,first-1,-1),after=windowSummary(curve,last+1,1);
    if(!before||!after)continue;
    const relativeContrast=Math.max(before.bpm,after.bpm)/Math.min(before.bpm,after.bpm)-1;
    if(relativeContrast<c.minRelativeContrast-EPS)continue;
    out.push({type:'unresolved-contrast',reviewOnly:true,bracketMeaning:'finite-sample-bounds-around-unestimated-curve',changeTimeLocalized:false,start,end,bracketSeconds:width,
      missingSampleStart:curve[first].time,missingSampleEnd:curve[last].time,
      missingSampleCount:last-first+1,fromBpm:before.bpm,toBpm:after.bpm,
      relativeContrast,before,after});
  }
  return out;
}
