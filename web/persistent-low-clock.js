const quantile=(values,q)=>{const a=Array.from(values).filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.floor((a.length-1)*q)]:0;};

// This only rejects a constancy exception. Unexplained strong low attacks
// do not prove a different BPM, but they prevent claiming that the original
// low pulse alone explains the recording. Use observed peaks, not a list of
// predicted subdivisions of the original beat.
function unexplainedLowAttacks(low,fps,period,phase,baseline,radius){
  const peaks=[],mergeFrames=Math.max(1,Math.ceil(.03*fps));
  for(let frame=1;frame<low.length-1;frame++){
    const strength=low[frame];
    if(!(Number.isFinite(strength)&&strength>=baseline*.5&&strength>=low[frame-1]&&strength>low[frame+1]))continue;
    const previous=peaks.at(-1),point={frame,strength};
    if(previous&&frame-previous.frame<mergeFrames){if(strength>previous.strength)peaks[peaks.length-1]=point;}
    else peaks.push(point);
  }
  const extra=[];
  for(const peak of peaks){
    const time=peak.frame/fps,nearest=phase+Math.round((time-phase)/period)*period;
    if(Math.abs(time-nearest)<=radius)continue;
    extra.push({time,relativeStrength:peak.strength/baseline});
    if(extra.length>=2)return extra;
  }
  return [];
}

/** Sufficient evidence that an incoming low-band pulse persists while another
 * instrument changes attack density. The caller must restrict this exception
 * to the initial pulse level; this is not a general metrical-level selector.
 * Existing steady-clock phase-warp, drift, and small-step vetoes still apply.
 */
export function verifyPersistentLowClock(data,candidate,options={}){
  const bpm=candidate?.bpm,fps=data.fps,n=data.count,bands=data.bandFlux||data.flux;
  const fundamental=candidate?.clocks?.find(clock=>clock.band===0&&clock.harmonic===1);
  if(!candidate?.accepted||!(bpm>0)||!bands?.length||!(fps>0)||!(n>0)||
    !fundamental||fundamental.resultant<.98||fundamental.coverage<.95||fundamental.positiveCoverage<.95){
    return {accepted:false,reason:'unverified-stationary-low-fundamental'};
  }
  const low=bands[0],duration=n/fps,period=60/bpm,windowSeconds=options.windowSeconds??4;
  if(duration<16)return {accepted:false,reason:'insufficient-span'};
  // One phasor aligns the expected low-band attack slots. Its trajectory has
  // already passed the independent steady-clock verifier above.
  const angle=-2*Math.PI*bpm/60/fps,ca=Math.cos(angle),sa=Math.sin(angle);let c=1,s=0,re=0,im=0;
  for(let i=0;i<n;i++){
    const weight=.5-.5*Math.cos(2*Math.PI*i/Math.max(1,n-1)),value=Math.max(0,low[i])*weight;
    re+=value*c;im+=value*s;const next=c*ca-s*sa;s=s*ca+c*sa;c=next;
  }
  const phase=(((-Math.atan2(im,re)/(2*Math.PI)*period)%period)+period)%period;
  const radius=Math.max(1/fps,Math.min(.045,period*.12));
  const peak=time=>{
    const a=Math.max(0,Math.ceil((time-radius)*fps)),b=Math.min(n-1,Math.floor((time+radius)*fps));let value=0;
    for(let i=a;i<=b;i++)value=Math.max(value,low[i]);return value;
  };
  const slots=[];
  for(let time=phase;time<duration;time+=period)slots.push({time,on:peak(time),off:peak(time+period/2)});
  const normalized=bands.map(band=>{const positive=Array.from(band).filter(value=>value>0),scale=quantile(positive,.9)||1;return Float64Array.from(band,value=>Math.min(5,Math.max(0,value)/scale));});
  const windows=[];
  for(let center=windowSeconds/2;center<=duration-windowSeconds/2;center+=1){
    const start=center-windowSeconds/2,end=center+windowSeconds/2,a=Math.max(0,Math.round(start*fps)),b=Math.min(n,Math.round(end*fps));let energy=0;
    for(const band of normalized)for(let i=a;i<b;i++)energy+=band[i];
    windows.push({start,end,energy:energy/Math.max(1,(b-a)*normalized.length)});
  }
  const energyFloor=Math.max(.001,quantile(windows.map(window=>window.energy),.5)*.15);
  const active=windows.filter(window=>window.energy>energyFloor);
  if(active.length<12)return {accepted:false,reason:'insufficient-active-span'};
  const initialStart=active[0].start,initialEnd=Math.min(duration,initialStart+Math.max(options.initialSeconds??8,period*(options.initialBeats??0)));
  const initial=slots.filter(slot=>slot.time>=initialStart&&slot.time<=initialEnd);
  const baseline=quantile(initial.map(slot=>slot.on),.5);
  if(!(baseline>1e-9)||initial.length<8)return {accepted:false,reason:'no-initial-low-pulse'};
  const diagnostics=active.map(window=>{
    const inside=slots.filter(slot=>slot.time>=window.start&&slot.time<window.end);
    const on=quantile(inside.map(slot=>slot.on),.5),off=quantile(inside.map(slot=>slot.off),.5);
    return {start:window.start,end:window.end,slots:inside.length,
      occupancy:inside.filter(slot=>slot.on>=baseline*.5).length/Math.max(1,inside.length),
      retainedStrength:on/baseline,offSlotRatio:off/Math.max(1e-12,on)};
  });
  const occupancy=quantile(diagnostics.map(window=>window.occupancy),.1);
  const retainedStrength=quantile(diagnostics.map(window=>window.retainedStrength),.1);
  const offSlotRatio=quantile(diagnostics.map(window=>window.offSlotRatio),.9);
  // Missing alternate slots reject a true halving. Comparable interleaved low
  // attacks reject a new doubled body pulse. A vanished low instrument cannot
  // prove continuity merely through weak leakage from a replacement timbre.
  const extraLowAttacks=options.rejectExtraLowAttacks?unexplainedLowAttacks(low,fps,period,phase,baseline,radius):[];
  const accepted=occupancy>=.85&&retainedStrength>=.5&&offSlotRatio<=.5&&extraLowAttacks.length<2;
  return {accepted,bpm,phase,occupancy,retainedStrength,offSlotRatio,activeWindows:active.length,
    reason:accepted?'persistent-dominant-low-pulse':extraLowAttacks.length>=2?'unexplained-strong-low-attacks':'low-pulse-not-persistent-or-not-dominant',
    ...(options.rejectExtraLowAttacks?{extraLowAttacks}:{}),
    windows:diagnostics,method:'verified low fundamental / original-slot occupancy / low off-slot dominance'};
}
