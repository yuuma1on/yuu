// A conservative metrical-reference heuristic for an already-variable track.
// It never supplies final BPM values, proves a notated beat unit, or fills gaps.
// Coherence, background ratios, and thresholds below are evidence heuristics,
// not calibrated confidence intervals or probabilities.
const distance=(a,b)=>a>0&&b>0?Math.abs(Math.log2(a/b)):Infinity;
const positive=value=>Number.isFinite(value)&&value>0;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||0;};

function validateData(data){
  const count=data?.count??data?.bandFlux?.[0]?.length;
  if(!positive(data?.fps)||!Number.isInteger(count)||count<4||!Array.isArray(data.bandFlux)||
    data.bandFlux.length<2||data.bandFlux.slice(0,2).some(band=>!band||band.length<count)){
    throw new TypeError('Regional clocks require finite fps, count, and two body-flux bands.');
  }
  return count;
}
const sample=value=>Number.isFinite(value)&&value>0?value:0;

function observeBand(raw,first,last,fps,clocks){
  const length=last-first,weights=new Float64Array(length),centered=new Float64Array(length);
  let weightSum=0,mass=0;
  for(let i=0;i<length;i++){
    weights[i]=.5-.5*Math.cos(2*Math.PI*i/(length-1));
    weightSum+=weights[i];mass+=sample(raw[first+i])*weights[i];
  }
  const mean=mass/Math.max(1e-9,weightSum);
  for(let i=0;i<length;i++)centered[i]=weights[i]*(sample(raw[first+i])-mean);
  const amplitude=frequency=>{
    let re=0,im=0;
    for(let i=0;i<length;i++){
      const angle=2*Math.PI*frequency*(i-length/2)/fps;
      re+=centered[i]*Math.cos(angle);im+=centered[i]*Math.sin(angle);
    }
    return Math.hypot(re,im);
  };
  const resolution=fps/length,maxFrequency=fps*.45;
  return clocks.map((bpm,index)=>{
    const lines=[];
    for(let harmonic=1;harmonic<=6;harmonic++){
      const frequency=bpm*harmonic/60;
      if(frequency>=maxFrequency)continue;
      const otherFundamental=clocks[1-index]/60,nearest=Math.round(frequency/otherFundamental);
      // Finite-window resolution determines whether the two lines are distinct.
      if(nearest>=1&&Math.abs(frequency-nearest*otherFundamental)<resolution*.5)continue;
      const value=amplitude(frequency);
      const background=median([-4,-3,-2,2,3,4].map(offset=>frequency+offset*resolution)
        .filter(f=>f>.5&&f<maxFrequency).map(amplitude));
      const coherence=value/Math.max(1e-9,mass),snr=value/Math.max(1e-9,background);
      lines.push({harmonic,coherence,snr});
    }
    const power=lines.reduce((sum,line)=>sum+Math.max(0,
      line.coherence**2*(1-1/Math.max(.001,line.snr**2))),0);
    return {lines,power,fundamental:lines.find(line=>line.harmonic===1)||null};
  });
}

/** Compare two existing audio-derived hypotheses; this is not BPM discovery.
 * Only nonshared harmonics count. The default four-second Hann window uses
 * neighboring bins at +/-2..4 resolution units to estimate local background.
 */
export function compareRegionalClockEvidence(data,frame,candidateBpm,alternativeBpm,options={}){
  const count=validateData(data),fps=data.fps,windowSeconds=options.windowSeconds??4;
  if(!positive(windowSeconds)||!Number.isFinite(frame)||!positive(candidateBpm)||!positive(alternativeBpm)){
    return {supported:false,reason:'missing-clock-evidence'};
  }
  const ratio=candidateBpm/alternativeBpm,multiple=Math.max(ratio,1/ratio),integer=Math.round(multiple);
  // Nested integer harmonic families do not prove a unique beat unit in either
  // direction. Odd lines of a slower clock may describe alternating accents.
  // Genuine octave changes require separate direct-onset evidence.
  if(integer>=2&&distance(multiple,integer)<.04)return {supported:false,reason:'integer-multiple'};
  const first=Math.round(frame-windowSeconds*fps/2),last=Math.round(frame+windowSeconds*fps/2);
  if(first<0||last>count||last-first<8)return {supported:false,reason:'insufficient-context'};
  if(!positive(options.minExcessCoherence??.025)||!positive(options.minPowerRatio??1.7)){
    return {supported:false,reason:'invalid-evidence-options'};
  }
  const observations=data.bandFlux.slice(0,2).map(raw=>
    observeBand(raw,first,last,fps,[candidateBpm,alternativeBpm]));
  const bands=observations.map(([candidate,alternative])=>{
    const old=alternative.fundamental,incoming=candidate.fundamental;
    const oldDirect=!!old&&old.coherence>=.05&&old.snr>=2&&old.coherence>(incoming?.coherence??0)*.65;
    return {candidatePower:candidate.power,alternativePower:alternative.power,
      ratio:candidate.power/Math.max(.00001,alternative.power),uniqueHarmonics:candidate.lines.length,oldDirect};
  });
  const supported=bands.every(band=>band.uniqueHarmonics>=2&&
    band.candidatePower>=(options.minExcessCoherence??.025)**2&&
    band.ratio>=(options.minPowerRatio??1.7))&&!bands.some(band=>band.oldDirect);
  return {supported,reason:supported?'independent-body-clock':'insufficient-exclusive-evidence',bands};
}

/** Establish a regional pulse interpretation after whole-track steady
 * verification has failed. Caller retains the original fine curve and normal
 * support gates; referenceAtFrame() is only a metrical prior for later choices.
 */
export function buildRegionalReference(data,automatic,original,firstLocal,referenceBpm,options={}){
  const count=validateData(data),fps=data.fps,curve=firstLocal?.curve;
  if(!positive(referenceBpm)||typeof automatic?.tempoAtFrame!=='function'||
    typeof original?.evidenceAtFrame!=='function'||!Array.isArray(curve)||curve.length<2||!Array.isArray(original.curve)||original.curve.length<2){
    throw new TypeError('Regional clocks require a reference, a complete original fine curve, and existing clock paths.');
  }
  const stride=curve[1].time-curve[0].time;
  if(!positive(stride))throw new TypeError('Local clock times must have a positive stride.');
  const windowSeconds=options.windowSeconds??4,minSupport=Math.max(2,options.minSupportSamples??2);
  const separation=Math.max(windowSeconds,options.minProofSeparation??4);
  if(!positive(windowSeconds)||!Number.isInteger(minSupport)||!positive(separation)||
    !positive(options.minActivityFraction??.025)){
    throw new TypeError('Regional clock options must be finite, positive values.');
  }
  // Every original fine sample matters. Coarse local-clock centers must not
  // hide a shorter unknown interval, a phase break, or a different pulse level.
  const fine=original.curve.map(point=>({point,frame:Number.isFinite(point.frame)?point.frame:point.time*fps}));
  if(fine.some((entry,i)=>!Number.isFinite(entry.frame)||entry.frame<0||entry.frame>=count||
    (i&&entry.frame<=fine[i-1].frame)))throw new TypeError('Original fine-clock frames must be finite and ordered.');
  const audioSupported=point=>point?.supported===true&&positive(point.bpm)&&
    Number.isFinite(point.coherence)&&point.coherence>=.04&&!point.tempoGap&&!point.manual&&!point.imputed;
  const validFine=fine.map(({point,frame})=>audioSupported(point)&&
    distance(point.bpm,automatic.tempoAtFrame(frame))<.10);
  const invalidPrefix=new Uint32Array(fine.length+1);
  for(let i=0;i<fine.length;i++)invalidPrefix[i+1]=invalidPrefix[i]+Number(!validFine[i]);
  const lowerBound=frame=>{let low=0,high=fine.length;while(low<high){const mid=(low+high)>>>1;
    if(fine[mid].frame<frame)low=mid+1;else high=mid;}return low;};
  const fineCovered=(first,last)=>{
    if(!Number.isFinite(first)||!Number.isFinite(last)||first<fine[0].frame||last>fine.at(-1).frame||first>last)return false;
    let a=lowerBound(first);if(a>0&&fine[a]?.frame>first)a--;
    const b=lowerBound(last);return b<fine.length&&invalidPrefix[b+1]===invalidPrefix[a];
  };
  const coveredEnd=(frame,limit)=>{
    let index=lowerBound(frame);if(index>0&&fine[index]?.frame>frame)index--;
    while(index<fine.length&&fine[index].frame<=limit){
      if(!validFine[index])return index?fine[index-1].frame:frame;
      index++;
    }
    return Math.min(limit,fine.at(-1).frame);
  };
  // Activity is only a silence/fade safeguard. It does not establish a clock.
  const energy=Float64Array.from({length:count},(_,i)=>sample(data.bandFlux[0][i])+sample(data.bandFlux[1][i]));
  const sorted=Array.from(energy).filter(positive).sort((a,b)=>a-b);
  const activityScale=sorted[Math.floor((sorted.length-1)*.9)]||0,prefix=new Float64Array(count+1);
  for(let i=0;i<count;i++)prefix[i+1]=prefix[i]+energy[i];
  const active=(frame,bpm)=>{
    const radius=Math.ceil(fps*Math.max(.16,45/bpm)),first=Math.max(0,Math.floor(frame-radius)),last=Math.min(count,Math.ceil(frame+radius+1));
    return activityScale>0&&last>first&&(prefix[last]-prefix[first])/(last-first)>=activityScale*(options.minActivityFraction??.025);
  };
  const points=curve.map(point=>{
    const frame=point.frame,time=point.time,before=Number.isFinite(frame)?original.evidenceAtFrame(frame):null;
    const candidate=Number.isFinite(frame)?automatic.tempoAtFrame(frame):null;
    let eligible=Number.isFinite(frame)&&Number.isFinite(time)&&frame>=0&&frame<count&&
      audioSupported(point)&&audioSupported(before)&&positive(candidate)&&
      distance(before.bpm,candidate)<.10&&fineCovered(frame,frame)&&active(frame,candidate);
    const ratio=candidate/point.bpm,alias=distance(candidate,point.bpm)>.12&&
      [.5,2/3,1.5,2,3].some(level=>distance(ratio,level)<.08);
    const evidence=eligible&&alias?compareRegionalClockEvidence(data,frame,candidate,point.bpm,options):null;
    // A returning original fundamental contradicts the held interpretation; it
    // is stronger than merely lacking another positive proof window.
    if(evidence?.bands?.some(band=>band.oldDirect))eligible=false;
    const proof=eligible&&!!evidence?.supported;
    return {time,frame,candidate,eligible,proof};
  });
  const runs=[];
  for(let i=0;i<points.length;){
    if(!points[i].eligible){i++;continue;}
    const first=i,rate=points[i].candidate;
    while(i<points.length&&points[i].eligible&&distance(points[i].candidate,rate)<.10&&
      (i===first||(points[i].time-points[i-1].time<=stride*1.5&&
        fineCovered(points[i-1].frame,points[i].frame))))i++;
    const group=points.slice(first,i),start=group[0].time;
    const end=coveredEnd(group.at(-1).frame,Math.min(count,(group.at(-1).time+stride)*fps))/fps;
    // Require a minimum number of support samples, plus two endpoint windows
    // that do not overlap. This does not claim every sample is independent.
    // Every complete proof window must stay inside the valid fine-clock run.
    const proofs=group.filter(point=>point.proof&&point.time-windowSeconds/2>=start&&
      point.time+windowSeconds/2<=end&&
      fineCovered((point.time-windowSeconds/2)*fps,(point.time+windowSeconds/2)*fps));
    if(proofs.length<minSupport||proofs.at(-1).time-proofs[0].time<separation)continue;
    runs.push({start,end,evidenceStart:proofs[0].time,evidenceEnd:proofs.at(-1).time,
      supportSamples:proofs.length,referenceBpm:rate});
  }
  const supportsFrame=frame=>Number.isFinite(frame)&&frame>=0&&frame<count&&
    runs.some(run=>frame/fps>=run.start&&frame/fps<run.end)&&fineCovered(frame,frame)&&
    audioSupported(original.evidenceAtFrame(frame))&&active(frame,automatic.tempoAtFrame(frame));
  const referenceAtFrame=frame=>{
    const candidate=supportsFrame(frame)?automatic.tempoAtFrame(frame):null;
    return positive(candidate)?candidate:referenceBpm;
  };
  return {runs,supportsFrame,referenceAtFrame};
}
