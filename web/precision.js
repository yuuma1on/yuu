// Measurement is conditional on the user's chosen beat identity and timestamps.
// Extra decimal places and a small fit residual are NOT an accuracy guarantee.
export function parseAnchors(text, duration=Infinity) {
  const rows=String(text).trim().split(/\r?\n/).filter(line=>line.trim()).map(line=>{
    const fields=line.trim().split(/[,\s]+/);
    if(fields.length!==2||fields.some(value=>value.trim()===''))throw new Error('各行を「拍番号, 秒」の2つの数値で入力してください。');
    const [beat,time]=fields.map(Number);
    if(!Number.isFinite(beat)||!Number.isFinite(time)||beat<0||time<0||time>duration)throw new Error('拍番号と時刻は有限の非負の数値、時刻は音源内で指定してください。');
    return {beat,time};
  });
  if(rows.length<2)throw new Error('異なる2拍以上の位置を入力してください。');
  for(let i=1;i<rows.length;i++)if(rows[i].beat<=rows[i-1].beat||rows[i].time<=rows[i-1].time)throw new Error('拍番号と時刻は、重複のない昇順で入力してください。');
  return rows;
}
export function measureAnchors(anchors) {
  // Revalidate callers as well as text input. Normalize before fitting to avoid
  // cancellation when indexes and timestamps have large absolute offsets.
  const a=parseAnchors(anchors.map(p=>`${p.beat},${p.time}`).join('\n'));
  const origin=a[0], x=a.map(p=>p.beat-origin.beat), y=a.map(p=>p.time-origin.time);
  const mean=v=>v.reduce((s,n)=>s+n,0)/v.length, mx=mean(x),my=mean(y);
  let xx=0,xy=0;for(let i=0;i<a.length;i++){xx+=(x[i]-mx)**2;xy+=(x[i]-mx)*(y[i]-my);}
  const period=xy/xx, offset=my-period*mx;
  if(!(period>0)||!Number.isFinite(period))throw new Error('正の拍間隔を測定できませんでした。');
  const residuals=y.map((v,i)=>v-offset-period*x[i]);
  const bpm=60/period;
  if(!Number.isFinite(bpm)||bpm<=0)throw new Error('測定範囲を確認してください。');
  return {bpm,period,firstBeatTime:origin.time+offset,start:origin.time,end:a.at(-1).time,
    anchorCount:a.length,beatIntervals:a.at(-1).beat-origin.beat,
    residualRmsMs:Math.sqrt(mean(residuals.map(r=>r*r)))*1000,
    residualMaxMs:Math.max(...residuals.map(Math.abs))*1000,
    residuals:residuals.map(r=>r*1000),anchors:a,
    source:'user-entered-beat-anchors',accuracy:'conditional on anchor times and beat interpretation; residual is not ground-truth error'};
}
export const preciseInput=value=>Number.isFinite(value)?String(value):'';
