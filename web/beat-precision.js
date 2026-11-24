// Independent beat-time check. Only regular, already-supported pulse sequences
// are eligible; a low residual does not establish the musical beat unit.
export function refineBeatPeriods(beats){
  const points=[];
  for(let i=3;i<beats.length-3;i++){
    const window=beats.slice(i-3,i+4),center=beats[i],reference=center.bpm;
    if(!(reference>0)||window.some(p=>!(p.bpm>0)||p.tempoGap))continue;
    const period=60/reference;
    if(window.some((p,j)=>j&&(p.time-window[j-1].time<period*.85||p.time-window[j-1].time>period*1.15)))continue;
    const origin=window[0].time,mean=window.reduce((s,p)=>s+p.time-origin,0)/7;
    let slope=0;for(let j=0;j<7;j++)slope+=(j-3)*(window[j].time-origin-mean);slope/=28;
    const residuals=window.map((p,j)=>p.time-origin-mean-slope*(j-3)),rms=Math.sqrt(residuals.reduce((s,r)=>s+r*r,0)/7);
    const bpm=60/slope;
    if(!Number.isFinite(bpm)||Math.abs(Math.log2(bpm/reference))>.06||rms>Math.max(.0015,period*.007))continue;
    points.push({time:center.time,bpm,tempoEvidence:.25,fitResidualMs:rms*1000,source:'regular-beat-regression'});
  }
  return points;
}

export function applyBeatPrecision(curve,periods){
  let index=0;
  return curve.map(point=>{
    if(!(point.bpm>0)||point.tempoGap)return point;
    while(index+1<periods.length&&periods[index+1].time<point.time)index++;
    const a=periods[index],b=periods[index+1];
    if(!a||!b||point.time<a.time||point.time>b.time||b.time-a.time>Math.min(1.2,90/point.bpm))return point;
    const f=(point.time-a.time)/(b.time-a.time),bpm=a.bpm+(b.bpm-a.bpm)*f;
    if(Math.abs(Math.log2(bpm/point.bpm))>.06)return point;
    return {...point,bpm,tempoSource:'regular-beat-regression',beatFitResidualMs:Math.max(a.fitResidualMs,b.fitResidualMs)};
  });
}
