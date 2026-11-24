// Generic short-window modulation-grid refinement. No audio-specific tempos.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const quantile=(a,q)=>{const s=Array.from(a).filter(v=>v>0).sort((x,y)=>x-y);return s[Math.floor((s.length-1)*q)]||1;};
function box(input,radius){
  const out=new Float64Array(input.length);let sum=0;
  for(let i=0;i<=radius&&i<input.length;i++)sum+=input[i];
  for(let i=0;i<input.length;i++){
    out[i]=sum/(Math.min(input.length-1,i+radius)-Math.max(0,i-radius)+1);
    if(i-radius>=0)sum-=input[i-radius];
    if(i+radius+1<input.length)sum+=input[i+radius+1];
  }return out;
}
const smooth=(a,r)=>box(box(box(a,r),r),r);

/** data: {fps, count, novelty?, bandFlux?}. anchors: frame=>BPM.
 * Returns a diagnostic local curve and tempoAtFrame(), leaving beat decisions
 * to the caller. Harmonic ambiguity needs an independently selected beat level.
 */
export function refineLocalTempo(data,anchors,options={}){
  const fps=data.fps,flux=data.bandFlux;
  const n=data.count||data.novelty?.length||flux[0].length;
  const signal=new Float64Array(n);
  if(flux){for(const band of flux){const scale=quantile(band,.9);for(let i=0;i<n;i++)signal[i]+=Math.min(5,band[i]/scale)/flux.length;}}
  else signal.set(data.novelty);
  const step=Math.max(1,Math.round(fps*(options.stepSeconds??.16)));
  const frames=Array.from({length:Math.ceil(n/step)},(_,i)=>Math.min(n-1,i*step));
  const radius=Math.max(1,Math.round(fps*(options.sigma??.30)));
  const normalization=smooth(signal,radius);
  const frequencyStep=.1,minFrequency=.5,maxFrequency=Math.min(31,fps*.47);
  const frequencies=Array.from({length:Math.floor((maxFrequency-minFrequency)/frequencyStep)+1},(_,i)=>minFrequency+i*frequencyStep);
  // Keep only sampled outputs from each frequency; temporary full-length
  // demodulation buffers can be collected between frequencies.
  const amplitudes=[],rates=[];
  for(const frequency of frequencies){
    const real=new Float64Array(n),imag=new Float64Array(n),carrierRe=new Float64Array(n),carrierIm=new Float64Array(n);
    const angle=-2*Math.PI*frequency/fps,ca=Math.cos(angle),sa=Math.sin(angle);let c=1,s=0;
    for(let i=0;i<n;i++){real[i]=signal[i]*c;imag[i]=signal[i]*s;carrierRe[i]=c;carrierIm[i]=s;const cc=c*ca-s*sa;s=s*ca+c*sa;c=cc;}
    const re=smooth(real,radius),im=smooth(imag,radius),amp=new Float32Array(frames.length),rate=new Float32Array(frames.length);
    const meanRe=smooth(carrierRe,radius),meanIm=smooth(carrierIm,radius);
    for(let i=0;i<n;i++){re[i]-=normalization[i]*meanRe[i];im[i]-=normalization[i]*meanIm[i];}
    for(let j=0;j<frames.length;j++){
      const i=frames[j],a=Math.max(0,i-1),b=Math.min(n-1,i+1);
      amp[j]=Math.hypot(re[i],im[i])/Math.max(.02,normalization[i]);
      const phase=Math.atan2(im[b]*re[a]-re[b]*im[a],re[b]*re[a]+im[b]*im[a]);
      rate[j]=frequency+phase*fps/(2*Math.PI*(b-a||1));
    }amplitudes.push(amp);rates.push(rate);
  }
  const bpms=Array.from({length:(options.maxBpm??300)-(options.minBpm??35)+1},(_,i)=>i+(options.minBpm??35));
  const logs=bpms.map(Math.log2),harmonics=[[1,.15],[2,.30],[3,.20],[4,.30],[6,.20]];
  const bins=bpms.map(bpm=>harmonics.map(([h,w])=>({h,w,i:Math.round((bpm*h/60-minFrequency)/frequencyStep)})).filter(v=>v.i>=0&&v.i<frequencies.length));
  // Two distance-transform sweeps solve the L1 continuity cost in O(BPMs)
  // per time step instead of comparing every pair of candidate rates.
  const back=frames.map(()=>new Uint16Array(bpms.length));
  const anchorWeight=options.anchorWeight??.20,transitionWeight=options.transitionWeight??.22;
  const score=(k,j)=>{
    let value=0;for(const {w,i}of bins[k])value+=w*amplitudes[i][j];
    const anchor=anchors?.(frames[j]);
    if(anchor>0)value-=anchorWeight*Math.abs(Math.log2(bpms[k]/anchor));
    return value;
  };
  let previous=Float64Array.from(bpms,(_,k)=>4*score(k,0));
  for(let j=1;j<frames.length;j++){
    const next=new Float64Array(bpms.length);let best=-Infinity,bestIndex=0;
    for(let k=0;k<bpms.length;k++){
      const v=previous[k]+transitionWeight*logs[k];if(v>best){best=v;bestIndex=k;}
      next[k]=best-transitionWeight*logs[k];back[j][k]=bestIndex;
    }
    best=-Infinity;bestIndex=0;
    for(let k=bpms.length-1;k>=0;k--){
      const v=previous[k]-transitionWeight*logs[k];if(v>best){best=v;bestIndex=k;}
      const candidate=best+transitionWeight*logs[k];if(candidate>next[k]){next[k]=candidate;back[j][k]=bestIndex;}
      next[k]+=4*score(k,j);
    }previous=next;
  }
  let state=0;for(let k=1;k<bpms.length;k++)if(previous[k]>previous[state])state=k;
  const path=new Uint16Array(frames.length);for(let j=frames.length-1;j>=0;j--){path[j]=state;state=back[j][state];}
  const curve=frames.map((frame,j)=>{
    const coarse=bpms[path[j]];let sum=0,weight=0,coherence=0;
    for(const {h,w,i}of bins[path[j]]){
      const rate=rates[i][j]*60/h,amplitude=amplitudes[i][j];
      if(rate>0&&Math.abs(Math.log2(rate/coarse))<.12){const ww=amplitude*amplitude;sum+=rate*ww;weight+=ww;coherence+=w*amplitude;}
    }
    const bpm=weight>1e-8?sum/weight:coarse,anchor=anchors?.(frame);
    // Coherence is evidence strength, not a calibrated probability. Weak
    // evidence may refine the chosen level, but must not invent a remote one.
    const supported=coherence>=.04&&(!anchor||Math.abs(Math.log2(bpm/anchor))<.35||coherence>=.15);
    return {frame,time:frame/fps,bpm,coarse,coherence,supported};
  });
  const tempoAtFrame=frame=>{const p=clamp(frame/step,0,curve.length-1),a=Math.floor(p),b=Math.min(curve.length-1,a+1);return curve[a].bpm*(b-p)+curve[b].bpm*(p-a)||(curve[a].bpm);};
  const evidenceAtFrame=frame=>curve[clamp(Math.round(frame/step),0,curve.length-1)];
  return {curve,tempoAtFrame,evidenceAtFrame,method:'short-window harmonic modulation grid / phase reassignment'};
}

/** Preserve the incoming pulse unit when strong low/mid attacks and the full
 * mix disagree by a subdivision. Dense high-band ornaments alone must not
 * redefine the beat. Other supported changes remain on the original curve. */
export function reconcileBodyTempo(full,body,anchors){
  const preferred=full.curve.map((point,i)=>{
    const low=body.curve[i],anchor=anchors?.(point.frame);
    if(!point.supported||!low?.supported||low.coherence<.06||!(anchor>0))return false;
    const ratio=point.bpm/low.bpm,alias=[.5,2/3,1.5,2,3].some(level=>Math.abs(Math.log2(ratio/level))<.035);
    return alias&&Math.abs(Math.log2(low.bpm/anchor))+.03<Math.abs(Math.log2(point.bpm/anchor));
  });
  const curve=full.curve.map(point=>({...point}));
  for(let i=0;i<preferred.length;){if(!preferred[i]){i++;continue;}const start=i;
    while(i<preferred.length&&preferred[i])i++;
    if(full.curve[i-1].time-full.curve[start].time<.8)continue;
    for(let j=start;j<i;j++)curve[j]={...body.curve[j],tempoSource:'body-grid'};
  }
  const step=curve.length>1?curve[1].frame-curve[0].frame:1;
  const evidenceAtFrame=frame=>curve[clamp(Math.round(frame/step),0,curve.length-1)];
  const tempoAtFrame=frame=>{const p=clamp(frame/step,0,curve.length-1),a=Math.floor(p),b=Math.min(curve.length-1,a+1);return curve[a].bpm*(b-p)+curve[b].bpm*(p-a)||curve[a].bpm;};
  return {...full,curve,evidenceAtFrame,tempoAtFrame};
}
