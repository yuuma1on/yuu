import { discoverClocks } from './steady-clock.js?v=25';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const median=a=>{const s=a.filter(Number.isFinite).sort((x,y)=>x-y);return s[Math.floor(s.length/2)]||0;};
function spectralEvidence(data,bpm){
  const fps=data.fps,n=data.count,flux=data.bandFlux||data.flux,harmonics=[[1,.15],[2,.3],[3,.2],[4,.3],[6,.2]];
  const bands=flux||[data.novelty],perBand=[],window=data.clockWindow||Float64Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(n-1)));
  for(const v of bands){
    let energy=0;for(let i=0;i<n;i++)energy+=Math.max(0,v[i])*window[i];
    let score=0;
    for(const[h,w]of harmonics){const f=bpm*h/60;if(f>=fps*.47)continue;const angle=-2*Math.PI*f/fps,ca=Math.cos(angle),sa=Math.sin(angle);let c=1,s=0,re=0,im=0;
      for(let i=0;i<n;i++){const value=Math.max(0,v[i])*window[i];re+=value*c;im+=value*s;const q=c*ca-s*sa;s=s*ca+c*sa;c=q;}
      score+=w*Math.hypot(re,im)/Math.max(1e-9,energy);
    }perBand.push(score);
  }
  return {coherence:perBand.reduce((a,b)=>a+b,0)/perBand.length,perBand};
}

/** Follow independently supported local clocks while preserving the incoming
 * metrical interpretation. Signal helpers are injected to avoid a circular
 * dependency on the main analysis module. Unsupported windows retain null BPM.
 */
export function estimateLocalClockPath(data,options={},signalHelpers=options.helpers){
  const {gridFit,autocorrelate,lagScore}=signalHelpers||{};
  if(![gridFit,autocorrelate,lagScore].every(fn=>typeof fn==='function'))throw new TypeError('Local clock signal helpers are required.');
  const fps=data.fps,n=data.count,duration=n/fps,stride=options.strideSeconds??.5,window=options.windowSeconds??4;
  const minBpm=options.minBpm??35,maxBpm=options.maxBpm??1200,reference=options.referenceBpm||options.dominantBpm;
  const referenceAt=options.referenceAtFrame||(()=>reference),anchorWeight=options.referenceWeight??.20;
  const centers=[];for(let time=0;time<duration;time+=stride)centers.push(time);
  const windows=[];
  for(const time of centers){
    const a=Math.max(0,Math.round((time-window/2)*fps)),b=Math.min(n,Math.round((time+window/2)*fps));
    const local={fps,count:b-a,clockWindow:Float64Array.from({length:b-a},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(b-a-1))),bandFlux:(data.bandFlux||data.flux)?.map(v=>v.slice(a,b)),novelty:data.novelty?.slice(a,b)};
    const found=discoverClocks(local,[],{minBpm,maxBpm,limit:16}),proposals=[];
    for(const c of found)for(const ratio of [1,.5,2/3,1.5,2]){const bpm=c.bpm*ratio;if(bpm>=minBpm&&bpm<=maxBpm&&proposals.every(v=>Math.abs(Math.log2(v/bpm))>.008))proposals.push(bpm);}
    const ref=referenceAt(time*fps);
    if(ref>0&&proposals.every(v=>Math.abs(Math.log2(v/ref))>.008))proposals.push(ref);
    const bodyEvents=data.bodyEvents.filter(e=>e.frame>=a&&e.frame<b),fullEvents=data.fullEvents.filter(e=>e.frame>=a&&e.frame<b);
    const maxLag=Math.min(Math.ceil(fps*60/minBpm*3.1),Math.floor((b-a)*.72));
    const ac=autocorrelate(data.tempoEnvelope,a,b,maxLag),bodyAc=autocorrelate(data.bodyEnvelope,a,b,maxLag);
    const candidates=[];
    for(const bpm of proposals){
      const lag=fps*60/bpm,periodicity=.58*lagScore(bodyAc,lag)+.2*lagScore(ac,lag)+.14*lagScore(bodyAc,lag*2)+.08*lagScore(ac,lag*3);
      const width=.5+.6*clamp((periodicity-.25)/.2,0,1),body=gridFit(bodyEvents,a,b,lag,width),full=gridFit(fullEvents,a,b,lag,width);
      const quality=.45*body.score+.30*body.occupancy+.10*full.score+.15*periodicity;
      const spectrum=spectralEvidence(local,bpm);
      const supported=(spectrum.coherence>=.035&&periodicity>=.14&&body.score>.2)||
        (spectrum.coherence>=.10&&body.occupancy>.35&&body.capture>.25)||
        (spectrum.coherence>=.05&&body.score>.35&&body.occupancy>.6&&body.capture>.30&&spectrum.perBand.filter(v=>v>.035).length>=2);
      candidates.push({bpm,quality,periodicity,body,spectralScore:spectrum.coherence,coherence:spectrum.coherence,perBand:spectrum.perBand,supported});
    }
    const bestSpectrum=Math.max(1e-9,...candidates.map(c=>c.spectralScore));
    for(const c of candidates){c.score=c.quality+.30*c.spectralScore/bestSpectrum-(ref>0?anchorWeight*Math.abs(Math.log2(c.bpm/ref)):0);if(!c.supported)c.score=-.2;}
    candidates.sort((a,b)=>b.score-a.score);
    const retained=[];for(const c of candidates){if(retained.every(v=>Math.abs(Math.log2(v.bpm/c.bpm))>.015))retained.push(c);if(retained.length>=20)break;}
    retained.push({bpm:null,score:.10,supported:false,coherence:0,reason:'insufficient-independent-clock-evidence'});
    windows.push(retained);
  }
  const back=windows.map(w=>new Uint16Array(w.length));let previous=Float64Array.from(windows[0],c=>c.score);
  const continuity=options.continuityWeight??.65;
  for(let w=1;w<windows.length;w++){
    const next=new Float64Array(windows[w].length);
    for(let k=0;k<next.length;k++){let best=-Infinity,index=0;for(let j=0;j<previous.length;j++){
      const x=windows[w][k].bpm,y=windows[w-1][j].bpm,cost=x&&y?continuity*Math.abs(Math.log2(x/y)):.04;
      const score=previous[j]-cost;if(score>best){best=score;index=j;}}
      next[k]=best+windows[w][k].score;back[w][k]=index;
    }previous=next;
  }
  let k=0;for(let j=1;j<previous.length;j++)if(previous[j]>previous[k])k=j;
  const selected=[];for(let w=windows.length-1;w>=0;w--){selected[w]=windows[w][k];k=back[w][k];}
  const curve=selected.map((best,i)=>{
    const alternatives=windows[i].filter(c=>c.bpm&&best.bpm&&Math.abs(Math.log2(c.bpm/best.bpm))>.06).slice(0,3);
    const runnerUp=alternatives[0]||null,gap=runnerUp?best.score-runnerUp.score:Infinity;
    return {time:centers[i],frame:centers[i]*fps,bpm:best.supported?best.bpm:null,supported:best.supported,coherence:best.coherence,quality:best.quality||0,bodyCapture:best.body?.capture||0,bodyOccupancy:best.body?.occupancy||0,periodicity:best.periodicity||0,runnerUp:runnerUp?{bpm:runnerUp.bpm,score:runnerUp.score,coherence:runnerUp.coherence}:null,alternatives:alternatives.map(c=>({bpm:c.bpm,score:c.score,coherence:c.coherence})),ambiguous:best.supported&&gap<.06,rankGap:Number.isFinite(gap)?gap:null};
  });
  // Isolated low-evidence windows cannot establish a new clock. Keep the
  // unknown state through short accidental alignments in a fading/noisy tail.
  for(let i=0;i<curve.length;){if(!curve[i].supported){i++;continue;}const start=i,rate=curve[i].bpm;
    while(i<curve.length&&curve[i].supported&&Math.abs(Math.log2(curve[i].bpm/rate))<.10)i++;
    if(curve[i-1].time-curve[start].time+stride<Math.max(.8,120/rate))
      for(let k=start;k<i;k++)if(curve[k].coherence<.15){curve[k].bpm=null;curve[k].supported=false;}
  }
  const evidenceAtFrame=frame=>curve[clamp(Math.round(frame/fps/stride),0,curve.length-1)];
  const tempoAtFrame=frame=>{const p=evidenceAtFrame(frame);return p.bpm||referenceAt(frame)||median(selected.map(s=>s.bpm));};
  return {curve,evidenceAtFrame,tempoAtFrame,method:'local multi-band harmonic clocks / balanced body occupancy / metrical continuity'};
}
