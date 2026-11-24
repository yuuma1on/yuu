// A fixed, known clock with changing instrumentation for an audible check.
export function createSteadyDemo(sampleRate=22050){
  const bpm=120,period=60/bpm,first=.15,count=64;
  const samples=new Float32Array(Math.ceil((first+count*period+.5)*sampleRate));
  function hit(time,amplitude,frequency,decay,length){
    const at=Math.round(time*sampleRate);
    for(let j=0;j<length*sampleRate&&at+j<samples.length;j++){
      samples[at+j]+=amplitude*Math.exp(-j/(sampleRate*decay))*
        (Math.sin(2*Math.PI*frequency*j/sampleRate)+.15*Math.sin(2*Math.PI*2400*j/sampleRate));
    }
  }
  for(let i=0;i<count;i++){
    const time=first+i*period;
    // The main drums pause while the hats keep the same sixteenth-note clock.
    if(i<24||i>=40)hit(time,i%4===0?.85:.30,i%2===0?180:700,.014,.075);
    if(i>=16&&i<48)for(let q=0;q<4;q++)hit(time+q*period/4,.065,2800,.004,.025);
  }
  return {samples,sampleRate,bpm};
}

// The silent interval carries no acoustic evidence of an exact change time.
export function createGapDemo(sampleRate=22050){
  const samples=new Float32Array(Math.ceil(24.5*sampleRate));
  const pulse=time=>{const at=Math.round(time*sampleRate);for(let j=0;j<.08*sampleRate&&at+j<samples.length;j++)samples[at+j]+=.65*Math.exp(-j/(sampleRate*.012))*(Math.sin(2*Math.PI*180*j/sampleRate)+.2*Math.sin(2*Math.PI*1700*j/sampleRate));};
  for(let time=.15;time<8;time+=.5)pulse(time);
  for(let time=12.15;time<24;time+=.4)pulse(time);
  return {samples,sampleRate,beforeBpm:120,afterBpm:150,silentInterval:[8,12]};
}

// Known source beats generate the audio; stage metadata is for the demo label
// and validation only. The analyzer receives the PCM through the normal file flow.
export function createVariableDemo(sampleRate=22050){
  return createVariableAudio([[170.5,32],[172,14],[170.5,24],[176,12],[168.5,28]],sampleRate);
}

export function createRapidVariableDemo(sampleRate=22050){
  return createVariableAudio([[120,16],[180,6],[150,5],[240,8],[120,16]],sampleRate);
}

export function createOneBarAccelerationDemo(sampleRate=22050){
  const first=.15,fromBpm=200,toBpm=300,beforeCount=24,afterCount=24,beats=4;
  const rampStart=first+beforeCount*60/fromBpm;
  const rampDuration=beats*120/(fromBpm+toBpm),rampEnd=rampStart+rampDuration;
  const slope=(toBpm-fromBpm)/rampDuration,end=rampEnd+afterCount*60/toBpm;
  const attacks=[];let index=0;
  const attack=time=>{attacks.push({time,accent:index%4===0,frequency:index%2===0?110:190});index++;};
  for(let beat=0;beat<beforeCount;beat++)attack(first+beat*60/fromBpm);
  // Integrate a BPM-linear-in-time clock, then invert its phase at each beat.
  // Four beats define this demo's bar; they are not inferred meter metadata.
  for(let beat=0;beat<beats;beat++){
    const time=120*beat/(fromBpm+Math.sqrt(fromBpm*fromBpm+120*slope*beat));
    attack(rampStart+time);
  }
  for(let beat=0;beat<afterCount;beat++)attack(rampEnd+beat*60/toBpm);
  const samples=renderVariableAttacks(attacks,end,sampleRate);
  return {samples,sampleRate,duration:samples.length/sampleRate,
    ramp:{start:rampStart,end:rampEnd,fromBpm,toBpm,beats,meterAssumption:'4/4'},
    stages:[{start:first,end:rampStart,bpm:fromBpm,type:'constant'},
      {start:rampStart,end:rampEnd,fromBpm,toBpm,type:'accelerando'},
      {start:rampEnd,end,bpm:toBpm,type:'constant'}]};
}

function createVariableAudio(schedule,sampleRate){
  const stages=[],attacks=[];let time=.15,index=0;
  for(const [bpm,count]of schedule){
    const start=time,period=60/bpm;
    for(let beat=0;beat<count;beat++,index++){
      attacks.push({time,accent:index%4===0,frequency:index%2===0?110:190});
      time+=period;
    }
    stages.push({start,end:time,bpm});
  }
  const samples=renderVariableAttacks(attacks,time,sampleRate);
  return {samples,sampleRate,stages,duration:samples.length/sampleRate};
}

function renderVariableAttacks(attacks,end,sampleRate){
  const samples=new Float32Array(Math.ceil((end+.5)*sampleRate));
  for(const attack of attacks){
    const at=Math.round(attack.time*sampleRate),amplitude=attack.accent?.85:.36;
    for(let j=0;j<.075*sampleRate&&at+j<samples.length;j++){
      samples[at+j]+=amplitude*Math.exp(-j/(sampleRate*.014))*
        (Math.sin(2*Math.PI*attack.frequency*j/sampleRate)+.15*Math.sin(2*Math.PI*1700*j/sampleRate));
    }
  }
  return samples;
}
