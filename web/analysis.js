import { buildRegionalReference } from './long-regional-clock.js?v=34';
import { findPartialTempoRegions } from './partial-tempo-regions.js?v=34';
import { detectBeatTempoSteps, mergeBeatTempoSteps } from './beat-tempo-steps.js?v=32';
import { estimateDirectBodyClocks } from './direct-body-clocks.js?v=29';
import { verifyPersistentLowClock } from './persistent-low-clock.js?v=29';
import { detectShortTempoRamps, applyShortRampPrecision, mergeShortTempoRamps } from './short-tempo-ramps.js?v=29';
import { refineBeatPeriods, applyBeatPrecision } from './beat-precision.js?v=17';
import { detectSmallTempoSteps } from './small-tempo-steps.js?v=17';
/* Browser-local rhythm estimates. No audio, metadata, or results leave the device.
 * A time signature is an interpretation, not an observable property of a waveform:
 * the returned meter, alternatives, and confidence deliberately retain that ambiguity.
 */
import { refineLocalTempo, reconcileBodyTempo } from './tempo-grid.js?v=34';
import { discoverClocks, verifySteadyClock } from './steady-clock.js?v=34';
import { detectTempoChanges, annotateTempoChangeEvidence } from './tempo-changes.js?v=29';
import { estimateLocalClockPath } from './local-clocks.js?v=34';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = a => { const s = [...a].filter(Number.isFinite).sort((x,y)=>x-y); return s.length?s[Math.floor(s.length/2)]:0; };
const quantile = (a,q) => { const s = [...a].filter(Number.isFinite).sort((x,y)=>x-y); return s.length?s[Math.min(s.length-1, Math.floor(q*(s.length-1)))]:0; };
const tick = () => new Promise(r => setTimeout(r,0));
const densePulseBoundary=60/.07;
function stableTempo(beats,fallback) {
  if(beats.length<16||beats.some(b=>b.tempoChange||b.tempoGap||!Number.isFinite(b.bpm)))return fallback;
  const rates=beats.map(b=>b.bpm).filter(Number.isFinite),center=median(rates);
  if(!center)return fallback;
  if((quantile(rates,.9)-quantile(rates,.1))/center>.035)return fallback;
  const lag=Math.min(64,Math.floor((beats.length-1)/2/4)*4);
  if(lag<8)return fallback;
  const slopes=[];
  for(let i=0;i+lag<beats.length;i++){
    const dt=(beats[i+lag].time-beats[i].time)/lag;
    if(dt>0&&Math.abs(60/dt/center-1)<.04)slopes.push(dt);
  }
  return slopes.length?60/median(slopes):fallback;
}
const meterDefinitions = [
  {n:2,d:4,label:'2/4・4/4',alternatives:['2/4','4/4']},
  {n:3,d:4,label:'3/4',alternatives:['6/8']},
  {n:4,d:4,label:'4/4',alternatives:['2/4','12/8']},
  {n:5,d:4,label:'5/4',alternatives:['5/8']},
  {n:6,d:8,label:'6/8',alternatives:['3/4']},
  {n:7,d:8,label:'7/8',alternatives:['7/4']},
  {n:9,d:8,label:'9/8',alternatives:['9/4']},
  {n:12,d:8,label:'12/8',alternatives:['4/4']}
];

function fftPlan(size) {
  const rev = new Uint16Array(size), cos = new Float64Array(size/2), sin = new Float64Array(size/2);
  const bits = Math.log2(size);
  for (let i=0;i<size;i++) { let v=i,r=0; for(let k=0;k<bits;k++){r=(r<<1)|(v&1);v>>=1;} rev[i]=r; }
  for (let i=0;i<size/2;i++){cos[i]=Math.cos(-2*Math.PI*i/size);sin[i]=Math.sin(-2*Math.PI*i/size);}
  return (re,im) => {
    for(let i=0;i<size;i++){const j=rev[i]; if(j>i){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
    for(let len=2;len<=size;len*=2){const half=len/2,step=size/len;
      for(let i=0;i<size;i+=len)for(let j=0;j<half;j++){
        const k=j*step,a=i+j,b=a+half,tr=re[b]*cos[k]-im[b]*sin[k],ti=re[b]*sin[k]+im[b]*cos[k];
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
      }
    }
  };
}

async function extract(samples,sampleRate,progress,options={}) {
  const rate=Math.min(8000,sampleRate), ratio=sampleRate/rate;
  const pcm=new Float32Array(Math.ceil(samples.length/ratio));
  let sumSq=0,peak=0;
  for(let i=0;i<pcm.length;i++){
    const a=Math.floor(i*ratio),b=Math.min(samples.length,Math.max(a+1,Math.floor((i+1)*ratio)));let sum=0;
    for(let j=a;j<b;j++)sum+=Number.isFinite(samples[j])?samples[j]:0;
    const v=sum/(b-a);pcm[i]=v;sumSq+=v*v;peak=Math.max(peak,Math.abs(v));
  }
  if(peak<1e-5 || Math.sqrt(sumSq/Math.max(1,pcm.length))<1e-6)return null;
  // Normalization makes very quiet, valid recordings analyzable without changing accents.
  const gain=1/Math.max(peak,.00001);
  const size=512,hop=options.hop??128,fps=rate/hop,count=Math.ceil(pcm.length/hop);
  const fft=fftPlan(size),re=new Float64Array(size),im=new Float64Array(size),previous=new Float32Array(size/2);
  const flux=new Float32Array(count),rms=new Float32Array(count),bass=new Float32Array(count),energyRise=new Float32Array(count);
  const bandFlux=Array.from({length:3},()=>new Float32Array(count)),bandMass=new Float64Array(3);
  let spectralMass=0,spectralChange=0;
  const window=Float32Array.from({length:size},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(size-1)));
  for(let frame=0;frame<count;frame++){
    const center=frame*hop; let e=0;
    for(let j=0;j<size;j++){const pos=center+j-size/2;re[j]=(pos>=0&&pos<pcm.length?pcm[pos]*gain:0)*window[j];im[j]=0;}
    for(let j=Math.max(0,center-hop/2);j<Math.min(pcm.length,center+hop/2);j++)e+=(pcm[j]*gain)**2;
    rms[frame]=Math.sqrt(e/hop);energyRise[frame]=Math.max(0,rms[frame]-(rms[frame-1]||0));
    fft(re,im);let novelty=0,low=0;
    for(let k=1;k<size/2;k++){
      const mag=Math.sqrt(re[k]*re[k]+im[k]*im[k])/size;
      const compressed=Math.log1p(mag*100);const delta=Math.max(0,compressed-previous[k]);
      const frequency=k*rate/size,weight=frequency<180?1.25:frequency<2500?1:.65;
      const band=frequency<200?0:frequency<1600?1:2;
      bandFlux[band][frame]+=delta;bandMass[band]+=mag*mag;
      novelty+=delta*weight;spectralMass+=compressed;spectralChange+=delta;previous[k]=compressed;if(frequency<250)low+=mag*mag;
    }
    flux[frame]=novelty;bass[frame]=Math.sqrt(low);
    if(frame%2048===0){progress({stage:'音の立ち上がりを検出',progress:.05+.35*frame/count});await tick();}
  }
  const rmsHigh=quantile(Array.from(rms),.9),rmsLow=quantile(Array.from(rms),.1);
  // Window phase leakage in a steady tone is periodic but is not a musical pulse.
  if((rmsHigh-rmsLow)/Math.max(1e-9,rmsHigh)<.16 && spectralChange/Math.max(1e-9,spectralMass)<.025)return {stationary:true};
  const scale=quantile(Array.from(flux).filter(x=>x>0),.9)||1;
  const riseScale=quantile(Array.from(energyRise).filter(x=>x>0),.9)||1;
  const combined=Float32Array.from(flux,(v,i)=>v/scale+.35*energyRise[i]/riseScale);
  const prefix=new Float64Array(count+1),prefix2=new Float64Array(count+1);
  for(let i=0;i<count;i++){prefix[i+1]=prefix[i]+combined[i];prefix2[i+1]=prefix2[i]+combined[i]*combined[i];}
  const novelty=new Float32Array(count),tempoEnvelope=new Float32Array(count),peaks=[];
  const radius=Math.ceil(fps*.45);
  for(let i=1;i<count-1;i++){
    const a=Math.max(0,i-radius),b=Math.min(count,i+radius+1),mean=(prefix[b]-prefix[a])/(b-a);
    const sd=Math.sqrt(Math.max(0,(prefix2[b]-prefix2[a])/(b-a)-mean*mean));
    const value=Math.max(0,combined[i]-.65*mean);novelty[i]=Math.min(8,value);
    if(combined[i]>=combined[i-1]&&combined[i]>combined[i+1]&&combined[i]>mean+.12*sd&&value>.055){
      peaks.push(i);
      // Compress accent differences for pulse finding; retain original energy for meter.
      const v=Math.min(1.8,Math.pow(value,.28));
      tempoEnvelope[i]=v; if(i>0)tempoEnvelope[i-1]=Math.max(tempoEnvelope[i-1],v*.42);
      if(i+1<count)tempoEnvelope[i+1]=Math.max(tempoEnvelope[i+1],v*.42);
    }
  }
  // Keep timbre hierarchy for beat/subdivision selection. High-frequency hats can
  // carry many more attacks than kick/snare, without defining the main pulse.
  const totalMass=bandMass.reduce((a,b)=>a+b,0)||1;
  const useBands=[bandMass[0]/totalMass>.004,bandMass[1]/totalMass>.018];
  const bodyAvailable=useBands.some(Boolean);
  const bodyRaw=new Float32Array(count);let anchorRaw=null;
  for(let band=0;band<2;band++)if(useBands[band]){
    // Remove the broad high-frequency transient footprint before normalizing.
    // Otherwise a quiet hat's tiny low/mid leakage is amplified into a full beat.
    const values=Float32Array.from(bandFlux[band],(v,i)=>Math.max(0,v-(band===0?.04:.32)*Math.max(bandFlux[2][i],bandFlux[2][i-1]||0,bandFlux[2][i+1]||0)));
    const s=quantile(Array.from(values).filter(x=>x>1e-8),.9)||1;
    if(!anchorRaw)anchorRaw=Float32Array.from(values,v=>v/s);
    for(let i=0;i<count;i++)bodyRaw[i]+=values[i]/s;
  }
  const bodyEnvelope=new Float32Array(count),bodyEvents=[];
  const fastBodyEnvelope=new Float32Array(count),fastBodyEvents=[],fastAnchorEvents=[];
  // A fast ornament in a higher band does not establish the main pulse. The
  // lowest body band with material energy must independently fill that clock.
  const anchorSignal=anchorRaw||combined,anchorPrefix=new Float64Array(count+1);
  for(let i=0;i<count;i++)anchorPrefix[i+1]=anchorPrefix[i]+anchorSignal[i];
  for(let i=1;i<count-1;i++){
    const a=Math.max(0,i-radius),b=Math.min(count,i+radius+1),mean=(anchorPrefix[b]-anchorPrefix[a])/(b-a);
    if(anchorSignal[i]<anchorSignal[i-1]||anchorSignal[i]<=anchorSignal[i+1]||anchorSignal[i]<=mean*1.12||anchorSignal[i]<=.035)continue;
    const weight=Math.min(2,Math.pow(Math.max(.001,anchorSignal[i]-.55*mean),.38)),previous=fastAnchorEvents.at(-1);
    if(previous&&i-previous.frame<Math.max(1,Math.round(fps*.03))){
      if(weight>previous.weight){previous.frame=i;previous.weight=weight;}
    }else fastAnchorEvents.push({frame:i,weight});
  }
  const raw=bodyAvailable?bodyRaw:combined,rawPrefix=new Float64Array(count+1);
  for(let i=0;i<count;i++)rawPrefix[i+1]=rawPrefix[i]+raw[i];
  for(let i=1;i<count-1;i++){
    const a=Math.max(0,i-radius),b=Math.min(count,i+radius+1),mean=(rawPrefix[b]-rawPrefix[a])/(b-a);
    if(raw[i]>=raw[i-1]&&raw[i]>raw[i+1]&&raw[i]>mean*1.12&&raw[i]>.035){
      const weight=Math.min(2,Math.pow(Math.max(.001,raw[i]-.55*mean),.38));
      // Preserve a separate stream for pulse spacings below the normal 70 ms
      // lobe-merging window. It cannot change lower-tempo candidate evidence.
      const fastPrevious=fastBodyEvents.at(-1);
      if(fastPrevious&&i-fastPrevious.frame<Math.max(1,Math.round(fps*.03))){
        if(weight>fastPrevious.weight){fastBodyEnvelope[fastPrevious.frame]=0;fastPrevious.frame=i;fastPrevious.weight=weight;fastPrevious.salience=raw[i];fastBodyEnvelope[i]=weight;}
      }else{fastBodyEvents.push({frame:i,weight,salience:raw[i]});fastBodyEnvelope[i]=weight;}
      // Multiple spectral lobes of one attack are merged, not counted as extra beats.
      const prev=bodyEvents[bodyEvents.length-1];
      if(prev&&i-prev.frame<Math.round(fps*.07)){
        if(weight>prev.weight){bodyEnvelope[prev.frame]=0;prev.frame=i;prev.weight=weight;prev.salience=raw[i];bodyEnvelope[i]=weight;}
      }else{bodyEvents.push({frame:i,weight,salience:raw[i]});bodyEnvelope[i]=weight;}
    }
  }
  for(const {frame,weight}of bodyEvents){if(frame>0)bodyEnvelope[frame-1]=Math.max(bodyEnvelope[frame-1],weight*.4);if(frame<count-1)bodyEnvelope[frame+1]=Math.max(bodyEnvelope[frame+1],weight*.4);}
  for(const {frame,weight}of fastBodyEvents){if(frame>0)fastBodyEnvelope[frame-1]=Math.max(fastBodyEnvelope[frame-1],weight*.4);if(frame<count-1)fastBodyEnvelope[frame+1]=Math.max(fastBodyEnvelope[frame+1],weight*.4);}
  const fullEvents=peaks.map(frame=>({frame,weight:Math.min(2,Math.pow(novelty[frame],.38))}));
  return {rate,hop,fps,count,pcm,rms,bass,energyRise,novelty,tempoEnvelope,peaks,bodyEnvelope,bodyEvents,fastBodyEnvelope,fastBodyEvents,fastAnchorEvents,fullEvents,bodyAvailable,bandFlux,anchorRaw,useBands};
}

function autocorrelate(env,a,b,maxLag) {
  const out=new Float32Array(maxLag+2);
  for(let lag=1;lag<=maxLag;lag++){
    let cross=0,aa=0,bb=0,sx=0,sy=0;const length=b-a-lag;
    for(let i=a+lag;i<b;i++){const x=env[i],y=env[i-lag];cross+=x*y;aa+=x*x;bb+=y*y;sx+=x;sy+=y;}
    const cov=cross-sx*sy/length,vx=aa-sx*sx/length,vy=bb-sy*sy/length;
    out[lag]=vx>1e-10&&vy>1e-10?Math.max(0,cov/Math.sqrt(vx*vy)):0;
  }
  return out;
}
function lagScore(ac,lag){
  if(lag<1||lag>=ac.length-2)return 0;
  const i=Math.floor(lag),f=lag-i;
  // Peak tolerance covers quantization of attacks to the 16 ms analysis grid.
  return Math.max(ac[i]*(1-f)+ac[i+1]*f,ac[i-1]*.93,ac[i+1]*.93);
}

function eventIndex(events,frame) {
  let lo=0,hi=events.length;
  while(lo<hi){
    const mid=(lo+hi)>>>1;
    if(events[mid].frame<frame)lo=mid+1;
    else hi=mid;
  }
  return lo;
}

// Event windows are created once and passed to multiple candidate grids.
// Precompute the per-event arithmetic without changing double/float32 rounding.
const preparedGridWindows = new WeakMap();
function prepareGridWindow(events) {
  let prepared = preparedGridWindows.get(events);
  if (prepared) return prepared;
  const weights = Float64Array.from(events, event => event.weight);
  const scale = quantile(weights, .55) || 1;
  prepared = {
    frames: Float64Array.from(events, event => event.frame),
    weights,
    hitWeights: Float64Array.from(weights, weight => Math.min(1, weight / scale)),
    total: Math.max(weights.reduce((sum, weight) => sum + weight, 0), 1e-9),
  };
  preparedGridWindows.set(events, prepared);
  return prepared;
}

function gridFit(inside, a, b, period, widthFloor = .5) {
  if (inside.length < 3) return {score:0, capture:0, occupancy:0, phase:0};
  const { frames, weights, hitWeights, total } = prepareGridWindow(inside);
  // Half a frame covers onset quantization. A larger fixed floor would accept
  // almost any attack on a very fast grid and reward spurious subdivisions.
  const phases = 28, width = Math.max(widthFloor, Math.min(3, period * .10));
  const hits = new Float32Array(Math.ceil((b - a) / period) + 1);
  let best = {score:0, capture:0, occupancy:0, phase:0};
  let bestFirst = 0, bestCount = 0;
  for (let q = 0; q < phases; q++) {
    const phase = q * period / phases;
    const first = Math.ceil((a - phase) / period), last = Math.floor((b - 1 - phase) / period);
    const n = last - first + 1;
    if (n < 3) continue;
    hits.fill(0, 0, n);
    let captured = 0;
    for (let i = 0; i < frames.length; i++) {
      const position = frames[i] - phase;
      const slot = Math.round(position / period);
      const d = Math.abs(position - slot * period);
      const match = Math.exp(-.5 * (d / width)**2);
      captured += weights[i] * match;
      if (slot >= first && slot <= last) hits[slot-first] = Math.max(hits[slot-first], hitWeights[i] * match);
    }
    let filled = 0;
    for (let i = 0; i < n; i++) filled += hits[i];
    const capture = captured / total, occupancy = filled / n;
    const score = capture + occupancy > 0 ? 2 * capture * occupancy / (capture + occupancy) : 0;
    if (score > best.score) {
      best = {score, capture, occupancy, phase};
      bestFirst = first;
      bestCount = n;
    }
  }
  // Accent parity only affects the winning grid. Measure it once afterwards,
  // retaining the original float32 maxima of its even and odd slots.
  if (inside[0].salience !== undefined && bestCount >= 8 && best.occupancy > .48) {
    const accents = new Float32Array(bestCount);
    for (const event of inside) {
      const position = event.frame - best.phase, slot = Math.round(position / period) - bestFirst;
      if (slot < 0 || slot >= bestCount) continue;
      const d = Math.abs(position - (slot + bestFirst) * period);
      const match = Math.exp(-.5 * (d / width)**2);
      accents[slot] = Math.max(accents[slot], event.salience * match);
    }
    const even = median(accents.filter((_, i) => i % 2 === 0));
    const odd = median(accents.filter((_, i) => i % 2 === 1));
    best.subdivision = Math.abs(even - odd) / Math.max(even, odd, 1e-9);
  }
  return best;
}

const rawAnchorCache=new WeakMap();
function rawAnchorFit(data,bpm,first=0,last=data.count){
 if(!data.bodyAvailable||!data.anchorRaw)return {score:0,capture:0,occupancy:0};
 let events=rawAnchorCache.get(data);if(!events){events=data.fastAnchorEvents.map(e=>({frame:e.frame,weight:Math.max(0,data.anchorRaw[e.frame])}));rawAnchorCache.set(data,events);}
 const inside=events.slice(eventIndex(events,first),eventIndex(events,last));
 return gridFit(inside,first,last,data.fps*60/bpm,.5);
}
function rawBodySupport(data,bpm,blocks){
 if(!data.useBands?.[0]||!data.useBands?.[1])return false;
 return blocks.every(block=>{const first=Math.max(0,Math.round((block.time-2)*data.fps)),last=Math.min(data.count,Math.round((block.time+2)*data.fps)),fit=rawAnchorFit(data,bpm,first,last);return fit.capture>=.85&&fit.occupancy>=.70&&fit.score>=.80;});
}
async function estimateTempo(data,progress,spectralProposals=[]) {
  const {fps,count,tempoEnvelope:env,bodyEnvelope,bodyEvents,fastBodyEnvelope,fastBodyEvents,fastAnchorEvents,fullEvents}=data;
  // This is an internal multiscale search, not a visitor-supplied range. The same
  // signal is evaluated at competing metrical levels before an interpretation wins.
  const minBpm=35,maxBpm=1200;
  const bpms=Array.from({length:maxBpm-minBpm+1},(_,i)=>minBpm+i);
  // These longer windows choose a consistent pulse level. The separate short
  // modulation grid follows rapid changes without mistaking a sparse passage
  // or alternating accents for a new half/double interpretation.
  const stride=Math.round(fps*2);
  const centers=[];for(let t=0;t<count;t+=stride)centers.push(t);
  const fastSupportCounts=new Map();
  const windows=[],maxLag=Math.ceil(fps*60/minBpm*3.1),allHypotheses=[];
  for(let w=0;w<centers.length;w++){
    const c=centers[w],a=Math.max(0,Math.round(c-fps*5.5)),b=Math.min(count,Math.round(c+fps*5.5));
    const ac=autocorrelate(env,a,b,Math.min(maxLag,Math.floor((b-a)*.72)));
    const bodyAc=autocorrelate(bodyEnvelope,a,b,Math.min(maxLag,Math.floor((b-a)*.72)));
    const fastAc=fastBodyEvents.length===bodyEvents.length?bodyAc:autocorrelate(fastBodyEnvelope,a,b,Math.min(maxLag,Math.floor((b-a)*.72)));
    const raw=Float32Array.from(bpms,bpm=>{
      const lag=fps*60/bpm;
      const pulseAc=bpm>densePulseBoundary?fastAc:bodyAc;
      return .58*lagScore(pulseAc,lag)+.20*lagScore(ac,lag)+.14*lagScore(pulseAc,2*lag)+.08*lagScore(ac,3*lag);
    });
    const proposals=[];
    for(let j=0;j<bpms.length;j++)if((j===0||raw[j]>=raw[j-1])&&(j===bpms.length-1||raw[j]>=raw[j+1]))proposals.push(j);
    proposals.sort((a,b)=>raw[b]-raw[a]);
    const pathCandidates=new Set();
    for(const j of proposals.slice(0,9))for(const ratio of [1,.5,2,2/3,1.5,3]){
      const bpm=Math.round(bpms[j]*ratio);if(bpm>=minBpm&&bpm<=maxBpm)pathCandidates.add(bpm);
    }
    // Evaluate spectral clocks between integer frame lags as well. They supply
    // evidence for a verified whole-track clock, without forcing new metrical
    // levels into the changing-tempo path merely by covering more ornaments.
    const candidateSet=new Set([...pathCandidates,...spectralProposals.map(c=>Math.round(c.bpm)).filter(bpm=>bpm>=minBpm&&bpm<=maxBpm)]);
    const bodyWindow=bodyEvents.slice(eventIndex(bodyEvents,a),eventIndex(bodyEvents,b));
    const fastBodyWindow=fastBodyEvents.slice(eventIndex(fastBodyEvents,a),eventIndex(fastBodyEvents,b));
    const anchorWindow=fastAnchorEvents.slice(eventIndex(fastAnchorEvents,a),eventIndex(fastAnchorEvents,b));
    const fullWindow=fullEvents.slice(eventIndex(fullEvents,a),eventIndex(fullEvents,b));
    const candidates=[];
    for(const bpm of candidateSet){
      const periodicity=raw[bpm-minBpm];
      // Strong repeated attacks justify a wider quantization tolerance. With
      // weak periodicity a fixed wide tolerance would reward dense fast grids.
      const widthFloor=.5+.6*clamp((periodicity-.25)/.2,0,1);
      const period=fps*60/bpm,body=gridFit(bpm>densePulseBoundary?fastBodyWindow:bodyWindow,a,b,period,widthFloor),full=gridFit(fullWindow,a,b,period,widthFloor);
      if(bpm>densePulseBoundary&&Math.min(body.capture,body.occupancy)>.8&&periodicity>.25){
        const anchor=gridFit(anchorWindow,a,b,period,widthFloor);
        if(Math.min(anchor.capture,anchor.occupancy)>.8)fastSupportCounts.set(bpm,(fastSupportCounts.get(bpm)||0)+1);
      }
      const prior=.003*Math.exp(-.5*(Math.log2(bpm/115)/.75)**2);
      // Coverage carries independent information about attacks missed by a half-
      // tempo interpretation. A broad human-tempo prior must not overpower it.
      const fit=.55*body.score+.10*full.score+.15*periodicity+.20*body.capture;
      // Ranking fixed clocks balances slot occupancy against global harmonic
      // evidence; capture is already included in the balanced grid score.
      const clockFit=.45*body.score+.30*body.occupancy+.10*full.score+.15*periodicity;
      const score=fit+prior-.04*Math.max(0,(body.subdivision||0)-.5);
      candidates.push({bpm,score,fit,clockFit,periodicity,body,full,phase:body.phase,window:w});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const retained=[];
    for(const candidate of candidates){if(!pathCandidates.has(candidate.bpm))continue;if(retained.every(x=>Math.abs(Math.log2(x.bpm/candidate.bpm))>.022))retained.push(candidate);if(retained.length>=12)break;}
    windows.push(retained);allHypotheses.push(...candidates);
    if(w%5===0){progress({stage:'拍と細分音符の候補を比較',progress:.4+.25*w/centers.length});await tick();}
  }
  // Candidate pruning keeps continuity search O(windows × 12²), independent of
  // the width of the automatic BPM search.
  const back=windows.map(x=>new Uint8Array(x.length));
  let previous=Float64Array.from(windows[0],c=>c.score*3);
  for(let w=1;w<windows.length;w++){
    const next=new Float64Array(windows[w].length);
    for(let k=0;k<next.length;k++){
      let best=-Infinity,bj=0;
      for(let j=0;j<previous.length;j++){
        const distance=Math.abs(Math.log2(windows[w][k].bpm/windows[w-1][j].bpm));
        const v=previous[j]-2*distance;if(v>best){best=v;bj=j;}
      }
      next[k]=best+windows[w][k].score*3;back[w][k]=bj;
    }previous=next;
  }
  let k=0;for(let j=1;j<previous.length;j++)if(previous[j]>previous[k])k=j;
  const path=new Uint8Array(windows.length),chosen=[];
  for(let w=windows.length-1;w>=0;w--){path[w]=k;chosen[w]=windows[w][k];k=back[w][k];}
  const tempoAtFrame=frame=>{
    const pos=frame/stride,i=Math.min(chosen.length-1,Math.floor(pos)),j=Math.min(chosen.length-1,i+1),f=pos-i;
    return chosen[i].bpm*(1-f)+chosen[j].bpm*f;
  };
  const clusters=[];
  for(const hypothesis of allHypotheses){
    let cluster=clusters.find(c=>Math.abs(Math.log2(c.bpm/hypothesis.bpm))<.035);
    if(!cluster){cluster={bpm:hypothesis.bpm,members:new Map()};clusters.push(cluster);}
    const existing=cluster.members.get(hypothesis.window);
    if(!existing||hypothesis.score>existing.score)cluster.members.set(hypothesis.window,hypothesis);
  }
  const candidates=clusters.map(cluster=>{
    const members=[...cluster.members.values()],score=members.reduce((sum,c)=>sum+c.fit,0)/windows.length;
    return {bpm:members.reduce((sum,c)=>sum+c.bpm*c.fit,0)/Math.max(1e-9,members.reduce((sum,c)=>sum+c.fit,0)),score,
      support:members.length/windows.length,periodicity:members.reduce((sum,c)=>sum+c.periodicity,0)/members.length,
      bodyCoverage:members.reduce((sum,c)=>sum+c.body.capture,0)/members.length,bodyOccupancy:members.reduce((sum,c)=>sum+c.body.occupancy,0)/members.length};
  }).sort((a,b)=>b.score-a.score).slice(0,8);
  const selectedBpm=median(chosen.map(x=>x.bpm)),selectedScore=chosen.reduce((sum,c)=>sum+c.fit,0)/chosen.length;
  const selectedPeriodicity=chosen.reduce((sum,c)=>sum+c.periodicity,0)/chosen.length;
  // Compare competing pulse levels in the same windows. A tempo that really
  // occurs in another passage is not an alternative interpretation of this one.
  const alternatives=[];
  for(const ratio of [.5,2,2/3,1.5]){
    let support=0,score=0;
    for(let w=0;w<windows.length;w++){
      const other=windows[w].find(c=>Math.abs(Math.log2(c.bpm/(chosen[w].bpm*ratio)))<.055);
      if(other&&other.fit>=chosen[w].fit-.12){support++;score+=other.fit;}
    }
    if(support/Math.max(1,windows.length)>=.2)alternatives.push({bpm:selectedBpm*ratio,ratio,
      score:score/Math.max(1,support),support:support/windows.length,
      reason:ratio===.5||ratio===2?'倍・半分の拍解釈':'別の細分音符の解釈'});
  }
  const ambiguous=alternatives.length>0;
  const firstStrong=Math.max(0,chosen.findIndex(c=>c.fit>=selectedScore*.8&&c.periodicity>=.14));
  const referenceBpm=median(chosen.slice(firstStrong,firstStrong+5).map(c=>c.bpm))||selectedBpm;
  const clockScores=new Map();
  for(const candidate of allHypotheses){
    clockScores.set(candidate.bpm,(clockScores.get(candidate.bpm)||0)+candidate.clockFit/windows.length);
  }
  // A common subdivision clock can survive a real 120 -> 60 type change.
  // Preserve two sustained, directly observed body pulses instead of treating
  // their shared faster grid as proof that the main pulse never changed.
  const directRuns=[];let directRun=null;
  for(const candidate of chosen){
    const direct=Math.min(candidate.body.capture,candidate.body.occupancy)>.85&&candidate.periodicity>.6;
    if(!direct){directRun=null;continue;}
    if(!directRun||Math.abs(Math.log2(candidate.bpm/directRun.bpm))>=.04){directRun={bpm:candidate.bpm,count:0};directRuns.push(directRun);}
    directRun.count++;
  }
  const sustained=directRuns.filter(run=>run.count>=3);
  const directOctaveChange=sustained.some((a,i)=>sustained.slice(i+1).some(b=>Math.abs(Math.abs(Math.log2(a.bpm/b.bpm))-1)<.06));
  return {tempoAtFrame,centers,path,chosen,bpms,candidates,selectedScore,selectedPeriodicity,ambiguous,
    alternatives,referenceBpm,clockScores,directOctaveChange,fastSupportCounts,windowCount:windows.length};
}

function interpretPulse(tempo,options,tempoHint) {
  // A pulse interpretation is one relative scale for the whole tempo path.
  // A fixed-BPM prior at every window would erase real changes in other passages.
  const levels=[1/8,1/6,1/4,1/3,.5,2/3,1,1.5,2,3,4,6,8];
  const reference=Number(options.tempoReferenceBpm)||tempo.referenceBpm;
  let scale=options.tempoScale===undefined?1:Number(options.tempoScale);
  if(options.tempoScale===undefined&&tempoHint){
    scale=levels.reduce((best,value)=>Math.abs(Math.log2(value*reference/tempoHint))<Math.abs(Math.log2(best*reference/tempoHint))?value:best,1);
  }
  const rates=tempo.constantClock?[tempo.constantClock.bpm]:tempo.chosen.map(c=>c.bpm);
  if(!Number.isFinite(scale)||scale<1/16||scale>16||rates.some(bpm=>bpm*scale<10||bpm*scale>1200)){
    throw new Error('拍の取り方を10〜1200 BPMの範囲で選択してください。');
  }
  return {...tempo,scale,tempoAtFrame:frame=>tempo.tempoAtFrame(frame)*scale,
    chosen:tempo.chosen.map(c=>({...c,bpm:c.bpm*scale})),
    candidates:tempo.candidates.map(c=>({...c,bpm:c.bpm*scale})),
    alternatives:tempo.alternatives.map(c=>({...c,bpm:c.bpm*scale}))};
}

function refineOnsetTime(data,frame) {
  const fineHop=Math.max(1,Math.round(data.rate/1000));
    const first=Math.max(0,Math.round(frame*data.hop-data.rate*.033)),last=Math.min(data.pcm.length,Math.round(frame*data.hop+data.rate*.034));
    const powers=[];
    for(let a=first;a+fineHop<last;a+=fineHop){let e=0;for(let j=a;j<a+fineHop;j++)e+=data.pcm[j]*data.pcm[j];powers.push(e/fineHop);}
    const rises=new Float64Array(powers.length);let best=0,position=0;
    for(let i=3;i<powers.length-2;i++){
      const after=(powers[i]+powers[i+1]+powers[i+2])/3,before=(powers[i-1]+powers[i-2]+powers[i-3])/3;
      const distance=(first+i*fineHop-frame*data.hop)/data.rate;
      const value=Math.max(0,after-before)*Math.exp(-.5*(distance/.020)**2);rises[i]=value;
      if(value>best){best=value;position=i;}
    }
    if(!best)return frame/data.fps;
    const before=rises[position-1]||0,after=rises[position+1]||0,den=before-2*best+after;
    const fractional=den?clamp(.5*(before-after)/den,-.5,.5):0;
    return Math.max(0,(first+(position+fractional)*fineHop)/data.rate);
}

async function trackBeats(data,tempo,progress) {
  const {fps,count,peaks,novelty,rms,bass,energyRise,bodyEnvelope}=data;
  if(peaks.length<3)return [];
  const envelope=new Float32Array(count);
  // Keep attack locations sharp but prevent a loud downbeat from swallowing quiet beats.
  for(const p of peaks){const v=.32*Math.min(2.3,Math.pow(novelty[p],.35));envelope[p]=v;if(p>0)envelope[p-1]=Math.max(envelope[p-1],v*.45);if(p<count-1)envelope[p+1]=Math.max(envelope[p+1],v*.45);}
  for(let i=0;i<count;i++)envelope[i]+=.82*(tempo.tempoAtFrame(i)>densePulseBoundary?data.fastBodyEnvelope:bodyEnvelope)[i];
  const regions=[];let start=peaks[0],previous=peaks[0];
  for(let z=1;z<peaks.length;z++){
    const p=peaks[z];if(p-previous>fps*Math.max(2.8,3*60/tempo.tempoAtFrame(previous))){regions.push([start,previous]);start=p;}previous=p;
  }regions.push([start,previous]);
  const frames=[];
  for(let r=0;r<regions.length;r++){
    const [first,last]=regions[r];if(last-first<fps*.8)continue;
    const a=Math.max(0,first-Math.round(fps*.12)),b=Math.min(count,last+Math.round(fps*.15)+1),len=b-a;
    const dp=new Float64Array(len),back=new Int32Array(len);back.fill(-1);
    for(let x=0;x<len;x++){
      const i=a+x,period=fps*60/tempo.tempoAtFrame(i),lo=Math.max(0,x-Math.ceil(period*1.7)),hi=x-Math.floor(period*.56);
      let best=0,bj=-1;
      for(let j=lo;j<=hi;j++){
        const cost=15*Math.log((x-j)/period)**2,v=dp[j]-cost;
        if(v>best){best=v;bj=j;}
      }
      dp[x]=best+envelope[i]-.12;back[x]=bj;
      if(x%8192===0){progress({stage:'拍の位置を整列',progress:.77+.05*(r+x/len)/regions.length});await tick();}
    }
    let endpoint=len-1,best=-Infinity;
    const lookBack=Math.ceil(fps*90/tempo.tempoAtFrame(last));
    for(let x=Math.max(0,len-lookBack);x<len;x++)if(dp[x]>best){best=dp[x];endpoint=x;}
    const path=[];for(let x=endpoint;x>=0;x=back[x]){path.push(a+x);if(back[x]<0)break;}
    path.reverse();frames.push(...path);
  }
  const beats=[];
  for(const frame of frames){
    const period=fps*60/tempo.tempoAtFrame(frame),radius=Math.max(1,Math.min(Math.round(fps*.07),Math.round(period*.14)));
    let pos=frame,score=-1;
    for(let j=Math.max(0,frame-radius);j<=Math.min(count-1,frame+radius);j++){
      const value=(energyRise[j]+rms[j]*.10)*Math.exp(-.5*((j-frame)/(radius*.8))**2);
      if(value>score){score=value;pos=j;}
    }
    let amp=0,low=0;
    for(let j=Math.max(0,pos-1);j<=Math.min(count-1,pos+3);j++){amp=Math.max(amp,rms[j]);low=Math.max(low,bass[j]);}
    const time=refineOnsetTime(data,pos);
    let lowOnset=0,midOnset=0;
    for(let j=Math.max(0,pos-2);j<=Math.min(count-1,pos+2);j++){lowOnset=Math.max(lowOnset,data.bandFlux[0][j]);midOnset=Math.max(midOnset,data.bandFlux[1][j]);}
    if(!beats.length||time-beats[beats.length-1].time>.035)beats.push({time,bpm:tempo.tempoAtFrame(frame),strength:amp+.65*low,attack:clamp(envelope[frame]/2,0,1),frame:pos,lowOnset,midOnset});
  }
  refineTempoCurve(beats);
  if(tempo.evidenceAtFrame){
    let gap=false;
    for(let i=0;i<beats.length;i++){
      const beat=beats[i],frame=beat.time*fps,evidence=tempo.evidenceAtFrame(frame);
      const intervals=beats.slice(Math.max(0,i-2),Math.min(beats.length,i+4)).slice(1)
        .map((b,j)=>b.time-beats[Math.max(0,i-2)+j].time);
      const period=median(intervals);
      const regular=intervals.length>=3&&period>0&&(quantile(intervals,.9)-quantile(intervals,.1))/period<.035;
      if(evidence.supported){
        // A syncopated loud attack can move the snapped beat by tens of ms.
        // Use the supported modulation grid for BPM instead of converting that
        // onset displacement into a fictitious acceleration/deceleration.
        beat.bpm=tempo.tempoAtFrame(frame);
        beat.tempoSource='onset-grid';
      }else if(regular&&Math.abs(Math.log2((60/period)/tempo.tempoAtFrame(frame)))<.12){
        beat.bpm=60/period;beat.tempoSource='beat-interval';
      }else{
        beat.bpm=null;beat.tempoSource='uncertain';
      }
      beat.tempoEvidence=evidence.coherence;
      if(tempo.constantClock){
        // Verify the clock from the audio before treating changes in attack
        // density as subdivisions. Constant output is never selected merely
        // because the visitor expects a fixed BPM.
        if(beat.bpm!==null){beat.bpm=tempo.tempoAtFrame(frame);beat.tempoSource='constant-clock';}
        delete beat.tempoChange;
      }
      if(gap&&beat.bpm)beat.tempoGap=true;
      gap=!beat.bpm;
    }
  }
  return beats;
}

function refineTempoCurve(beats) {
  // Each interval describes the pulse rate starting at its first beat.
  const periods=beats.slice(0,-1).map((beat,i)=>beats[i+1].time-beat.time);
  const gaps=periods.map((period,i)=>period>1.65*60/Math.min(beats[i].bpm,beats[i+1].bpm));
  const candidates=[];
  for(let i=3;i+3<=periods.length;i++){
    if(gaps.slice(i-3,i+3).some(Boolean))continue;
    const left=periods.slice(i-3,i),right=periods.slice(i,i+3);
    const before=median(left),after=median(right),jump=Math.abs(after-before);
    if(jump<.02*Math.min(before,after))continue;
    // A sustained step has internally consistent intervals on both sides.
    // A ramp, a single displaced onset, or a missing pulse should not split it.
    const scatter=Math.max(...left.map(p=>Math.abs(p-before)),...right.map(p=>Math.abs(p-after)));
    if(scatter<=jump*.33)candidates.push({i,score:jump/Math.min(before,after)});
  }
  const changes=new Set();
  for(const {i} of candidates.sort((a,b)=>b.score-a.score)){
    if(!changes.has(i-1)&&!changes.has(i+1))changes.add(i);
  }

  let start=0;
  for(let end=1;end<=periods.length;end++){
    if(end!==periods.length&&!changes.has(end)&&!gaps[end-1])continue;
    const stop=gaps[end-1]?end-1:end;
    for(let i=start;i<stop;i++){
      // Symmetric spans cancel linear tempo drift while averaging out
      // onset jitter. Use one-sided data at a boundary only.
      const radius=Math.min(2,i-start,stop-i-1);
      const lo=radius?i-radius:Math.max(start,i-2);
      const hi=radius?i+radius+1:Math.min(stop,i+3);
      const local=periods.slice(lo,hi);
      const period=radius&&Math.max(...local)-Math.min(...local)<.12*median(local)
        ?(beats[hi].time-beats[lo].time)/(hi-lo):median(local);
      beats[i].bpm=60/period;
    }
    if(changes.has(start))beats[start].tempoChange=true;
    if(start>0&&gaps[start-1])beats[start].tempoGap=true;
    if(!changes.has(end)&&stop>start)beats[stop].bpm=beats[stop-1].bpm;
    start=end;
  }
  if(start>0&&gaps[start-1])beats[start].tempoGap=true;
}

function foldFit(strengths,start,end,n) {
  start=Math.max(0,start);end=Math.min(strengths.length,end);
  const length=end-start;if(length<n*2.8)return {score:-1,r2:0,phase:0,contrast:0};
  const sums=new Float64Array(n),counts=new Float64Array(n);let total=0,total2=0;
  for(let i=start;i<end;i++){const v=strengths[i];sums[i%n]+=v;counts[i%n]++;total+=v;total2+=v*v;}
  const mean=total/length,variance=total2-total*mean;
  if(variance<1e-7)return {score:0,r2:0,phase:0,contrast:0};
  const means=Array.from(sums,(v,i)=>v/Math.max(1,counts[i]));let explained=0,phase=0;
  for(let j=0;j<n;j++){explained+=counts[j]*(means[j]-mean)**2;if(means[j]>means[phase])phase=j;}
  const r2=clamp(explained/variance,0,1);
  const contrast=(means[phase]-mean)/(Math.sqrt(variance/length)+.00001);
  // Correct the additional degrees of freedom; multiples of a shorter period should lose.
  const adjusted=1-(1-r2)*(length-1)/Math.max(1,length-n);
  const amplitudeContrast=(Math.max(...means)-Math.min(...means))/Math.max(1e-9,Math.max(...means));
  return {score:adjusted-.010*n,r2,phase,contrast,means,amplitudeContrast};
}

function shortBarCandidates(strengths) {
  const low=quantile(strengths,.2),high=quantile(strengths,.95);
  if((high-low)/Math.max(high,1e-9)<.22)return [];
  const threshold=low+.72*(high-low),accents=[];
  for(let i=0;i<strengths.length;i++)if(strengths[i]>=threshold&&(i===0||strengths[i]>=strengths[i-1])&&(i===strengths.length-1||strengths[i]>strengths[i+1]))accents.push(i);
  const candidates=[];
  for(let i=2;i<accents.length-3;i++){
    const a=accents[i],b=accents[i+1],gap=b-a;
    if(![3,5,7,9,11].includes(gap))continue;
    const before=[accents[i]-accents[i-1],accents[i-1]-accents[i-2]],after=[accents[i+2]-accents[i+1],accents[i+3]-accents[i+2]];
    const usual=median([...before,...after]);
    if(![3,4,6].includes(usual)||usual===gap||before.some(x=>x!==usual)||after.some(x=>x!==usual))continue;
    const lf=foldFit(strengths,a-usual*4,a,usual),rf=foldFit(strengths,b,b+usual*4,usual);
    if(lf.r2<.55||rf.r2<.55)continue;
    candidates.push({a,b,n:gap,confidence:Math.min(.58,.3+.15*(lf.r2+rf.r2))});
  }
  return candidates;
}

function estimateMeters(beats,duration) {
  if(beats.length<9)return {sections:[{start:0,end:duration,bpm:beats.length?median(beats.map(b=>b.bpm)):null,meter:'判定保留',label:'拍子の情報が不足',confidence:0,type:'uncertain',numerator:null,denominator:null,alternatives:[]}],meterConfidence:0};
  // A gentle compression retains accent structure without letting one transient dominate.
  const raw=beats.map(b=>Math.sqrt(Math.max(0,b.strength))),limit=quantile(raw,.97)||1;
  const strengths=raw.map(v=>Math.min(v,limit));
  const fits=beats.map((_,i)=>meterDefinitions.map(def=>foldFit(strengths,i-21,i+22,def.n)));
  const n=beats.length,m=meterDefinitions.length,back=Array.from({length:n},()=>new Uint8Array(m));
  let prev=Float64Array.from(fits[0],f=>f.score);
  for(let i=1;i<n;i++){
    const next=new Float64Array(m);
    for(let k=0;k<m;k++){let best=-Infinity,bj=0;
      for(let j=0;j<m;j++){const v=prev[j]-(j===k?0:.8);if(v>best){best=v;bj=j;}}
      next[k]=best+Math.max(-.8,fits[i][k].score);back[i][k]=bj;
    }prev=next;
  }
  let state=0;for(let j=1;j<m;j++)if(prev[j]>prev[state])state=j;
  const states=new Uint8Array(n);for(let i=n-1;i>=0;i--){states[i]=state;state=back[i][state];}
  let runs=[];for(let i=0;i<n;i++){if(!runs.length||runs[runs.length-1].state!==states[i])runs.push({a:i,b:i+1,state:states[i]});else runs[runs.length-1].b=i+1;}
  // Suppress islands shorter than two bars; short passages remain visible through tempo data.
  for(let i=0;i<runs.length;i++)if(runs.length>1&&runs[i].b-runs[i].a<Math.max(6,meterDefinitions[runs[i].state].n*2)){
    const replace=i===0?runs[i+1].state:runs[i-1].state;for(let j=runs[i].a;j<runs[i].b;j++)states[j]=replace;
  }
  runs=[];for(let i=0;i<n;i++){if(!runs.length||runs[runs.length-1].state!==states[i])runs.push({a:i,b:i+1,state:states[i]});else runs[runs.length-1].b=i+1;}
  // Locate a change from the accent data on either side, rather than the center of a window.
  for(let r=1;r<runs.length;r++){
    const left=runs[r-1],right=runs[r],ln=meterDefinitions[left.state].n,rn=meterDefinitions[right.state].n;
    let split=right.a,best=-Infinity;
    const lo=Math.max(left.a+ln*2,split-20),hi=Math.min(right.b-rn*2,split+20);
    for(let j=lo;j<=hi;j++){
      const lf=foldFit(strengths,Math.max(left.a,j-32),j,ln),rf=foldFit(strengths,j,Math.min(right.b,j+35),rn);
      const score=lf.score+rf.score;
      if(score>best){best=score;split=j;}
    }
    // A new measure starts on its accented first pulse. Weak pickup pulses before
    // that accent can fit either period and cannot locate a boundary by R² alone.
    const rightFit=foldFit(strengths,split,Math.min(right.b,split+42),rn);
    const align=((rightFit.phase-split)%rn+rn)%rn;
    if(split+align<right.b-rn*2)split+=align;
    left.b=split;right.a=split;
  }
  const short=shortBarCandidates(strengths);
  if(short.length){
    const boundaries=[...new Set([0,n,...runs.flatMap(r=>[r.a,r.b]),...short.flatMap(r=>[r.a,r.b])])].sort((a,b)=>a-b);
    const partition=[];
    for(let i=0;i<boundaries.length-1;i++){
      const a=boundaries[i],b=boundaries[i+1];if(b<=a)continue;
      const anomaly=short.find(x=>a>=x.a&&b<=x.b),original=runs.find(x=>a>=x.a&&a<x.b);
      if(anomaly)partition.push({a,b,state:original?.state||0,shortN:anomaly.n,shortConfidence:anomaly.confidence});
      else partition.push({a,b,state:original?.state||0});
    }runs=partition;
  }
  let bar=1;
  const sections=runs.map((run,index)=>{
    if(run.shortN){
      for(let j=run.a;j<run.b;j++){beats[j].downbeat=j===run.a;beats[j].bar=bar;beats[j].beatInBar=j-run.a+1;beats[j].numerator=run.shortN;beats[j].denominator=null;}bar++;
      return {start:beats[run.a].time,end:run.b<beats.length?beats[run.b].time:duration,bpm:median(beats.slice(run.a,run.b).map(b=>b.bpm)),
        meter:`${run.shortN}拍周期候補`,label:'短い拍子変化の候補',confidence:run.shortConfidence,type:'irregularity',numerator:run.shortN,denominator:null,
        alternatives:[`${run.shortN}/8`,`${run.shortN}/4`],accentPeriod:run.shortN,beatStart:run.a,beatEnd:run.b};
    }
    const def=meterDefinitions[run.state],fit=foldFit(strengths,run.a,run.b,def.n);
    const alternatives=meterDefinitions.map(d=>({def:d,fit:foldFit(strengths,run.a,run.b,d.n)})).sort((a,b)=>b.fit.score-a.fit.score);
    const second=alternatives.find(x=>x.def.n!==def.n&&x.def.n%def.n!==0&&def.n%x.def.n!==0);
    const contrast=second?Math.max(0,fit.score-second.fit.score):0;
    const enough=run.b-run.a>=def.n*3;
    let confidence=clamp(.62*fit.r2+.25*Math.min(1,contrast*2)+.13*Math.min(1,(run.b-run.a)/(def.n*6)),0,.96);
    const valid=enough&&fit.r2>.34&&fit.contrast>.55&&fit.amplitudeContrast>.18;
    if(def.n===2)confidence=Math.min(confidence,.64);
    if(!valid)confidence=Math.min(confidence,.32);
    let phase=fit.phase;
    for(let j=run.a;j<run.b;j++){
      beats[j].downbeat=valid&&j%def.n===phase;
      if(beats[j].downbeat&&j>run.a)bar++;
      beats[j].bar=bar;beats[j].beatInBar=valid?((j-phase)%def.n+def.n)%def.n+1:null;
      beats[j].numerator=valid?def.n:null;beats[j].denominator=valid?def.d:null;
    }
    const localBeats=beats.slice(run.a,run.b);
    const lowProfile=beats.map(b=>Math.sqrt(Math.max(0,b.lowOnset||0)));
    const independent=meterDefinitions.map(d=>({n:d.n,...foldFit(lowProfile,run.a,run.b,d.n)})).sort((a,b)=>b.score-a.score)[0];
    const conflicting=valid&&independent?.r2>.52&&independent.amplitudeContrast>.20&&def.n!==independent.n&&def.n!==2*independent.n;
    if(conflicting)confidence=Math.min(confidence,.38);
    else confidence=Math.min(confidence,def.n===2?.60:.84);
    const supportedRates=localBeats.map(b=>b.bpm).filter(bpm=>Number.isFinite(bpm)&&bpm>0);
    const section={start:index===0?0:beats[run.a].time,end:index===runs.length-1?duration:beats[run.b].time,
      bpm:supportedRates.length?stableTempo(localBeats,median(supportedRates)):null,meter:valid&&!conflicting?def.label:'判定保留',
      label:valid?(index?'拍子の切り替わり候補':'拍子候補'):'アクセント周期が不明瞭',confidence,
      type:valid&&!conflicting?(def.n===5||def.n===7||def.n===9?'odd':'meter'):'uncertain',
      numerator:valid&&!conflicting?def.n:null,denominator:valid&&!conflicting?def.d:null,
      alternatives:conflicting?[...new Set([def.label,...def.alternatives,independent.n===2?'4/4':`${independent.n}/4`])]:valid?def.alternatives:alternatives.filter(x=>x.fit.r2>.2).slice(0,3).map(x=>x.def.label),
      meterAmbiguous:true,independentAccentPeriod:independent?.r2>.5?independent.n:null,
      groupingCandidates:def.n===5?['3+2','2+3']:def.n===7?['2+2+3','2+3+2','3+2+2']:def.n===6?['3+3','2+2+2']:[],
      accentPeriod:valid?def.n:null,beatStart:run.a,beatEnd:run.b};
    if(conflicting){section.label='低音と全体のアクセント周期が競合';for(let j=run.a;j<run.b;j++){beats[j].downbeat=false;beats[j].beatInBar=null;beats[j].numerator=null;beats[j].denominator=null;}}
    return section;
  });
  for(let i=1;i<sections.length;i++){
    const before=sections[i-1],after=sections[i];
    if(before.type==='irregularity'||after.type==='irregularity')continue;
    if(before.numerator&&after.numerator&&before.numerator!==after.numerator){
      const leftOwn=foldFit(strengths,before.beatStart,before.beatEnd,before.numerator),leftOther=foldFit(strengths,before.beatStart,before.beatEnd,after.numerator);
      const rightOwn=foldFit(strengths,after.beatStart,after.beatEnd,after.numerator),rightOther=foldFit(strengths,after.beatStart,after.beatEnd,before.numerator);
      after.changeConfidence=clamp(Math.min(leftOwn.r2-leftOther.r2,rightOwn.r2-rightOther.r2)*1.4,0,.85);
      after.isMeterChange=after.changeConfidence>.22&&before.confidence>.5&&after.confidence>.5;
      if(!after.isMeterChange)after.label='アクセント周期の別候補';
    }else after.isMeterChange=false;
  }
  return {sections,meterConfidence:sections.reduce((s,x)=>s+x.confidence*(x.end-x.start),0)/duration};
}

function splitTempoSections(sections,beats) {
  const output=[];
  for(const section of sections){
    const within=beats.filter(b=>b.time>=section.start&&b.time<section.end);
    const cuts=[0];
    for(let i=1;i<within.length;i++)if(within[i].tempoChange)cuts.push(i);
    cuts.push(within.length);
    for(let z=0;z<cuts.length-1;z++){
      const a=cuts[z],b=cuts[z+1];
      const values=within.slice(a,b).map(beat=>beat.bpm).filter(bpm=>Number.isFinite(bpm)&&bpm>0);
      const bpm=values.length?median(values):null;
      const lo=values.length?quantile(values,.1):null,hi=values.length?quantile(values,.9):null;
      const spread=bpm?(hi-lo)/bpm:0;
      const changed=within[a]?.tempoChange;
      const varying=spread>.02;
      output.push({...section,
        start:z===0?section.start:within[a].time,
        end:b===within.length?section.end:within[b].time,
        beatStart:(section.beatStart??0)+a,beatEnd:(section.beatStart??0)+b,
        bpm,tempoMin:lo,tempoMax:hi,tempoVariation:spread,
        tempoLabel:changed?'BPM切り替え':varying?'テンポの揺れ':undefined});
    }
  }
  return output;
}

function clockRegions(clocks,changes,duration,scale,reference,fineCurve){
  if(!clocks)return [];
  const groups=[];let group=null,established=false,referenceRun=0;
  for(const point of clocks.curve){
    referenceRun=point.supported&&Math.abs(Math.log2(point.bpm/reference))<.035?referenceRun+.5:0;
    if(referenceRun>=4)established=true;
    const eligible=established&&point.supported&&point.coherence>=.05&&point.quality>.4&&point.bodyCapture>.30&&point.bodyOccupancy>.5&&
      Math.abs(Math.log2(point.bpm/clocks.anchorAtFrame(point.frame)))<.05&&Math.abs(Math.log2(point.bpm/reference))>.04;
    if(!eligible){group=null;continue;}
    if(!group||point.time-group.at(-1).time>.75||Math.abs(Math.log2(point.bpm/median(group.map(p=>p.bpm))))>.03){group=[];groups.push(group);}
    group.push(point);
  }
  return groups.filter(points=>points.at(-1).time-points[0].time+.5>=Math.max(.8,120/median(points.map(p=>p.bpm))))
    .map(points=>{
      const bpm=median(points.map(p=>p.bpm))*scale,start=Math.max(0,points[0].time-.25),end=Math.min(duration,points.at(-1).time+.25);
      const alternatives=[];
      for(const point of points)for(const c of point.alternatives||[])if(c.score>0&&c.coherence>.035&&Math.abs(Math.log2(c.bpm*scale/bpm))>.06&&alternatives.every(a=>Math.abs(Math.log2(a.bpm/(c.bpm*scale)))>.06))alternatives.push({bpm:c.bpm*scale});
      return {start,end,bpm,confidence:Math.min(.65,.35+.3*median(points.map(p=>p.quality))+.2*Math.min(1,median(points.map(p=>p.coherence))/.15)),
        timeUncertainty:2,ambiguous:true,alternatives:alternatives.slice(0,2),source:'local-harmonic-clock'};
    }).filter(region=>{
      const observed=fineCurve.filter(point=>point.time>=region.start&&point.time<=region.end&&Number.isFinite(point.bpm));
      const matching=observed.filter(point=>Math.abs(Math.log2(point.bpm/region.bpm))<.06);
      return matching.length>=Math.max(4,observed.length*.4)&&matching.at(-1).time-matching[0].time>=.479;
    }).filter(region=>!changes.some(change=>change.end>=region.start-3&&change.start<=region.end+3&&
      [change.fromBpm,change.toBpm].some(bpm=>Math.abs(Math.log2(bpm/region.bpm))<.035)));
}

function refineChangeRates(data,changes,duration,scale){
  // Estimate each endpoint from the surrounding stable audio, rather than a
  // derivative peak that can overshoot while the local phase model settles.
  return changes.map((change,index)=>{
    const previous=index?changes[index-1].end+.5:0,next=index+1<changes.length?changes[index+1].start-.5:duration;
    const windows=[['fromBpm',Math.max(previous,change.start-14.5),change.start-.5],
      ['toBpm',change.end+.5,Math.min(next,change.end+14.5)]];
    const result={...change};
    for(const [field,start,end]of windows){
      const a=Math.max(0,Math.round(start*data.fps)),b=Math.min(data.count,Math.round(end*data.fps)),span=(b-a)/data.fps;
      if(span<4)continue;
      const segment={fps:data.fps,count:b-a,novelty:data.novelty.slice(a,b),bandFlux:data.bandFlux.map(band=>band.slice(a,b))};
      const fit=verifySteadyClock(segment,result[field]/scale,[],{minDuration:4,windowSeconds:Math.min(4,span/2),windowStep:.5});
      if(fit.accepted)result[field]=fit.bpm*scale;
    }
    return result;
  });
}

/** Analyze one mono PCM signal. Progress is {stage:string, progress:0..1}.
 * Options: tempoHint (optional initial pulse interpretation), tempoScale
 * (explicit relative pulse scale), tempoReferenceBpm (reference for tempoHint).
 * Interpretation scales the changing tempo path rather than fixing its BPM.
 * BPM means
 * the detected pulse rate; tempo search is automatic over multiple scales.
 * notated quarter-note / dotted-quarter equivalence cannot be proven from audio.
 */
export async function analyzeAudio(samples,sampleRate,options={},onProgress=()=>{}) {
  if(!(samples instanceof Float32Array)&&!ArrayBuffer.isView(samples))throw new TypeError('PCM音声データが必要です。');
  if(!Number.isFinite(sampleRate)||sampleRate<1000||sampleRate>384000)throw new Error('音声のサンプルレートを確認してください。');
  const duration=samples.length/sampleRate;
  const progress=event=>{try{onProgress(event);}catch{}};
  const empty=note=>{
    progress({stage:'解析完了',progress:1});
    return {bpm:null,bpmMin:null,bpmMax:null,confidence:0,beats:[],sections:[],tempoCurve:[],tempoChanges:[],tempoRegions:[],candidates:[],duration,notes:[note],pulseUnit:'検出拍',method:'spectral-flux / local autocorrelation / dynamic beat tracking / accent periodicity'};
  };
  if(duration<2)return empty('解析には2秒以上の音源を使用してください。');
  const hintProvided=options.tempoHint!==undefined&&options.tempoHint!==null;
  const tempoHint=hintProvided?Number(options.tempoHint):null;
  if(hintProvided&&(!Number.isFinite(tempoHint)||tempoHint<10||tempoHint>1200))throw new Error('選択する拍解釈は10〜1200 BPMの範囲で指定してください。');
  progress({stage:'音声を準備',progress:.02});await tick();
  const data=await extract(samples,sampleRate,progress);
  if(!data)return empty('音声が無音、または音量が小さすぎるため、拍を検出できませんでした。');
  if(data.stationary)return empty('持続音に近く、信頼できる音の立ち上がりや拍の手掛かりを検出できませんでした。');
  if(data.peaks.length<3)return empty('音の立ち上がりが少なく、安定した拍を検出できませんでした。');
  const spectralProposals=discoverClocks(data,[],{maxBpm:1200,limit:24});
  const automaticTempo=await estimateTempo(data,progress,spectralProposals);
  if(!automaticTempo.candidates.length)return empty('拍の周期性が弱く、信頼できるBPMを特定できませんでした。');
  progress({stage:'短いテンポ変化と細分音符の周期を照合',progress:.65});await tick();
  const localTempoOptions={maxBpm:1200,memoizeAnchors:true};
  let local=refineLocalTempo(data,automaticTempo.tempoAtFrame,localTempoOptions);
  progress({stage:'一定テンポが音源全体に合うか確認',progress:.65});await tick();
  // The introduction need not carry the main pulse. Retain body-pulse ranking
  // while also testing sustained candidates discovered in the full spectrum.
  const references=[automaticTempo.referenceBpm,...automaticTempo.candidates.slice(0,3).map(c=>c.bpm)];
  const discovered=discoverClocks(data,references,{maxBpm:1200,limit:12});
  const clockCandidates=[];
  for(const bpm of [...references,...discovered.map(c=>c.bpm)]){
    if(clockCandidates.every(previous=>Math.abs(Math.log2(previous/bpm))>.008))clockCandidates.push(bpm);
  }
  const smallStepOpposition=detectSmallTempoSteps(local.curve,duration).length>0;
  const plans=[];
  for(let i=0;i<clockCandidates.length;i++){
    if(automaticTempo.directOctaveChange&&Math.abs(Math.log2(clockCandidates[i]/automaticTempo.referenceBpm))>.035)continue;
    const fastPulseSupport=Math.max(...[-1,0,1].map(delta=>automaticTempo.fastSupportCounts.get(Math.round(clockCandidates[i])+delta)||0))/automaticTempo.windowCount>=.8;
    const candidate=verifySteadyClock(data,clockCandidates[i],local.curve,{smallStepOpposition,fastPulseSupport});
    candidate.localFit=Math.max(...[-1,0,1].map(delta=>automaticTempo.clockScores.get(Math.round(candidate.bpm)+delta)||0));
    plans.push({referenceBpm:clockCandidates[i],fastPulseSupport,candidate});
    if(i%3===2)await tick();
  }
  // Include meaningful rejected clocks: a lower-quality half clock must not
  // gain an exception merely because the full body clock had a HIGH warp.
  const meaningful=candidate=>candidate.phaseCoverage>=.92&&candidate.usableHarmonics?.length>=2&&
    !candidate.smallStepOpposition&&!candidate.bodyPhaseWarp&&candidate.unexplainedOpposition<1;
  const strongestBody=Math.max(0,...plans.filter(plan=>meaningful(plan.candidate)).map(plan=>plan.candidate.localFit));
  const verified=[];let secondaryHighData;
  for(const plan of plans){
    let candidate=plan.candidate;
    const champion=meaningful(candidate)&&candidate.localFit>=strongestBody;
    if(champion){
      const qualified=verifySteadyClock(data,plan.referenceBpm,local.curve,{smallStepOpposition,fastPulseSupport:plan.fastPulseSupport,
        bodyStationarity:(clock,blocks)=>rawBodySupport(data,clock.bpm,blocks)&&
          verifyPersistentLowClock(data,clock,{initialBeats:8.5,rejectExtraLowAttacks:true}).accepted});
      qualified.localFit=candidate.localFit;candidate=qualified;
      // A proved body clock may lack a second observable MID harmonic at the
      // primary frame rate. Re-observe the same audio at twice the frame rate;
      // this never overrides a body warp, a step, or unexplained opposition.
      if(!candidate.accepted&&candidate.directBodyClock&&candidate.phaseWarp&&!candidate.bodyPhaseWarp&&
        !candidate.smallStepOpposition&&candidate.unexplainedOpposition<1){
        if(secondaryHighData===undefined)secondaryHighData=await extract(data.pcm,data.rate,()=>progress({stage:'高速の拍を細かく再確認',progress:.65}),{hop:Math.max(1,Math.round(data.hop/2))});
        if(secondaryHighData?.bandFlux?.length>=2){
          const finer=verifySteadyClock(secondaryHighData,plan.referenceBpm,local.curve,{smallStepOpposition,
            bodyStationarity:(clock,blocks)=>rawBodySupport(secondaryHighData,clock.bpm,blocks)&&
              verifyPersistentLowClock(secondaryHighData,clock,{initialBeats:8.5,rejectExtraLowAttacks:true}).accepted});
          if(finer.accepted&&finer.directBodyClock&&!finer.bodyPhaseWarp){
            finer.localFit=candidate.localFit;finer.spectralScore=candidate.spectralScore;finer.secondaryFeatureFps=secondaryHighData.fps;candidate=finer;
          }
        }
      }
    }
    // Preserve the existing incoming-only exception and its raw attack veto.
    if(!candidate.accepted&&candidate.phaseCoverage>=.98&&!candidate.phaseWarp&&!candidate.smallStepOpposition&&candidate.longestOpposition>=1&&
      candidate.usableHarmonics?.length>=2&&Math.abs(Math.log2(candidate.bpm/automaticTempo.referenceBpm))<.035){
      const proof=verifyPersistentLowClock(data,{...candidate,accepted:true},{initialBeats:8.5,rejectExtraLowAttacks:true});
      if(proof.accepted){candidate.accepted=true;candidate.persistentInitialRescue=true;}
    }
    candidate.bodyDominant=champion&&candidate.directBodyClock;
    if(candidate.accepted&&(!automaticTempo.directOctaveChange||verifyPersistentLowClock(data,candidate).accepted))verified.push(candidate);
    await tick();
  }
  const strongestSpectrum=Math.max(1e-9,...verified.map(candidate=>candidate.spectralScore));
  for(const candidate of verified)candidate.rank=candidate.localFit+.30*candidate.spectralScore/strongestSpectrum;
  verified.sort((a,b)=>Number(!!b.persistentInitialRescue)-Number(!!a.persistentInitialRescue)||Number(!!b.bodyDominant)-Number(!!a.bodyDominant)||b.rank-a.rank);
  const clock=verified[0]||{accepted:false};
  let constantClock=clock.accepted?clock:null,provisionalBeats=null;
  if(constantClock){
    progress({stage:'拍の間隔から短い変化を再確認',progress:.66});await tick();
    const provisionalTempo=interpretPulse({...automaticTempo,tempoAtFrame:()=>constantClock.bpm,
      evidenceAtFrame:local.evidenceAtFrame,constantClock},options,tempoHint);
    provisionalBeats=await trackBeats(data,provisionalTempo,()=>{});
    // Global phase agreement can hide a short stage at either end. Only
    // tightly fitted observed beat times may overturn that provisional clock.
    if(detectBeatTempoSteps(provisionalBeats,duration,{minEffect:.0015,minSeparation:8}).length){
      constantClock=null;provisionalBeats=null;
    }
  }
  // The regional tempo path cannot rescue this whole-track evidence gate.
  // Local candidates below are read directly from the extracted signal.
  if(!constantClock&&!tempoHint&&(automaticTempo.selectedPeriodicity<.14||automaticTempo.selectedScore<.24)) {
    if (options.tempoScale === undefined || options.tempoScale === 1) {
      const regionalProgress=fraction=>progress({stage:'周期を裏付けられる区間だけを確認',progress:.67+.28*fraction});
      regionalProgress(0);
      const tempoRegions = await findPartialTempoRegions(data, duration, regionalProgress);
      if (tempoRegions.length) {
        return {
          ...empty('曲全体の拍を追跡できませんでした。複数の窓で周期が一致した区間を候補として表示します。'),
          tempoModel:'regional-candidates', tempoRegions, tempoAmbiguous:true,
        };
      }
    }
    return empty('拍の周期性が弱く、信頼できるBPMを特定できませんでした。');
  }
  let localClocks=null,observedShortRamps=[];
  if(!constantClock){
    progress({stage:'区間の周期と主な拍の取り方を照合',progress:.66});await tick();
    // Short regular body-attack sequences can establish a local pulse even
    // when a longer window favors its half-time subdivision interpretation.
    // This does not overturn an independently verified whole-recording clock.
    const directClocks=estimateDirectBodyClocks(data,{gridFit});
    // The prevailing body-pulse interpretation sets a unit, not a fixed rate.
    // Global subdivision lines can survive more sections than the main pulse.
    const reference=median(automaticTempo.chosen.map(c=>c.bpm));
    const localClockProgress=fraction=>progress({stage:'区間ごとの周期を確認',progress:.675+.05*fraction});
    localClockProgress(0);
    localClocks=estimateLocalClockPath(data,{referenceBpm:reference,onWindow:localClockProgress},
      {gridFit,autocorrelate,lagScore});
    const original=local;
    progress({stage:'周期の候補を照合',progress:.73});
    const regional=buildRegionalReference(data,automaticTempo,original,localClocks,reference,{minSupportSamples:3});
    const referenceAt=regional.referenceAtFrame;
    const isAlias=(a,b)=>a>0&&b>0&&Math.abs(Math.log2(a/b))>.12&&
      [.5,2/3,1.5,2,3].some(level=>Math.abs(Math.log2(a/b/level))<.06);
    const aliasedRuns=directClocks.runs.filter(run=>{
      const margin=Math.min(.4,(run.end-run.start)/4);
      const rates=original.curve.filter(point=>point.time>=run.start+margin&&point.time<=run.end-margin).map(point=>point.bpm);
      const clocks=localClocks.curve.filter(point=>point.time>=run.start+margin&&point.time<=run.end-margin).map(point=>point.bpm);
      return isAlias(run.bpm,median(rates))||isAlias(run.bpm,median(clocks));
    });
    const directAliasAt=frame=>{
      const direct=directClocks.evidenceAtFrame(frame),previous=original.evidenceAtFrame(frame);
      if(!direct?.supported||!(previous?.bpm>0))return null;
      // Keep the existing precise path when the observed rate already agrees.
      // Quantized short-window periods are evidence for a missing pulse level,
      // not a replacement for the fine phase estimate everywhere.
      if(direct.runStart!==undefined)return aliasedRuns.some(run=>run.start===direct.runStart&&run.end===direct.runEnd&&Math.abs(Math.log2(run.bpm/direct.bpm))<.03)?direct:null;
      return isAlias(direct.bpm,previous.bpm)||isAlias(direct.bpm,localClocks.evidenceAtFrame(frame).bpm)?direct:null;
    };
    const anchors=frame=>{
      const direct=directAliasAt(frame);
      if(direct?.supported)return direct.bpm;
      const previous=automaticTempo.tempoAtFrame(frame),point=localClocks.evidenceAtFrame(frame);
      if(!point.supported)return previous;
      const ratio=point.bpm/previous,alias=[.5,2/3,1.5,2,3].some(level=>Math.abs(Math.log2(ratio/level))<.08);
      // A short window may favor a different subdivision. A new alias farther
      // from the prevailing pulse needs the sustained original path's support.
      if(alias&&Math.abs(Math.log2(point.bpm/referenceAt(frame)))>Math.abs(Math.log2(previous/referenceAt(frame)))+.06)return previous;
      return point.bpm;
    };
    localClocks.anchorAtFrame=anchors;localClocks.referenceBpm=reference;
    progress({stage:'区間ごとのテンポを絞り込み',progress:.74});
    local=refineLocalTempo(data,anchors,localTempoOptions);
    if(data.bodyAvailable){
      const body=refineLocalTempo({...data,bandFlux:data.bandFlux.slice(0,2)},anchors,localTempoOptions);
      local=reconcileBodyTempo(local,body,automaticTempo.tempoAtFrame);
    }
    for(let i=0;i<local.curve.length;i++){
      if (i % 128 === 0) progress({stage:'区間ごとのテンポを絞り込み',progress:.751+.01*i/local.curve.length});
      const point=local.curve[i],before=original.curve[i],clockPoint=localClocks.evidenceAtFrame(point.frame);
      const distance=Math.abs(Math.log2(point.bpm/before.bpm));
      const alias=[.5,2/3,1.5,2,3].some(level=>Math.abs(Math.log2(point.bpm/before.bpm/level))<.08);
      const closer=Math.abs(Math.log2(point.bpm/referenceAt(point.frame)))+.03<Math.abs(Math.log2(before.bpm/referenceAt(point.frame)));
      const direct=directAliasAt(point.frame);
      const independentlyObserved=direct?.supported&&point.supported&&Math.abs(Math.log2(point.bpm/direct.bpm))<.05;
      // Extra clocks resolve a metrical ambiguity; they do not invalidate an
      // already-supported changing rate merely because a short window is weak.
      const integerAbstention=before.supported&&!independentlyObserved&&regional.integerAmbiguityAtFrame(point.frame);
      const referenceEvidence=regional.evidenceAtFrame(point.frame);
      const preserve=!!integerAbstention||before.supported&&!independentlyObserved&&(
        (alias&&!closer)||
        (distance>.12&&point.coherence<before.coherence&&!(alias&&closer))||
        (!clockPoint.supported&&distance<.06));
      if(preserve)Object.assign(point,before);
      else {
        if(alias&&(closer||independentlyObserved))point.metricalAdjusted=true;
        if(independentlyObserved)point.tempoSource='direct-body-grid';
        if(!clockPoint.supported&&!independentlyObserved&&point.coherence<.18)point.supported=false;
      }
      if(integerAbstention||referenceEvidence.supported&&referenceEvidence.source==='long-verified-regional-clock'){
        point.tempoAmbiguous=true;point.requiresReview=true;
        point.tempoReferenceSource=integerAbstention?'integer-family-abstention':referenceEvidence.source;
        if(integerAbstention)point.tempoReferenceAlternativeBpm=integerAbstention.alternativeBpm;
      }
    }
    // Fit actual body attacks before dynamic tracking, which can otherwise
    // discard a beat while a rapid transition crosses a half-time alias.
    // Stable contexts must agree with the selected pulse; the source schedule
    // and a notated bar length are never supplied to this fit.
    progress({stage:'短い加速と減速を確認',progress:.765});
    const beforeRamps=local;
    const bodyObservations=data.bodyEvents.map(event=>({time:refineOnsetTime(data,event.frame),
      bpm:beforeRamps.tempoAtFrame(event.frame)}));
    observedShortRamps=detectShortTempoRamps(bodyObservations,duration,{referenceAtTime:time=>{
      const point=beforeRamps.evidenceAtFrame(time*data.fps);
      return point.supported?point.bpm:NaN;
    }});
    if(observedShortRamps.length){
      const at=frame=>observedShortRamps.find(ramp=>frame/data.fps>=ramp.start&&frame/data.fps<=ramp.end);
      const rate=(ramp,frame)=>ramp.fromBpm+(ramp.toBpm-ramp.fromBpm)*(frame/data.fps-ramp.start)/(ramp.end-ramp.start);
      local={...beforeRamps,curve:applyShortRampPrecision(beforeRamps.curve,observedShortRamps),
        tempoAtFrame:frame=>{const ramp=at(frame),point=beforeRamps.evidenceAtFrame(frame);return ramp&&point.supported?rate(ramp,frame):beforeRamps.tempoAtFrame(frame);},
        evidenceAtFrame:frame=>{const point=beforeRamps.evidenceAtFrame(frame),ramp=at(frame);return ramp&&point.supported?{...point,bpm:rate(ramp,frame),tempoSource:'beat-phase-ramp'}:point;}};
    }
  }
  if(constantClock){
    // A stable subdivision clock cannot prove which metrical level a performer
    // intends. Retain supported half/double interpretations rather than erasing
    // the evidence for an actual commensurate tempo change.
    const supported=local.curve.filter(p=>p.supported&&p.coherence>=.04);
    for(const ratio of [.5,2]){
      const matches=supported.filter(p=>Math.abs(Math.log2(p.bpm/(clock.bpm*ratio)))<.06);
      if(matches.length>=Math.max(10,supported.length*.1)&&!automaticTempo.alternatives.some(c=>c.ratio===ratio)){
        automaticTempo.alternatives.push({bpm:clock.bpm*ratio,ratio,
          support:matches.length/Math.max(1,supported.length),reason:'倍・半分の拍解釈'});
        automaticTempo.ambiguous=true;
      }
    }
  }
  const tempo=interpretPulse({...automaticTempo,
    tempoAtFrame:constantClock?()=>constantClock.bpm:local.tempoAtFrame,
    evidenceAtFrame:local.evidenceAtFrame,constantClock},options,tempoHint);
  const beats=provisionalBeats||await trackBeats(data,tempo,progress);
  if(beats.length<4)return empty('拍の手掛かりが不足しています。別の区間や、BPM候補の拍解釈を試してください。');
  const shortRamps=constantClock?[]:mergeShortTempoRamps(observedShortRamps.map(ramp=>({...ramp,
    fromBpm:ramp.fromBpm*tempo.scale,toBpm:ramp.toBpm*tempo.scale,
    observedRampBeats:ramp.observedRampBeats*tempo.scale})),
    detectShortTempoRamps(beats,duration,{referenceAtTime:time=>{
      const point=tempo.evidenceAtFrame(time*data.fps);
      return point.supported?tempo.tempoAtFrame(time*data.fps):NaN;
    }}));
  if(shortRamps.length)applyShortRampPrecision(beats,shortRamps).forEach((beat,index)=>{beats[index]=beat;});
  progress({stage:'拍子と切り替わりを推定',progress:.85});await tick();
  const meters=estimateMeters(beats,duration),sections=splitTempoSections(meters.sections,beats);
  const values=beats.map(b=>b.bpm).filter(x=>Number.isFinite(x)&&x>0);
  if(!values.length)return empty('十分な周期の手掛かりを検出できませんでした。');
  const bpm=constantClock?constantClock.bpm*tempo.scale:stableTempo(beats,median(values));
  const sectionRates=sections.map(s=>s.bpm).filter(bpm=>Number.isFinite(bpm)&&bpm>0);
  let bpmMin=Math.min(bpm,quantile(values,.05),...sectionRates);
  let bpmMax=Math.max(bpm,quantile(values,.95),...sectionRates);
  const anchors=beats.filter(beat=>beat.tempoChange).map(beat=>({time:beat.time}));
  let unsupported=false;
  let tempoCurve=constantClock
    ?beats.map(({time,bpm,tempoGap,tempoEvidence,tempoSource})=>({time,bpm,tempoGap,tempoEvidence,tempoSource}))
    :local.curve.map(point=>{
      const supported=point.supported&&Number.isFinite(point.bpm)&&point.bpm>0;
      const entry={time:point.time,bpm:supported?point.bpm*tempo.scale:null,
        tempoEvidence:point.coherence,tempoSource:supported?(point.tempoSource||'onset-grid'):'uncertain',tempoGap:supported&&unsupported,tempoAmbiguous:!!point.tempoAmbiguous||!!point.metricalAdjusted||!!localClocks?.evidenceAtFrame(point.frame).ambiguous,
        ...(point.requiresReview?{requiresReview:true}:{}),...(point.tempoReferenceSource?{tempoReferenceSource:point.tempoReferenceSource}:{}),
        ...(point.tempoReferenceAlternativeBpm>0?{tempoReferenceAlternativeBpm:point.tempoReferenceAlternativeBpm*tempo.scale}:{})};
      unsupported=!supported;return entry;
    });
  const precisionPeriods=constantClock?[]:refineBeatPeriods(beats);
  if(!constantClock)tempoCurve=applyBeatPrecision(tempoCurve,precisionPeriods);
  if(shortRamps.length)tempoCurve=applyShortRampPrecision(tempoCurve,shortRamps);
  let tempoChanges=constantClock?[]:refineChangeRates(data,detectTempoChanges(tempoCurve,duration,{anchors,
    onsets:data.bodyEvents.map(event=>event.frame/data.fps),onsetScale:tempo.scale}),duration,tempo.scale);
  if(!constantClock){
    const preciseCurve=tempoCurve.map(p=>p.tempoSource==='regular-beat-regression'?p:{...p,bpm:null});
    const precisionChanges=[...detectSmallTempoSteps(preciseCurve,duration,{minEffect:.0015}),...detectSmallTempoSteps(preciseCurve,duration,{minEffect:.0015,contextSeconds:3,minCount:12,minSpan:2.5}),...detectTempoChanges(preciseCurve,duration,{minTrendChange:.003}).filter(c=>c.type!=='step')];
    for(const candidate of precisionChanges)if(!tempoChanges.some(c=>c.end>=candidate.start-2&&c.start<=candidate.end+2))tempoChanges.push({...candidate,source: candidate.type==='step'?'verified-beat-timing-step':'verified-beat-timing-trend'});
    tempoChanges.sort((a,b)=>a.start-b.start);
  }
  if(!constantClock)tempoChanges=mergeBeatTempoSteps(tempoChanges,detectBeatTempoSteps(beats,duration,{maxEffect:2}),{tempoCurve,duration});
  if(shortRamps.length)tempoChanges=mergeShortTempoRamps(tempoChanges,shortRamps,{tempoCurve});
  tempoChanges=annotateTempoChangeEvidence(tempoChanges,tempoCurve);
  const tempoRegions=clockRegions(localClocks,tempoChanges,duration,tempo.scale,localClocks?.referenceBpm||bpm/tempo.scale,tempoCurve);
  const changeRates=tempoChanges.flatMap(change=>[change.fromBpm,change.toBpm]);
  if(changeRates.length){bpmMin=Math.min(bpmMin,...changeRates);bpmMax=Math.max(bpmMax,...changeRates);}
  const top=tempo.selectedScore||0,coverage=(beats[beats.length-1].time-beats[0].time)/duration;
  const confidence=clamp(top*.55+tempo.selectedPeriodicity*.20+Math.min(1,beats.length/25)*.12+coverage*.13-(tempo.ambiguous?.13:0),.05,.94);
  const notes=[
    '拍子はアクセントの繰り返しから推定した候補です。音源だけでは3/4と6/8、2/4と4/4などを一意に決められない場合があります。',
    'BPMは検出した拍間隔の回数/分です。八分音符・付点四分音符など、譜面上の拍単位により表記が変わります。',
    '1小節だけの短い変化は、前後の強いアクセント周期が揃う場合に限って低い確信度の候補として表示します。弱いアクセントや複雑なリズムでは見逃すことがあります。',
    'シンコペーション、弱い打音、ポリリズム、自由拍では誤検出があります。拍クリックと試聴で確認し、必要に応じて修正してください。'
  ];
  if(tempoRegions.length)notes.unshift('一部の区間は拍の連続性が不明瞭なため、独立したBPM候補として表示しています。時刻の幅と別の拍解釈も確認してください。');
  if(constantClock)notes.unshift('周期が明瞭な区間に同じテンポが合うため、一定テンポとして推定しています。');
  if(beats.some(b=>b.bpm===null))notes.unshift('周期の手掛かりが弱い箇所ではBPMの表示を保留し、グラフを途切れで表示しています。');
  if(confidence<.5)notes.unshift('拍の確信度が低めです。BPM候補とクリックの位置を確認してください。');
  if(tempo.ambiguous)notes.unshift('倍・半分や細分音符に近い別の拍解釈にも根拠があります。BPM候補をクリック音で聴き比べてください。');
  if(tempoHint)notes.unshift(`選択した${tempoHint} BPM付近の拍解釈を優先して再解析しました。局所的なテンポ変化は引き続き追跡しています。`);
  if((bpmMax-bpmMin)/bpm>.045)notes.unshift('一定BPMに固定せず、音の繰り返しと拍の位置を照合してテンポの変化を追跡しています。');
  progress({stage:'解析完了',progress:1});
  return {bpm,bpmMin,bpmMax,confidence,beats:beats.map(({frame,...b})=>b),sections,tempoCurve,tempoChanges,tempoRegions,candidates:tempo.candidates,duration,notes,
    beatTimingVerification:{regularPoints:precisionPeriods.length,method:'seven-beat linear fit; fit residual is not absolute timing error'},
    tempoModel:constantClock?'constant-clock':'local-grid',
    constantTempo:constantClock?{bpm,phaseCoverage:clock.phaseCoverage,usableHarmonics:clock.usableHarmonics}:null,
    meterConfidence:meters.meterConfidence,tempoAmbiguous:tempo.ambiguous,
    tempoAlternatives:tempo.alternatives.map(c=>({...c,bpm:bpm*c.ratio})).filter(c=>c.bpm>=10&&c.bpm<=1200),
    pulseInterpretation:tempoHint||tempo.scale!==1?'user-hint':'automatic-multiscale',tempoHint,
    tempoScale:tempo.scale,automaticBpm:bpm/tempo.scale,pulseUnit:'検出拍',
    method:'verified global harmonic clock / multiband spectral flux / metrical-level continuity / short-window harmonic modulation grid / phase reassignment / dynamic beat tracking / accent periodicity'};
}
