import { isMetricalAlias } from './tempo-changes.js?v=29';
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Attack shape can shift alternating instruments without changing their rate.
// This model is eligible only for large changes with eight observations on each
// side, and faces an equally flexible cubic smooth-clock alternative.
function solve(matrix){
  const n=matrix.length,a=matrix.map(row=>row.slice());
  for(let col=0;col<n;col++){
    let pivot=col;for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
    if(Math.abs(a[pivot][col])<1e-14)return null;
    [a[col],a[pivot]]=[a[pivot],a[col]];
    const scale=a[col][col];for(let k=col;k<=n;k++)a[col][k]/=scale;
    for(let row=0;row<n;row++)if(row!==col){const factor=a[row][col];for(let k=col;k<=n;k++)a[row][k]-=factor*a[col][k];}
  }
  return a.map(row=>row[n]);
}
function regress(points,basis){
  const n=basis(0).length,origin=points[0].time,matrix=Array.from({length:n},()=>Array(n+1).fill(0));
  for(let i=0;i<points.length;i++){
    const b=basis(i),y=points[i].time-origin;
    for(let r=0;r<n;r++){for(let c=0;c<n;c++)matrix[r][c]+=b[r]*b[c];matrix[r][n]+=b[r]*y;}
  }
  const coefficients=solve(matrix);if(!coefficients)return null;
  const sse=points.reduce((sum,p,i)=>sum+(p.time-origin-basis(i).reduce((value,x,j)=>value+x*coefficients[j],0))**2,0);
  return {coefficients,sse,origin};
}
function fitAlternatingClock(points,firstIndex,timingFloor){
  const count=points.length,center=(count-1)/2,basis=i=>[1,i-center,(firstIndex+i)%2?-1:1];
  const fit=regress(points,basis);if(!fit)return null;
  const [offset,period,alternatingOffset]=fit.coefficients;
  const zMean=points.reduce((sum,_,i)=>sum+basis(i)[2],0)/count;
  let xx=0,xz=0,zz=0;for(let i=0;i<count;i++){const x=i-center,z=basis(i)[2]-zMean;xx+=x*x;xz+=x*z;zz+=z*z;}
  return {period,bpm:60/period,intercept:fit.origin+offset-period*(firstIndex+center),alternatingOffset,
    sse:fit.sse,rms:Math.sqrt(fit.sse/count),
    alternatingVariance:(fit.sse/Math.max(1,count-3)+timingFloor**2)/Math.max(1e-12,zz-xz*xz/xx),
    slopeVariance:fit.sse/Math.max(1,count-3)/Math.max(1e-12,xx-xz*xz/zz)};
}
function smoothAlternatingSse(points,changeIndex=null,degree=2){
  const center=(points.length-1)/2;
  return regress(points,i=>{
    const polynomial=Array.from({length:degree+1},(_,power)=>(i-center)**power);
    return Number.isInteger(changeIndex)?
      [...polynomial,i<=changeIndex?(i%2?-1:1):0,i>changeIndex?(i%2?-1:1):0]:
      [...polynomial,i%2?-1:1];
  })?.sse??Infinity;
}

function fitClock(points, firstIndex) {
  const count = points.length, center = (count - 1) / 2, origin = points[0].time;
  const mean = points.reduce((sum, point) => sum + point.time - origin, 0) / count;
  let xx = 0, xy = 0;
  for (let i = 0; i < count; i++) {
    xx += (i - center) ** 2;
    xy += (i - center) * (points[i].time - origin - mean);
  }
  const period = xy / xx, intercept = origin + mean - period * (firstIndex + center);
  const sse = points.reduce((sum, point, index) =>
    sum + (point.time - intercept - period * (firstIndex + index)) ** 2, 0);
  return { period, bpm: 60 / period, intercept, sse,
    rms: Math.sqrt(sse / count), slopeVariance: sse / Math.max(1, count - 2) / xx };
}

// A smooth change in beat period is approximately quadratic in beat index.
// A sharp step must explain the timestamps better than this alternative.
function smoothClockSse(points) {
  const center = (points.length - 1) / 2, origin = points[0].time;
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (let i = 0; i < points.length; i++) {
    const x = i - center, basis = [1, x, x * x], y = points[i].time - origin;
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) matrix[row][column] += basis[row] * basis[column];
      matrix[row][3] += basis[row] * y;
    }
  }
  for (let pivot = 0; pivot < 3; pivot++) {
    const scale = matrix[pivot][pivot];
    if (Math.abs(scale) < 1e-15) return Infinity;
    for (let column = pivot; column < 4; column++) matrix[pivot][column] /= scale;
    for (let row = 0; row < 3; row++) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let column = pivot; column < 4; column++) matrix[row][column] -= factor * matrix[pivot][column];
    }
  }
  const coefficients = matrix.map(row => row[3]);
  return points.reduce((sum, point, index) => {
    const x = index - center;
    return sum + (point.time - origin - coefficients[0] - coefficients[1] * x - coefficients[2] * x * x) ** 2;
  }, 0);
}

/** Independent small-step evidence from regular, observed beat timestamps.
 * No BPM values are inferred from the already-smoothed tempo curve. The caller
 * can use these candidates before accepting a provisional constant clock.
 */
export function detectBeatTempoSteps(beats, duration, options = {}) {
  if(!Number.isFinite(duration)||duration<=0)return [];
  const valid = beats.filter(point => Number.isFinite(point.time) && point.time>=0 && point.time<=duration && Number.isFinite(point.bpm) && point.bpm > 0 &&
    point.supported !== false && !point.imputed && !point.manual).sort((a, b) => a.time - b.time);
  const blocks = [];
  for (const point of valid) {
    const block = blocks.at(-1), previous = block?.at(-1);
    if (!block || point.tempoGap || point.time - previous.time > 90 / previous.bpm) blocks.push([point]);
    else block.push(point);
  }
  const minEffect = options.minEffect ?? .0015, maxEffect = options.maxEffect ?? .05;
  const timingFloor = options.timingFloor ?? .00005, candidates = [];
  for (const block of blocks) {
    for (let boundary = 3; boundary < block.length - 3; boundary++) {
      // Very small changes need a few extra observed beats to distinguish the
      // split from timing noise without relaxing the smooth-drift alternative.
      for (let count = 4; count <= 10; count++) {
        const first = Math.max(0, boundary - count + 1), last = Math.min(block.length - 1, boundary + count - 1);
        const left = block.slice(first, boundary + 1), right = block.slice(boundary, last + 1);
        if (left.length < 4 || right.length < 4) continue;
        let before = fitClock(left, first), after = fitClock(right, boundary);
        let period = median([before.period, after.period]);
        if (!(period > 0) || !Number.isFinite(before.bpm + after.bpm)) continue;
        const minSpan = options.minSpan ?? Math.min(1.5, period * 5);
        if (left.at(-1).time - left[0].time < minSpan || right.at(-1).time - right[0].time < minSpan) continue;
        let effect = Math.abs(after.bpm / before.bpm - 1);
        if (effect < minEffect || effect > maxEffect) continue;
        if ([left, right].some((window, side) => window.some((point, index) => index &&
          Math.abs((point.time - window[index - 1].time) / (side ? after.period : before.period) - 1) > .12))) continue;
        let residual = Math.max(before.rms, after.rms), alternatingFit = false;
        const limit = options.maxResidual ?? Math.max(.0005, period * .002);
        if (residual > limit) {
          if(left.length<8||right.length<8||effect<.03)continue;
          const a=fitAlternatingClock(left,first,timingFloor), b=fitAlternatingClock(right,boundary,timingFloor);
          if(!a||!b)continue;
          const amplitude=(Math.abs(a.alternatingOffset)+Math.abs(b.alternatingOffset))/2;
          const noise=Math.max(a.rms,b.rms);
          if(a.alternatingOffset*b.alternatingOffset<=0||
            Math.min(Math.abs(a.alternatingOffset),Math.abs(b.alternatingOffset))<.0001||
            Math.min(Math.abs(a.alternatingOffset)/Math.sqrt(a.alternatingVariance),Math.abs(b.alternatingOffset)/Math.sqrt(b.alternatingVariance))<5||
            amplitude>period*.025)continue;
          before=a;after=b;residual=noise;period=median([before.period,after.period]);
          effect=Math.abs(after.bpm/before.bpm-1);alternatingFit=true;
          if(effect<Math.max(.03,minEffect)||effect>maxEffect)continue;
        }
        if (residual > limit) continue;
        const slopeError = Math.sqrt(before.slopeVariance + after.slopeVariance + 2 * timingFloor ** 2 / 20);
        const separation = Math.abs(before.period - after.period) / Math.max(1e-12, slopeError);
        if (separation < (options.minSeparation ?? 5)) continue;
        // Two different rates share the same observed boundary beat. A shifted
        // attack shape with unchanged velocity must not become a tempo step.
        const mismatch = Math.abs(before.intercept + before.period * boundary -
          after.intercept - after.period * boundary);
        if (mismatch > Math.max(.0015, period * .004)) continue;
        const whole = block.slice(first, last + 1), splitSse = before.sse + after.sse;
        const smoothSse = alternatingFit ? smoothAlternatingSse(whole,boundary-first,3) : smoothClockSse(whole), noiseSse = whole.length * timingFloor ** 2;
        if (splitSse > smoothSse * .5 || smoothSse - splitSse < noiseSse) continue;
        const improvement = (smoothSse - splitSse) / Math.max(splitSse, noiseSse);
        const uncertainty = Math.max(before.period, after.period,
          Math.min(1, 2 * residual / Math.abs(before.period - after.period) * period));
        candidates.push({ time: block[boundary].time, fromBpm: before.bpm, toBpm: after.bpm,
          fitResidualMs: residual * 1000, timeUncertainty: uncertainty,
          confidence: clamp(.5 + .08 * Math.log10(1 + improvement) + .05 * Math.min(1, (left.length + right.length - 2) / 12), .5, .65),
          score: improvement * Math.min(left.length, right.length), period });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    const reach = Math.max(.75, candidate.period * 3);
    if (!selected.some(previous => Math.abs(previous.time - candidate.time) < reach)) selected.push(candidate);
  }
  return selected.sort((a, b) => a.time - b.time).map(({ time, score, period, ...candidate }) => ({
    ...candidate, start: Math.max(0, time - candidate.timeUncertainty),
    end: Math.min(duration, time + candidate.timeUncertainty), timeEstimate: time, type: 'step',
    source: 'regular-beat-timing-step', requiresReview: true,
  }));
}

/** Merge independently measured steps without losing a nearby return step or
 * changing the caller's result objects. Manual edits can retain unaffected
 * candidates through the same merge used by automatic analysis. */
export function mergeBeatTempoSteps(existing, candidates, options = {}) {
  // The smoothed curve may join two close steps in the same direction into one
  // trend. Replace that trend only when an independent, connected step chain
  // accounts for both measured endpoint rates and its full time interval.
  const agrees=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(.5,Math.abs(b)*.02);
  const explained=change=>{
    if(!['accelerando','ritardando'].includes(change.type))return false;
    const sign=Math.sign(change.toBpm-change.fromBpm);
    const chain=candidates.filter(candidate=>candidate.source==='regular-beat-timing-step'&&
      Math.sign(candidate.toBpm-candidate.fromBpm)===sign&&
      (candidate.start+candidate.end)/2>=change.start-.8&&
      (candidate.start+candidate.end)/2<=change.end+.8).sort((a,b)=>a.start-b.start);
    for(let first=0;first<chain.length;first++){
      if((chain[first].start+chain[first].end)/2>change.start+1||!agrees(chain[first].fromBpm,change.fromBpm))continue;
      for(let last=first+1;last<chain.length;last++){
        if(!agrees(chain[last-1].toBpm,chain[last].fromBpm))break;
        if((chain[last].start+chain[last].end)/2>=change.end-1&&agrees(chain[last].toBpm,change.toBpm))return true;
      }
    }
    return false;
  };
  const changes=existing.filter(change=>!explained(change)).map(change=>({...change}));
  for(const candidate of candidates) {
    const center=(candidate.start+candidate.end)/2;
    const same=changes.find(change=>change.type==='step'&&
      Math.sign(change.toBpm-change.fromBpm)===Math.sign(candidate.toBpm-candidate.fromBpm)&&
      Math.abs((change.start+change.end)/2-center)<=Math.max(1,change.timeUncertainty||0)&&
      Math.abs(change.fromBpm-candidate.fromBpm)<=Math.max(.4,candidate.fromBpm*.0025)&&
      Math.abs(change.toBpm-candidate.toBpm)<=Math.max(.4,candidate.toBpm*.0025));
    if(same) {
      same.beatTimingVerified=true;same.fitResidualMs=candidate.fitResidualMs;
      const timingReport=reportStepTiming(same,candidate,options);
      if((same.source==='sustained-small-step'||same.source==='verified-beat-timing-step')&&candidate.timeUncertainty<same.timeUncertainty) {
        same.start=candidate.start;same.end=candidate.end;same.timeUncertainty=candidate.timeUncertainty;
        if(Number.isFinite(candidate.timeEstimate))same.timeEstimate=candidate.timeEstimate;
      }
      if(timingReport)same.reportedTiming=timingReport;
    }else changes.push({...candidate});
  }
  for(const change of changes){
    const timingReport=reportStepTiming(change,change,options);
    if(timingReport){change.reportedTiming=timingReport;if(!Number.isFinite(change.timeEstimate))change.timeEstimate=timingReport.estimate;}
  }
  return changes.sort((a,b)=>a.start-b.start);
}


// Reporting bounds are deliberately separate from detector identity/matching
// bounds. They must never enter clock selection, manual retention or TJA counts.
function reportStepTiming(change,candidate,options){
  if(change.type!=='step'||change.manual)return null;
  const curve=(options.tempoCurve||[]).filter(p=>Number.isFinite(p.time)).sort((a,b)=>a.time-b.time);
  const unknown=p=>!Number.isFinite(p.bpm)||p.bpm<=0||p.supported===false||p.tempoSource==='uncertain';
  const risk=event=>{
    if(isMetricalAlias(event.fromBpm,event.toBpm))return 'metrical-pulse-interval';
    if(event.ambiguity||event.ambiguous||event.tempoAmbiguous||event.reviewReasons?.some(r=>r.includes('metrical')||r==='unknown-in-rate-support'||r==='rate-support-begins-after-unknown'))return 'uncertain-rate-support';
    const supports=[event.rateSupport?.before,event.rateSupport?.after].filter(s=>s&&Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>=s.start);
    if(supports.some(s=>s.startsAfterGap||s.ambiguousCount>0))return 'uncertain-rate-support';
    const start=supports.length?Math.min(...supports.map(s=>s.start)):event.start-.75;
    const end=supports.length?Math.max(...supports.map(s=>s.end)):event.end+.75;
    if(curve.some(p=>p.time>=start-1e-8&&p.time<=end+1e-8&&(unknown(p)||p.tempoGap||p.tempoAmbiguous)))return 'uncertain-rate-support';
    if(supports.some(s=>{const i=curve.findIndex(p=>p.time>=s.start-1e-8&&p.time<=s.end+1e-8);return i>0&&curve[i].time-curve[i-1].time<=.75&&unknown(curve[i-1]);}))return 'uncertain-rate-support';
    return null;
  };
  const prior=[change.reportedTiming,candidate.reportedTiming].filter(Boolean),reasons=[risk(change),risk(candidate),...prior.flatMap(r=>r.reasons||[])].filter(Boolean);
  if(!reasons.length)return null;
  const duration=Number.isFinite(options.duration)&&options.duration>=0?options.duration:Infinity;
  const fitted=Number.isFinite(change.timeEstimate)?change.timeEstimate:(change.start+change.end)/2;
  const estimate=Math.max(0,Math.min(duration,fitted));
  const times=[change.start,change.end,candidate.start,candidate.end,...prior.flatMap(r=>[r.start,r.end])].filter(Number.isFinite);
  const values=[change.timeUncertainty,candidate.timeUncertainty,...prior.map(r=>r.uncertainty),...times.map(t=>Math.abs(t-estimate)),...[change.fromBpm,change.toBpm,candidate.fromBpm,candidate.toBpm].filter(b=>Number.isFinite(b)&&b>0).map(b=>60/b)].filter(Number.isFinite);
  // Include a known unknown run between the declared before/after supports.
  // Gaps elsewhere in a rate-fitting neighborhood only trigger the pulse floor.
  const gaps=prior.flatMap(r=>r.supportGaps||[]).map(g=>({...g}));
  for(const event of [change,candidate]){
    const before=event.rateSupport?.before,after=event.rateSupport?.after;
    const left=Number.isFinite(before?.end)?before.end:event.start;
    const right=Number.isFinite(after?.start)?after.start:event.end;
    for(let i=0;i<curve.length;i++)if(unknown(curve[i])){
      let j=i;while(j+1<curve.length&&unknown(curve[j+1]))j++;
      const start=curve[Math.max(0,i-1)].time,end=curve[Math.min(curve.length-1,j+1)].time;
      if(end>=left&&start<=right){gaps.push({start:Math.max(0,start),end:Math.min(duration,end)});values.push(Math.abs(start-estimate),Math.abs(end-estimate));reasons.push('unknown-transition-support');}
      i=j;
    }
  }
  const uncertainty=Math.max(0,...values),rawStart=estimate-uncertainty,rawEnd=estimate+uncertainty;
  const start=Math.max(0,rawStart),end=Math.min(duration,rawEnd),boundsClipped=start!==rawStart||end!==rawEnd;
  if(boundsClipped)reasons.push('source-bounds-clipped');
  const supportGaps=[...new Map(gaps.map(g=>[`${g.start}:${g.end}`,g])).values()];
  return {start,end,estimate,uncertainty,reasons:[...new Set(reasons)].sort(),boundsClipped,...(supportGaps.length?{supportGaps}:{})};
}
