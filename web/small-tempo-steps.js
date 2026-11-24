// Conservative long-plateau contrast for small changes that cannot cross the
// short-window derivative threshold. This does not resolve short sub-1% steps.
const median=a=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.floor(s.length/2)]:NaN;};
function fit(points){
  const origin=points[0].time,x=points.map(p=>p.time-origin),y=points.map(p=>Math.log(p.bpm));
  const mean=a=>a.reduce((s,v)=>s+v,0)/a.length,mx=mean(x),my=mean(y);let xx=0,xy=0;
  for(let i=0;i<x.length;i++){xx+=(x[i]-mx)**2;xy+=(x[i]-mx)*(y[i]-my);}
  const slope=xy/Math.max(1e-12,xx),errors=y.map((v,i)=>v-my-slope*(x[i]-mx));
  return {slope,center:median(y),scatter:median(errors.map(Math.abs)),sse:errors.reduce((s,v)=>s+v*v,0)};
}
export function detectSmallTempoSteps(points,duration,options={}){
  const valid=points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.bpm)&&p.bpm>0&&p.supported!==false&&
    (!Number.isFinite(p.coherence??p.tempoEvidence)||(p.coherence??p.tempoEvidence)>=.06)&&!p.imputed).sort((a,b)=>a.time-b.time);
  if(valid.length<50)return [];
  const lowerBound=time=>{let lo=0,hi=valid.length;while(lo<hi){const mid=(lo+hi)>>1;if(valid[mid].time<time)lo=mid+1;else hi=mid;}return lo;};
  const range=(a,b)=>valid.slice(lowerBound(a),lowerBound(b+1e-9));
  const context=options.contextSeconds??7,minCount=options.minCount??20,minSpan=options.minSpan??6;
  const candidates=[];
  for(let center=context+1;center<=duration-context-1;center+=.32){
    const left=range(center-context-1,center-1),right=range(center+1,center+context+1);
    if(left.length<minCount||right.length<minCount||left.at(-1).time-left[0].time<minSpan||right.at(-1).time-right[0].time<minSpan)continue;
    if([left,right].some(a=>a.some((p,i)=>i&&p.time-a[i-1].time>.5)))continue;
    const a=fit(left),b=fit(right),delta=b.center-a.center,effect=Math.abs(delta);
    // Restrict this complementary detector to subtle, strongly separated,
    // stable plateaus. Larger changes stay on the existing trend detector.
    if(effect<(options.minEffect??.004)||effect>.04||effect<6*Math.max(.0001,a.scatter,b.scatter))continue;
    if(Math.abs(a.slope)*context>effect*.2||Math.abs(b.slope)*context>effect*.2)continue;
    const middle=range(center-1+1e-8,center+1-1e-8),whole=[...left,...middle,...right];
    if(whole.some((p,i)=>i&&p.time-whole[i-1].time>.5))continue;
    const linear=fit(whole);
    const twoSse=whole.reduce((s,p)=>{const expected=p.time<center?a.center:b.center;return s+(Math.log(p.bpm)-expected)**2;},0);
    if(twoSse>linear.sse*.55)continue; // Reject smooth drift and broad ramps.
    candidates.push({center,score:twoSse/whole.length,fromBpm:Math.exp(a.center),toBpm:Math.exp(b.center),effect});
  }
  const groups=[];
  for(const c of candidates){let group=groups.at(-1);if(!group||c.center-group.at(-1).center>1.3||Math.sign(Math.log(c.toBpm/c.fromBpm))!==Math.sign(Math.log(group[0].toBpm/group[0].fromBpm))){group=[];groups.push(group);}group.push(c);}
  return groups.map(group=>{
    const best=group.reduce((a,b)=>a.score<b.score?a:b);
    return {start:Math.max(0,best.center-1),end:Math.min(duration,best.center+1),fromBpm:best.fromBpm,toBpm:best.toBpm,
      type:'step',confidence:.65,timeUncertainty:1,source:'sustained-small-step',requiresReview:true};
  });
}
