const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));

function steadyPhase(points,first,origin){
  const count=points.length,center=(count-1)/2;
  const mean=points.reduce((sum,point)=>sum+point.time-origin,0)/count;
  let xx=0,xy=0;
  for(let i=0;i<count;i++){const x=points[i].time-origin-mean;xx+=x*x;xy+=x*(i-center);}
  const frequency=xy/xx,intercept=first+center-frequency*mean;
  const residual=Math.sqrt(points.reduce((sum,point,index)=>
    sum+((first+index-frequency*(point.time-origin)-intercept)/frequency)**2,0)/count);
  return {frequency,intercept,bpm:frequency*60,period:1/frequency,residual};
}

function rampError(points,origin,before,after,middle,width){
  const start=middle-width/2,end=middle+width/2,delta=after.frequency-before.frequency;
  let sse=0,maximum=0;
  for(let i=0;i<points.length;i++){
    const time=points[i].time-origin;
    let phase=before.frequency*time+before.intercept,frequency=before.frequency;
    if(width>0){
      const a=Math.max(0,time-start),b=Math.max(0,time-end);
      phase+=delta*(a*a-b*b)/(2*width);
      frequency+=delta*clamp((time-start)/width,0,1);
    }else if(time>middle){phase+=delta*(time-middle);frequency=after.frequency;}
    const error=(i-phase)/frequency;
    sse+=error*error;maximum=Math.max(maximum,Math.abs(error));
  }
  return {sse,rms:Math.sqrt(sse/points.length),maximum,start,end};
}

// An ongoing smooth drift can look steady over four beats. Compare the finite
// ramp with uninterrupted quadratic/cubic phase models so that these flanks
// do not manufacture a sequence of short bounded acceleration events.
function smoothPhaseError(points,degree){
  const count=points.length,origin=points[0].time;
  const halfSpan=(points.at(-1).time-origin)/2,centerIndex=(count-1)/2;
  if(!(halfSpan>0))return {sse:Infinity,rms:Infinity};
  const size=degree+1,matrix=Array.from({length:size},()=>Array(size+1).fill(0));
  for(let i=0;i<count;i++){
    const x=(points[i].time-origin-halfSpan)/halfSpan,powers=[1];
    for(let j=1;j<=degree*2;j++)powers[j]=powers[j-1]*x;
    for(let row=0;row<size;row++){
      for(let column=0;column<size;column++)matrix[row][column]+=powers[row+column];
      matrix[row][size]+=powers[row]*(i-centerIndex);
    }
  }
  for(let pivot=0;pivot<size;pivot++){
    let best=pivot;for(let row=pivot+1;row<size;row++)if(Math.abs(matrix[row][pivot])>Math.abs(matrix[best][pivot]))best=row;
    [matrix[pivot],matrix[best]]=[matrix[best],matrix[pivot]];
    const scale=matrix[pivot][pivot];if(Math.abs(scale)<1e-12)return {sse:Infinity,rms:Infinity};
    for(let column=pivot;column<=size;column++)matrix[pivot][column]/=scale;
    for(let row=0;row<size;row++)if(row!==pivot){
      const factor=matrix[row][pivot];for(let column=pivot;column<=size;column++)matrix[row][column]-=factor*matrix[pivot][column];
    }
  }
  const coefficients=matrix.map(row=>row[size]);let sse=0;
  for(let i=0;i<count;i++){
    const x=(points[i].time-origin-halfSpan)/halfSpan;let phase=centerIndex,derivative=0,power=1;
    for(let j=0;j<size;j++){phase+=coefficients[j]*power;power*=x;}
    power=1;for(let j=1;j<size;j++){derivative+=j*coefficients[j]*power;power*=x;}
    const frequency=derivative/halfSpan;
    if(!(frequency>0))return {sse:Infinity,rms:Infinity};
    sse+=((i-phase)/frequency)**2;
  }
  return {sse,rms:Math.sqrt(sse/count)};
}

function fitRamp(points,leftCount,rightStart,options){
  const origin=points[0].time;
  const before=steadyPhase(points.slice(0,leftCount),0,origin);
  const after=steadyPhase(points.slice(rightStart),rightStart,origin);
  if(!(before.frequency>0&&after.frequency>0))return null;
  const period=Math.max(before.period,after.period),smallPeriod=Math.min(before.period,after.period);
  const maxStable=options.maxStableResidual??Math.max(.0015,smallPeriod*.006);
  if(Math.max(before.residual,after.residual)>maxStable)return null;
  const effect=Math.abs(after.bpm/before.bpm-1);
  if(effect<(options.minEffect??.03)||effect>(options.maxEffect??2))return null;
  if(typeof options.referenceAtTime==='function'){
    const references=[options.referenceAtTime((points[0].time+points[leftCount-1].time)/2),
      options.referenceAtTime((points[rightStart].time+points.at(-1).time)/2)];
    if(references.some((reference,index)=>!(reference>0)||!Number.isFinite(reference)||
      Math.abs(Math.log2((index?after.bpm:before.bpm)/reference))>(options.maxReferenceDistance??.10)))return null;
  }
  // The two steady phase lines intersect at the midpoint of a linear-in-time
  // BPM ramp. Only its duration remains to fit; no source schedule is supplied.
  const middle=(before.intercept-after.intercept)/(after.frequency-before.frequency);
  const leftEnd=points[leftCount-1].time-origin,rightBegin=points[rightStart].time-origin;
  if(middle<leftEnd-period*.35||middle>rightBegin+period*.35)return null;
  const maximumWidth=Math.min(options.maxDuration??4,
    2*(middle-leftEnd+period*.3),2*(rightBegin-middle+period*.3));
  const minimumWidth=Math.max(options.minDuration??.25,smallPeriod*1.5);
  if(maximumWidth<minimumWidth)return null;
  let best=null,bestWidth=0;
  const steps=48,step=(maximumWidth-minimumWidth)/steps;
  for(let i=0;i<=steps;i++){
    const width=minimumWidth+step*i,fit=rampError(points,origin,before,after,middle,width);
    if(!best||fit.sse<best.sse){best=fit;bestWidth=width;}
  }
  let low=Math.max(minimumWidth,bestWidth-step),high=Math.min(maximumWidth,bestWidth+step);
  for(let iteration=0;iteration<18;iteration++){
    const one=low+(high-low)/3,two=high-(high-low)/3;
    const a=rampError(points,origin,before,after,middle,one),b=rampError(points,origin,before,after,middle,two);
    if(a.sse<b.sse)high=two;else low=one;
  }
  const width=(low+high)/2;best=rampError(points,origin,before,after,middle,width);
  const start=best.start+origin,end=best.end+origin;
  const interior=points.filter(point=>point.time>start+smallPeriod*.08&&point.time<end-smallPeriod*.08);
  if(interior.length<(options.minInteriorBeats??3))return null;
  const maxResidual=options.maxResidual??Math.max(.0015,smallPeriod*.008);
  if(best.rms>maxResidual||best.maximum>maxResidual*2.5)return null;
  const stepFit=rampError(points,origin,before,after,middle,0);
  // A true step or bounded onset jitter must not become a short ramp merely
  // because a ramp has an extra parameter. Require a substantial timing gain.
  const noiseFloor=options.timingFloor??.00035;
  if(best.sse>stepFit.sse*.3||stepFit.rms-best.rms<Math.max(.001,noiseFloor*3))return null;
  const smooth=[smoothPhaseError(points,2),smoothPhaseError(points,3)].sort((a,b)=>a.sse-b.sse)[0];
  if(best.sse>smooth.sse*.4||smooth.rms-best.rms<noiseFloor*2)return null;
  const sign=Math.sign(after.bpm-before.bpm);
  const periods=points.slice(leftCount-1,rightStart+1).slice(1)
    .map((point,i)=>point.time-points[leftCount-1+i].time);
  if(periods.some((value,i)=>i&&sign*(value-periods[i-1])>Math.max(.002,smallPeriod*.012)))return null;
  const improvement=(stepFit.sse-best.sse)/Math.max(best.sse,points.length*noiseFloor**2);
  return {start,end,fromBpm:before.bpm,toBpm:after.bpm,
    type:sign>0?'accelerando':'ritardando',confidence:clamp(.48+.06*Math.log10(1+improvement),.48,.65),
    timeUncertainty:period,fitResidualMs:best.rms*1000,stepResidualMs:stepFit.rms*1000,
    smoothResidualMs:smooth.rms*1000,
    observedRampBeats:(before.frequency+after.frequency)*(end-start)/2,
    supportStart:points[0].time,supportEnd:points.at(-1).time,
    source:'beat-phase-ramp',requiresReview:true,score:improvement*Math.min(leftCount,points.length-rightStart)};
}

/** Independently verify a short smooth transition from already-observed beat
 * timestamps. Unsupported/manual/imputed points break the evidence chain.
 * BPM values provide gap safeguards only; the rates and boundaries are fitted
 * from timestamps, not from a smoothed curve or a notated bar assumption. */
export function detectShortTempoRamps(beats,duration,options={}){
  if(!Number.isFinite(duration)||duration<=0)return [];
  const ordered=beats.filter(point=>Number.isFinite(point.time)&&point.time>=0&&point.time<=duration)
    .sort((a,b)=>a.time-b.time),blocks=[];
  let block=null;
  for(const point of ordered){
    if(!(point.bpm>0)||!Number.isFinite(point.bpm)||point.supported===false||point.imputed||point.manual){block=null;continue;}
    const previous=block?.at(-1);
    const gap=previous&&(point.time<=previous.time||point.time-previous.time>1.8*Math.max(60/previous.bpm,60/point.bpm));
    if(!block||point.tempoGap||gap){block=[];blocks.push(block);}
    block.push(point);
  }
  const candidates=[],contexts=options.contextBeatCounts??[4,6],maxIntervals=options.maxRampIntervals??16;
  for(const points of blocks){
    for(let leftEnd=3;leftEnd<points.length-6;leftEnd++){
      for(let rightStart=leftEnd+3;rightStart<=Math.min(points.length-4,leftEnd+maxIntervals);rightStart++){
        if(points[rightStart].time-points[leftEnd].time>(options.maxDuration??4)+1)break;
        for(const leftCount of contexts)for(const rightCount of contexts){
          const first=leftEnd-leftCount+1,last=rightStart+rightCount;
          if(first<0||last>points.length)continue;
          const window=points.slice(first,last);
          const candidate=fitRamp(window,leftCount,rightStart-first,options);
          if(candidate)candidates.push(candidate);
        }
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const selected=[];
  for(const candidate of candidates){
    const center=(candidate.start+candidate.end)/2;
    if(selected.some(other=>Math.abs(center-(other.start+other.end)/2)<Math.max(.35,Math.min(candidate.end-candidate.start,other.end-other.start)*.6)))continue;
    const {score,...result}=candidate;
    selected.push({...result,start:Math.max(0,result.start),end:Math.min(duration,result.end)});
  }
  return selected.sort((a,b)=>a.start-b.start);
}

/** Refine supported samples inside a verified ramp; never fill missing audio. */
export function applyShortRampPrecision(points,ramps){
  return points.map(point=>{
    if(!(point.bpm>0)||!Number.isFinite(point.bpm)||point.supported===false||point.tempoGap||point.manual||point.imputed)return point;
    const ramp=ramps.find(event=>point.time>=event.start&&point.time<=event.end);
    if(!ramp)return point;
    const fraction=(point.time-ramp.start)/(ramp.end-ramp.start);
    const {tempoChange,...retained}=point;
    return {...retained,bpm:ramp.fromBpm+(ramp.toBpm-ramp.fromBpm)*fraction,
      tempoSource:'beat-phase-ramp',beatFitResidualMs:ramp.fitResidualMs};
  });
}

function isSupportedLinearTrend(change,points){
  const all=points.filter(p=>p.time>=change.start&&p.time<=change.end);
  if(all.length<12||all.some(p=>!Number.isFinite(p.bpm)||!(p.bpm>0)||p.supported===false||p.imputed||p.manual||p.tempoGap))return false;
  const gaps=all.slice(1).map((p,i)=>p.time-all[i].time);
  if(gaps.some(gap=>!(gap>0)||gap>.5))return false;
  const n=all.length,x=all.reduce((s,p)=>s+p.time,0)/n,y=all.reduce((s,p)=>s+p.bpm,0)/n;
  const xx=all.reduce((s,p)=>s+(p.time-x)**2,0),xy=all.reduce((s,p)=>s+(p.time-x)*(p.bpm-y),0),slope=xy/xx;
  const sse=all.reduce((s,p)=>s+(p.bpm-y-slope*(p.time-x))**2,0),total=all.reduce((s,p)=>s+(p.bpm-y)**2,0);
  if(!(total>0)||1-sse/total<.995||Math.sqrt(sse/n)/y>.008)return false;
  // Two accelerations separated by an observed held plateau are distinct.
  for(let first=0;first<all.length;first++)for(let last=first+1;last<all.length;last++){
    if(all[last].time-all[first].time<.48)continue;
    const values=all.slice(first,last+1).map(p=>p.bpm);
    if((Math.max(...values)-Math.min(...values))/y<.005)return false;
    break;
  }
  return true;
}


/** Replace a compatible coarse event with the independently fitted interval.
 * A supported full linear trend already explains a compatible proper sub-ramp.
 * Unknown or held intervals never establish that redundancy. */
export function mergeShortTempoRamps(changes,ramps,options={}){
  const agrees=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<=Math.max(2,Math.abs(b)*.04);
  ramps=ramps.filter(ramp=>!changes.some(change=>{
    if(change.manual||ramp.manual||change.type!==ramp.type||!['accelerando','ritardando'].includes(change.type))return false;
    if(change.end-change.start<(ramp.end-ramp.start)*1.5||ramp.start<change.start||ramp.end>change.end)return false;
    const at=time=>change.fromBpm+(change.toBpm-change.fromBpm)*(time-change.start)/(change.end-change.start);
    return agrees(ramp.fromBpm,at(ramp.start))&&agrees(ramp.toBpm,at(ramp.end))&&isSupportedLinearTrend(change,options.tempoCurve||[]);
  }));
  const retained=changes.filter(change=>!ramps.some(ramp=>!change.manual&&
    Math.sign(change.toBpm-change.fromBpm)===Math.sign(ramp.toBpm-ramp.fromBpm)&&
    Math.abs((change.start+change.end-ramp.start-ramp.end)/2)<=Math.max(.8,(ramp.end-ramp.start)*.6)&&
    agrees(change.fromBpm,ramp.fromBpm)&&agrees(change.toBpm,ramp.toBpm)));
  return [...retained.map(change=>({...change})),...ramps.map(ramp=>({...ramp}))].sort((a,b)=>a.start-b.start);
}
