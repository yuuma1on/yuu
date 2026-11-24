import { detectSmallTempoSteps } from './small-tempo-steps.js?v=17';
const med=a=>{const s=Array.from(a).filter(Number.isFinite).sort((x,y)=>x-y);return s[Math.floor(s.length/2)]||0;};
const q90=a=>{const s=Array.from(a).filter(v=>v>0).sort((x,y)=>x-y);return s[Math.floor(s.length*.9)]||1;};
function spectrum(input){
  let n=1;while(n<input.length*8)n*=2;
  const re=new Float64Array(n),im=new Float64Array(n),mean=input.reduce((a,b)=>a+b,0)/input.length;
  for(let i=0;i<input.length;i++)re[i]=(input[i]-mean)*(.5-.5*Math.cos(2*Math.PI*i/(input.length-1)));
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let z=re[i];re[i]=re[j];re[j]=z;}}
  for(let len=2;len<=n;len*=2){const a=-2*Math.PI/len,ca=Math.cos(a),sa=Math.sin(a);for(let i=0;i<n;i+=len){let c=1,s=0;for(let j=0;j<len/2;j++){const x=i+j,y=x+len/2,tr=re[y]*c-im[y]*s,ti=re[y]*s+im[y]*c;re[y]=re[x]-tr;im[y]=im[x]-ti;re[x]+=tr;im[x]+=ti;const z=c*ca-s*sa;s=s*ca+c*sa;c=z;}}}
  return Float32Array.from({length:n/2+1},(_,i)=>Math.hypot(re[i],im[i]));
}
function phasor(v,fps,bpm,h,a,b){
  const frequency=bpm*h/60,angle=-2*Math.PI*frequency/fps,ca=Math.cos(angle),sa=Math.sin(angle);let c=Math.cos(angle*a),s=Math.sin(angle*a),re=0,im=0,total=0;
  for(let i=a;i<b;i++){
    const weight=.5-.5*Math.cos(2*Math.PI*(i-a)/Math.max(1,b-a-1)),value=v[i]*weight;
    re+=value*c;im+=value*s;total+=value;
    const z=c*ca-s*sa;s=s*ca+c*sa;c=z;
  }return {re,im,amplitude:Math.hypot(re,im)/Math.max(total,1e-9),energy:total/Math.max(1,b-a)};
}
const cache=new WeakMap();
function prepare(data){
  if(cache.has(data))return cache.get(data);
  const fps=data.fps,flux=data.bandFlux||data.flux,n=data.count||data.novelty?.length||flux[0].length,duration=n/fps;
  const bands=flux?flux.map(band=>{const out=new Float64Array(n),scale=q90(band);for(let i=0;i<n;i++)out[i]=Math.min(5,band[i]/scale);return out;}):[Float64Array.from(data.novelty)];
  const spectra=bands.map(spectrum),fftSize=(spectra[0].length-1)*2;
  const amplitude=(frequency,band=-1)=>{
    const position=frequency/fps*fftSize,center=Math.round(position),offset=position-center;
    if(center<1||center+1>=spectra[0].length)return 0;
    const at=s=>Math.max(0,s[center]+.5*offset*(s[center+1]-s[center-1])+.5*offset*offset*(s[center+1]+s[center-1]-2*s[center]));
    return band>=0?at(spectra[band]):spectra.reduce((sum,s)=>sum+at(s),0)/spectra.length;
  };
  const p={fps,n,duration,bands,spectra,fftSize,amplitude};cache.set(data,p);return p;
}

/** Discover candidate beat levels from the recording's global modulation
 * lines. References are optional additional candidates, never fixed targets.
 * Frequency peaks map through 1, 2 and 4 subdivisions; meter ranking belongs
 * to the caller's independent body-pulse/occupancy evidence.
 */
export function discoverClocks(data,references=[],options={}){
  const p=prepare(data),{fps,spectra,fftSize,amplitude}=p;
  const minBpm=options.minBpm??35,maxBpm=options.maxBpm??1200,peaks=[];
  for(let band=0;band<spectra.length;band++){
    const s=spectra[band];let max=0;for(let i=1;i<s.length;i++)if(i*fps/fftSize<fps*.47)max=Math.max(max,s[i]);
    for(let i=2;i<s.length-2;i++){
      const frequency=i*fps/fftSize;if(frequency<minBpm/60||frequency>fps*.47)continue;
      if(s[i]<max*.06||s[i]<s[i-1]||s[i]<=s[i+1])continue;
      const den=s[i-1]-2*s[i]+s[i+1],offset=den?Math.max(-.5,Math.min(.5,.5*(s[i-1]-s[i+1])/den)):0;
      peaks.push({frequency:(i+offset)*fps/fftSize,strength:s[i]/Math.max(1e-9,max),band});
    }
  }
  peaks.sort((a,b)=>b.strength-a.strength);
  const proposals=[];
  for(const peak of peaks.slice(0,60))for(const harmonic of [1,2,4]){
    const bpm=peak.frequency*60/harmonic;if(bpm<minBpm||bpm>maxBpm)continue;
    proposals.push({bpm,source:'global-spectrum',peakFrequency:peak.frequency,harmonic,peakStrength:peak.strength});
  }
  for(const value of references){const bpm=typeof value==='number'?value:value?.bpm;if(Number.isFinite(bpm)&&bpm>=minBpm&&bpm<=maxBpm)proposals.push({bpm,source:'reference'});}
  for(const c of proposals)c.spectralScore=[[1,.15],[2,.3],[3,.2],[4,.3],[6,.2]].reduce((sum,[h,w])=>sum+(c.bpm*h/60<fps*.47?w*amplitude(c.bpm*h/60):0),0);
  proposals.sort((a,b)=>b.spectralScore-a.spectralScore);
  const selected=[];
  for(const c of proposals){if(selected.every(v=>Math.abs(Math.log2(v.bpm/c.bpm))>.008))selected.push(c);if(selected.length>=(options.limit??24))break;}
  return selected;
}

/** Fit and verify one candidate. Phase clocks retain their frequency band;
 * mixing spectral bands before phase comparison can cancel real evidence.
 */
export function verifySteadyClock(data,referenceBpm,localCurve=[],options={}){
  const p=prepare(data),{fps,n,duration,bands,amplitude}=p;
  if(duration<(options.minDuration??12)||!(referenceBpm>0))return {accepted:false,reason:'insufficient-span'};
  const harmonics=[[1,.15],[2,.3],[3,.2],[4,.3],[6,.2]];
  const step=Math.max(.001,Math.min(.01,15/duration/8));let bpm=referenceBpm,best=-Infinity;
  const fraction=options.searchFraction??.025;
  // Only an independently filled fast-attack grid may use sampled harmonic
  // folds. Otherwise a shared subdivision line cannot prove the faster unit.
  const folded=options.fastPulseSupport===true&&referenceBpm>fps*.47*60/2;
  const sampleFrequency=frequency=>{const f=((frequency%fps)+fps)%fps;return f>fps/2?fps-f:f;};
  const observable=frequency=>frequency>1/duration&&frequency<fps/2-1/duration;
  for(let rate=Math.max(10,referenceBpm*(1-fraction));rate<=Math.min(1200,referenceBpm*(1+fraction));rate+=step){
    let score=0;for(const[h,w]of harmonics){const frequency=folded?sampleFrequency(rate*h/60):rate*h/60;
      if(folded?observable(frequency):frequency<fps*.47)score+=w*amplitude(frequency);
    }
    if(score>best){best=score;bpm=rate;}
  }
  const frequencies=[];
  const hs=[1,2,4].filter(h=>{
    const frequency=folded?sampleFrequency(bpm*h/60):bpm*h/60;
    if(folded?!observable(frequency):frequency>=fps*.47)return false;
    if(frequencies.some(f=>Math.abs(f-frequency)<2/duration))return false;
    frequencies.push(frequency);return true;
  });
  if(hs.length<2)return {accepted:false,bpm,reason:'insufficient-harmonic-range'};
  const definitions=bands.flatMap((v,band)=>hs.map(h=>({band,h,v,global:phasor(v,fps,bpm,h,0,n)})));
  const blocks=[];
  const windowSeconds=options.windowSeconds??4,windowStep=options.windowStep??1;
  for(let center=windowSeconds/2;center<duration-windowSeconds/2;center+=windowStep){const a=Math.max(0,Math.round((center-windowSeconds/2)*fps)),b=Math.min(n,Math.round((center+windowSeconds/2)*fps)),clocks=definitions.map(d=>phasor(d.v,fps,bpm,d.h,a,b));blocks.push({time:center,clocks,energy:clocks.reduce((sum,p)=>sum+p.energy,0)/clocks.length});}
  const energyFloor=med(blocks.map(b=>b.energy))*.15;
  const active=blocks.filter(b=>b.energy>Math.max(.001,energyFloor));
  const diagnostics=definitions.map((definition,k)=>{
    const {h,band,global}=definition;
    const positive=active.filter(b=>b.clocks[k].amplitude>=.025);
    let re=0,im=0,total=0,agree=0;
    for(const b of positive){const p=b.clocks[k],m=Math.hypot(p.re,p.im),w=p.amplitude;re+=p.re/m*w;im+=p.im/m*w;total+=w;const d=Math.atan2(p.im*global.re-p.re*global.im,p.re*global.re+p.im*global.im);if(Math.abs(d)<=.65)agree++;}
    return {band,harmonic:h,globalCoherence:global.amplitude,resultant:Math.hypot(re,im)/Math.max(total,1e-9),coverage:agree/Math.max(1,active.length),positiveCoverage:positive.length/Math.max(1,active.length)};
  });
  const usable=diagnostics.map((d,k)=>d.globalCoherence>=.012&&d.resultant>=.85&&d.coverage>=.20?k:-1).filter(k=>k>=0);
  const usableHarmonics=[...new Set(usable.map(k=>definitions[k].h))];
  const acceptedBlocks=active.filter(b=>usable.some(k=>{const p=b.clocks[k],global=definitions[k].global;if(p.amplitude<.025)return false;const d=Math.atan2(p.im*global.re-p.re*global.im,p.re*global.re+p.im*global.im);return Math.abs(d)<=.65;}));
  const phaseCoverage=acceptedBlocks.length/Math.max(1,active.length);
  // Clear, sustained opposing rates veto a stationary interpretation. Ignore
  // octave-level changes here; a beat-unit alternative can share the same grid.
  const directBodyClock=typeof options.bodyStationarity==='function'&&options.bodyStationarity({accepted:true,bpm,clocks:diagnostics},active);
  const opposition=levels=>{
    let longest=0,run=0,last=-Infinity;
    for(const point of localCurve){const rate=point.bpm,logRatio=Math.log2(rate/bpm);
      const separation=Math.min(...levels.map(level=>Math.abs(logRatio-level)));
      if(Number.isFinite(rate)&&point.coherence>=.15&&separation>.08&&point.time-last<.5){run+=point.time-last;longest=Math.max(longest,run);}else run=0;
      last=point.time;
    }
    return longest;
  };
  const unexplainedOpposition=opposition([-2,-1,0,1,2]);
  const longestOpposition=folded||directBodyClock?unexplainedOpposition:opposition([-1,0,1]);
  const smallStepOpposition=options.smallStepOpposition??(detectSmallTempoSteps(localCurve,duration).length>0);
  const warp=coherentPhaseWarp(definitions,active,bpm);
  const bodyPhaseWarp=warp.bands.some(band=>band<2);
  const phaseWarp=warp.bands.length>0&&!(directBodyClock&&!bodyPhaseWarp&&warp.stationaryBody);
  const accepted=usableHarmonics.length>=2&&phaseCoverage>=.92&&longestOpposition<1&&!smallStepOpposition&&!phaseWarp;

  return {accepted,bpm,directBodyClock,bodyPhaseWarp,unexplainedOpposition,spectralScore:best,phaseCoverage,clocks:diagnostics,usableHarmonics,longestOpposition,smallStepOpposition,phaseWarp,foldedHarmonics:folded,activeWindows:active.length,method:'global harmonic clock fit / independent-band phase support across duration'};
}

// A globally sharp spectral line can hide a small but sustained rate drift.
// Compare independently observed harmonic phase trajectories, in beat units,
// rather than tightening a single circular-coherence threshold.
function coherentPhaseWarp(definitions, blocks, bpm){
  if(blocks.length<16)return {bands:[],stationaryBody:false};
  const tracks=definitions.map((definition,k)=>{
    const a=blocks.map((b,index)=>{const p=b.clocks[k],g=definition.global;return {index,time:b.time,phase:Math.atan2(p.im*g.re-p.re*g.im,p.re*g.re+p.im*g.im)/definition.h,amplitude:p.amplitude};}).filter(p=>p.amplitude>=.06);
    if(a.length<blocks.length*.8)return null;
    // Ignore wrapped trajectories here: the existing coherence rejection is
    // responsible for large changes. Only subtle phase warps are examined.
    if(a.some((p,i)=>i&&Math.abs(p.phase-a[i-1].phase)>Math.PI/definition.h))return null;
    const mean=v=>v.reduce((s,x)=>s+x,0)/v.length,x0=a[0].time, mx=mean(a.map(p=>p.time-x0)),my=mean(a.map(p=>p.phase));let xx=0,xy=0;
    for(const p of a){const x=p.time-x0-mx;xx+=x*x;xy+=x*(p.phase-my);}
    const slope=xy/Math.max(1e-9,xx),residual=a.map(p=>({...p,value:p.phase-my-slope*(p.time-x0-mx)}));
    const rms=Math.sqrt(mean(residual.map(p=>p.value*p.value)));
    return {definition,residual,rms};
  }).filter(t=>t);
  const warpedBands=[];
  for(let i=0;i<tracks.length;i++)for(let j=i+1;j<tracks.length;j++){
    const a=tracks[i],b=tracks[j];if(a.definition.band!==b.definition.band||a.definition.h===b.definition.h)continue;
    const bm=new Map(b.residual.map(p=>[p.index,p.value]));let xy=0,xx=0,yy=0,n=0;
    for(const p of a.residual){const y=bm.get(p.index);if(y===undefined)continue;xy+=p.value*y;xx+=p.value*p.value;yy+=y*y;n++;}
    const ratio=Math.sqrt(xx/Math.max(1e-12,yy));
    const boundedOffset=()=>boundedPhaseOffset(a,b,blocks,bpm);
    if(n>=16&&a.rms>.06&&b.rms>.06&&xy/Math.sqrt(xx*yy)>.9&&ratio>.6&&ratio<1.67&&!boundedOffset())warpedBands.push(a.definition.band);
    // A short initial/final rate can be drowned out by the global RMS. Test
    // bounded endpoint windows in seconds of phase displacement, invariant
    // under the candidate's half/double beat interpretation. Both harmonics
    // must carry the same displacement; a lone timbral phase shift is not enough.
    const radiansPerSecond=2*Math.PI*bpm/60;
    for(const edge of [blocks[0].time,blocks.at(-1).time]){
      const pairs=a.residual.filter(p=>Math.abs(p.time-edge)<=6&&bm.has(p.index));
      if(pairs.length<6)continue;
      let exy=0,exx=0,eyy=0;
      for(const p of pairs){const y=bm.get(p.index);exy+=p.value*y;exx+=p.value*p.value;eyy+=y*y;}
      const eratio=Math.sqrt(exx/Math.max(1e-12,eyy));
      if(Math.sqrt(exx/pairs.length)/radiansPerSecond>.005&&Math.sqrt(eyy/pairs.length)/radiansPerSecond>.005&&exy/Math.sqrt(exx*eyy)>.95&&eratio>.75&&eratio<1.33&&!boundedOffset())warpedBands.push(a.definition.band);
    }
  }
  const timingFloor=2*Math.PI*bpm/60*.002;
  const stationaryBody=[0,1].every(band=>tracks.filter(track=>track.definition.band===band&&track.rms<=timingFloor).length>=2);
  return {bands:[...new Set(warpedBands)],stationaryBody};
}

// A changed attack envelope can move the measured phase without changing its
// velocity. Require matching outer clocks and a stable, displaced middle clock
// before treating such a bounded offset as timbre rather than tempo evidence.
// A sustained rate step/drift changes phase velocity; a tempo excursion leaves
// accumulated phase displacement after it ends. Neither satisfies this proof.
function boundedPhaseOffset(a,b,blocks,bpm){
  const first=blocks[0].time,last=blocks.at(-1).time;
  if(last-first<24)return false;
  const radiansPerSecond=2*Math.PI*bpm/60,edgeSeconds=6;
  const fit=(track,lo,hi)=>{
    const points=track.residual.filter(p=>p.time>=lo&&p.time<=hi);
    if(points.length<6||points.at(-1).time-points[0].time<5)return null;
    const center=points.reduce((sum,p)=>sum+p.time,0)/points.length;
    const mean=points.reduce((sum,p)=>sum+p.phase,0)/points.length;
    let xx=0,xy=0;
    for(const p of points){xx+=(p.time-center)**2;xy+=(p.time-center)*(p.phase-mean);}
    const slope=xy/Math.max(1e-9,xx);
    const rms=Math.sqrt(points.reduce((sum,p)=>sum+(p.phase-mean-slope*(p.time-center))**2,0)/points.length);
    return {slope,rms,at:time=>mean+slope*(time-center)};
  };
  const pairs=[a,b].map(track=>({track,start:fit(track,first,first+edgeSeconds),end:fit(track,last-edgeSeconds,last)}));
  if(pairs.some(p=>!p.start||!p.end))return false;
  const middle=(first+last)/2;
  for(const p of pairs){
    if(Math.abs(p.start.slope-p.end.slope)*60/(2*Math.PI)>.05)return false;
    if(Math.abs(p.start.at(middle)-p.end.at(middle))/radiansPerSecond>.003)return false;
    if(Math.max(p.start.rms,p.end.rms)/radiansPerSecond>.002)return false;
  }
  for(let center=first+edgeSeconds+3;center<=last-edgeSeconds-3;center++){
    const plateaus=pairs.map(p=>{
      const line=fit(p.track,center-3,center+3);
      if(!line)return null;
      const slope=(p.start.slope+p.end.slope)/2;
      if(Math.abs(line.slope-slope)*60/(2*Math.PI)>.05||line.rms/radiansPerSecond>.002)return null;
      const displacement=(line.at(center)-p.start.at(center))/radiansPerSecond;
      return Math.abs(displacement)>=.004?displacement:null;
    });
    if(plateaus.every(p=>p!==null)&&plateaus[0]*plateaus[1]>0){
      const ratio=Math.abs(plateaus[0]/plateaus[1]);
      if(ratio>.6&&ratio<1.67)return true;
    }
  }
  return false;
}
