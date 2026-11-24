import { deriveConstantExportBlockers } from './export-blockers.js?v=23';
import { getTjaExportAction, requestTjaDownload } from './tja-export-status.js?v=24';
import { mountTjaReplacement } from './tja-replace-ui.js?v=24';
import { tjaFileName } from './tja-save.js?v=24';
import { buildTimingDraft } from './tja-export.js?v=20';
import { deriveUnresolvedTempoIntervals } from './unresolved-gaps.js?v=20';
import { getTempoDisplaySummary } from './tempo-display.js?v=20';
import { listTjaCharts, parseTjaReference, compareTjaReference, generateTjaReferenceBeats } from './tja-reference.js?v=33';
import { parseAnchors, measureAnchors, preciseInput } from './precision.js?v=20';
import { createSteadyDemo, createGapDemo, createVariableDemo, createRapidVariableDemo, createOneBarAccelerationDemo } from './demo.js?v=28';
import { detectTempoChanges, annotateTempoChangeEvidence } from './tempo-changes.js?v=29';
import { mergeBeatTempoSteps } from './beat-tempo-steps.js?v=32';
import { getTempoReanalysis } from './tempo-reanalysis.js?v=27';
import { mergeShortTempoRamps } from './short-tempo-ramps.js?v=29';
const $ = id => document.getElementById(id);
const audio = new Audio();
let tjaPreflightCache=null,lastExportBlockerReport=null;
let correctionHistory=[], currentMeasurement=null, unresolvedTempoIntervals=[];
let reference=null, referenceText='', referenceComparison=null, referenceReadRevision=0, referenceBeats=[];
audio.preload = 'metadata';
const state = {file:null,url:null,result:null,peaks:[],duration:0,worker:null,busy:false,revision:0,selected:0,selectedChange:-1,selectedRegion:-1,loop:false,click:false,ctx:null,lastBeat:-1,scheduledUntil:-1,clickNodes:new Set(),toastTimer:null,analysisSamples:null,analysisRate:8000,activeHint:null};
const tjaReplacement = mountTjaReplacement({getContext:()=>({result:state.result,audioName:state.file?.name,title:state.file?.name.replace(/\.[^.]+$/,'')||'PULSE timing draft',confirmedMeter:$('tjaConfirmedMeter').value||null,revision:state.revision})});
const fmt = (seconds,precision=1) => {
  const scale=10**precision, s=Math.round(Math.max(0,seconds||0)*scale)/scale;
  return `${Math.floor(s/60)}:${(s%60).toFixed(precision).padStart(3+precision,'0')}`;
};
const num = value => Number.isFinite(value) ? value.toFixed(1) : '—';
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const median = values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]:null;};
function toast(message){$('toast').hidden=false;$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>{$('toast').classList.remove('visible');$('toast').hidden=true;},4200);}
function progress(value,text){$('progressPanel').hidden=false;$('progressText').textContent=text;$('progressBar').style.width=`${clamp(value,0,1)*100}%`;$('progressBar').setAttribute('aria-valuenow',Math.round(value*100));}
function controls(){ tjaReplacement.setBusy(state.busy); $('tjaConfirmedMeter').disabled=state.busy; $('previewTjaBtn').disabled=state.busy||!state.result;updateTjaExportAction(); $('gapDemoBtn').disabled=state.busy; $('variableDemoBtn').disabled=state.busy; $('variableDemoKind').disabled=state.busy;for(const btn of $('unresolvedGapRows').querySelectorAll('button'))btn.disabled=state.busy; $('bpmDisplayScale').disabled=state.busy; $('clickSource').disabled=state.busy; $('referenceClickOption').disabled=!referenceBeats.length; for(const id of ['chooseReference','readReference','referenceCourse','referenceFile'])$(id).disabled=state.busy; $('clearReference').disabled=state.busy||!reference; $('analyzeBtn').disabled=!state.file||state.busy;$('demoBtn').disabled=state.busy;$('chooseFileBtn').disabled=state.busy;$('cancelBtn').hidden=!state.busy;$('fileInput').disabled=state.busy;for(const id of ['halfTempoBtn','doubleTempoBtn'])$(id).disabled=state.busy||!getTempoReanalysis(state.result);for(const btn of $('tempoHypotheses').children)btn.disabled=state.busy;for(const id of ['tempoChangesList','tempoRegionsList'])for(const btn of $(id).querySelectorAll('button'))btn.disabled=state.busy; }
function cancel(){state.revision++;state.worker?.terminate();state.worker=null;state.busy=false;$('progressPanel').hidden=true;controls();}
function clearClicks(){for(const osc of state.clickNodes){try{osc.stop();}catch{}}state.clickNodes.clear();state.scheduledUntil=-1;}
function stop(){audio.pause();clearClicks();state.lastBeat=-1;$('playBtn').textContent='▶';$('playBtn').setAttribute('aria-label','再生');}
async function startPlayback(){if(!state.result)return;try{if(state.ctx)await state.ctx.resume();await audio.play();$('playBtn').textContent='Ⅱ';$('playBtn').setAttribute('aria-label','一時停止');}catch{toast('再生できませんでした。音源を再度選択してください。');}}
function clearResult(){$('tjaConfirmedMeter').value='';resetTjaDraft();unresolvedTempoIntervals=[];$('unresolvedGapPanel').hidden=true;$('unresolvedGapRows').replaceChildren();$('bpmDisplayScale').value='1';clearReference();stop();$('seekBar').value=0;$('currentTime').textContent=fmt(0);correctionHistory=[];currentMeasurement=null;$('precisionResult').textContent='入力した拍位置への適合を計測します。自動検出の正解判定や精度保証ではありません。';$('precisionAnchors').value='';$('useMeasurement').disabled=true;$('undoCorrection').disabled=true;state.result=null;state.analysisSamples=null;state.activeHint=null;state.peaks=[];state.selectedChange=-1;state.selectedRegion=-1;state.loop=false;$('loopBtn').setAttribute('aria-pressed','false');$('results').hidden=true;$('emptyState').hidden=false;$('correctionPanel').hidden=true;}
function selectFile(file){
  if(!file)return;
  if(state.busy){toast('解析を中止してから音源を変更してください。');return;}
  if(file.size>100*1024*1024){toast('100 MB以下の音源を選択してください。');return;}
  if(!file.type.startsWith('audio/')&&!/\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|webm)$/i.test(file.name)){toast('対応する音声ファイルを選択してください。');return;}
  state.revision++;clearResult();if(state.url)URL.revokeObjectURL(state.url);
  state.file=file;state.url=URL.createObjectURL(file);audio.src=state.url;
  $('uploadTitle').textContent=file.name;$('uploadMeta').textContent=`${(file.size/1024/1024).toFixed(1)} MB · 解析の準備ができました`;
  $('progressPanel').hidden=true;controls();
}
function waveformPeaks(samples){const out=[];const step=Math.max(1,Math.ceil(samples.length/1500));for(let i=0;i<samples.length;i+=step){let sum=0,max=0;for(let j=i;j<Math.min(i+step,samples.length);j++){const v=Math.abs(samples[j]);sum+=v*v;max=Math.max(max,v);}out.push(Math.sqrt(sum/step)*.6+max*.4);}const m=Math.max(...out,0.0001);return out.map(v=>v/m);}
async function analyze(hint=null,pulseScale=null){
  if(!state.file||state.busy)return;
  const tempoHint=typeof hint==='number'&&Number.isFinite(hint)&&hint>0?hint:null;
  stop();state.busy=true;controls();const revision=++state.revision;progress(.02,'音源を読み込んでいます…');
  try{
    if(!state.analysisSamples){
    if(audio.readyState<1)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);audio.removeEventListener('loadedmetadata',done);audio.removeEventListener('error',done);resolve();};const timer=setTimeout(done,8000);audio.addEventListener('loadedmetadata',done,{once:true});audio.addEventListener('error',done,{once:true});});
    if(revision!==state.revision)return;
    if(Number.isFinite(audio.duration)&&audio.duration>900)throw new Error('解析できる長さは15分までです。音源を分割して読み込んでください。');
    const bytes=await state.file.arrayBuffer();if(revision!==state.revision)return;
    const offline=new OfflineAudioContext(1,1,8000);
    const decoded=await offline.decodeAudioData(bytes);if(revision!==state.revision)return;
    if(decoded.duration>900)throw new Error('解析できる長さは15分までです。音源を分割して読み込んでください。');
    if(decoded.duration<3)throw new Error('3秒以上の音源を選択してください。');
    const samples=new Float32Array(decoded.length);for(let c=0;c<decoded.numberOfChannels;c++){const data=decoded.getChannelData(c);for(let i=0;i<samples.length;i++)samples[i]+=data[i]/decoded.numberOfChannels;}
    state.duration=decoded.duration;state.peaks=waveformPeaks(samples);state.analysisSamples=samples;state.analysisRate=decoded.sampleRate;
    }
    const samples=state.analysisSamples.slice();progress(.12,tempoHint?`${num(tempoHint)} BPMの拍解釈でテンポと拍子を再解析…`:'音の立ち上がりを抽出しています…');
    const worker=new Worker(new URL('./worker.js?v=33',import.meta.url),{type:'module'});state.worker=worker;
    worker.onmessage=({data})=>{
      if(revision!==state.revision)return;
      if(data.type==='progress'){progress(.12+data.progress*.85,data.stage||'リズムを解析しています…');return;}
      if(data.type==='error'){fail(data.message);return;}
      if(data.type==='result'){
        correctionHistory=[];$('undoCorrection').disabled=true;state.result=data.result;state.activeHint=tempoHint;state.selected=0;state.selectedChange=-1;state.selectedRegion=-1;state.loop=false;state.busy=false;worker.terminate();state.worker=null;$('loopBtn').setAttribute('aria-pressed','false');$('correctionPanel').hidden=true;$('progressPanel').hidden=true;render();controls();
        toast(state.result.bpm?'解析が完了しました。候補を比較し、クリック音で確認できます。':'明確な周期を検出できませんでした。別の音源や区間をお試しください。');
      }
    };
    worker.onerror=()=>{if(revision===state.revision)fail('解析中にエラーが発生しました。再読み込みしてお試しください。');};
    const options=tempoHint?{tempoHint,tempoReferenceBpm:state.result?.automaticBpm}:{};
    if(typeof pulseScale==='number')options.tempoScale=pulseScale;
    worker.postMessage({samples,sampleRate:state.analysisRate,options},[samples.buffer]);
  }catch(error){if(revision===state.revision)fail(error.message?.includes('decode')?'この音源を読み込めませんでした。WAVまたはMP3に変換してお試しください。':error.message||'音源を読み込めませんでした。');}
}
function fail(message){state.worker?.terminate();state.worker=null;state.busy=false;$('progressPanel').hidden=true;controls();toast(message);}
function render(){
  const r=state.result;if(!r)return;
  resetTjaDraft();
  $('emptyState').hidden=true;$('results').hidden=false;
  $('trackName').textContent=state.file.name;$('trackMeta').textContent=`${fmt(state.duration)} · ${r.beats.length}拍を検出 · ${r.sections.length}区間`;
  $('bpmValue').textContent=num(r.bpm);$('bpmRange').textContent=r.tempoModel==='constant-clock'?'一定テンポとして検出':r.bpm?`${num(r.bpmMin)} – ${num(r.bpmMax)} BPM`:'周期が不足しています';
  const family=meter=>meter==='2/4・4/4'?'4/4':meter;
  const votes=new Map();for(const section of r.sections){if(!section.meter||section.meter==='判定保留'||(!section.manual&&(section.confidence||0)<.45))continue;const meter=family(section.meter),weight=Math.max(0,section.end-section.start)*(section.manual?1:section.confidence);votes.set(meter,(votes.get(meter)||0)+weight);}
  const ranked=[...votes.entries()].sort((a,b)=>b[1]-a[1]),primary=ranked[0]?.[0];
  $('meterValue').textContent=primary||'判定保留';
  const hasChangeEvidence=r.sections.some(s=>typeof s.isMeterChange==='boolean');
  const changes=primary?r.sections.filter(s=>s.meter&&s.meter!=='判定保留'&&(s.manual&&family(s.meter)!==primary||s.type==='irregularity'||(hasChangeEvidence?s.isMeterChange===true:family(s.meter)!==primary&&s.confidence>=.7))):[];
  $('meterDetail').textContent=!primary?'拍のアクセントが不明瞭です':changes.length?'局所的な変化候補あり · 区間表で確認':'曲全体で最も手掛かりが強い拍子候補';
  const tempoChanges=visibleTempoChanges();
  $('stabilityValue').textContent=!r.bpm?'—':r.tempoModel==='constant-clock'?'一定テンポ':tempoChanges.length?'変化あり':'判定保留';
  $('stabilityDetail').textContent=r.tempoModel==='constant-clock'?'音の繰り返しが同じテンポと一致しています':tempoChanges.length?`${tempoChanges.length}件の変化候補 · 下の一覧で試聴できます`:r.bpm?'確かな変化を特定できませんでした':'十分な拍を検出できませんでした';
  $('confidenceText').textContent=`${r.tempoAmbiguous?'テンポに複数の解釈があります':`周期の手掛かり：${r.confidence>=.65?'強め':r.confidence>=.35?'中程度':'弱め'}`} · 拍子はアクセントからの候補です`;
  const reanalysis=getTempoReanalysis(r);
  $('tempoCandidates').textContent=reanalysis?.manual?`音源全体の${num(reanalysis.bpm)} BPMを基準にした拍解釈です。候補を選ぶと、手動修正を含む結果を音源から再解析します。`:state.activeHint?'拍の取り方を変更して再解析した結果です。曲中のテンポ変化は保ったまま追跡します。':'音源から自動で拍の取り方を比較しています。別候補を選ぶと、拍の位置と拍子も再解析します。';
  const hypotheses=$('tempoHypotheses');hypotheses.replaceChildren();
  const choices=[{ratio:1,reason:reanalysis?.manual?'音源全体の元の拍解釈で再解析':'現在の結果'},...(r.tempoAlternatives||[])].map(candidate=>{const action=getTempoReanalysis(r,candidate.ratio);return action?{...candidate,...action}:null;}).filter(c=>c&&c.bpm>=10&&c.bpm<=1200);const seen=[];
  for(const candidate of choices){if(seen.some(bpm=>Math.abs(Math.log2(candidate.bpm/bpm))<.045))continue;seen.push(candidate.bpm);if(seen.length>5)break;const btn=document.createElement('button');btn.className='button secondary small-button';btn.textContent=`${num(candidate.bpm)} BPM`;btn.title=candidate.reason||'このテンポ解釈で拍・拍子を再解析';const current=!candidate.manual&&seen.length===1;btn.setAttribute('aria-pressed',String(current));btn.setAttribute('aria-label',`${num(candidate.bpm)} BPMの拍解釈で再解析`);btn.disabled=state.busy;btn.addEventListener('click',()=>analyze(candidate.bpm,candidate.tempoScale));hypotheses.append(btn);}
  for(const [id,ratio]of [['halfTempoBtn',.5],['doubleTempoBtn',2]]){const action=getTempoReanalysis(r,ratio),button=$(id);button.disabled=!action||state.busy;button.title=action?`音源全体を${num(action.bpm)} BPMの拍解釈で再解析`:'';button.setAttribute('aria-label',action?button.title:button.textContent);}
  const tbody=$('sectionsBody');tbody.replaceChildren();
  r.sections.forEach((s,i)=>{
    const row=document.createElement('tr');row.classList.toggle('selected',i===state.selected);
    const description=[s.label,s.tempoLabel].filter(Boolean).join(' · ');
    const sectionBpm=s.tempoVariation>.02?`${num(s.tempoMin)} – ${num(s.tempoMax)}`:num(s.bpm);
    const values=[`${fmt(s.start,3)} — ${fmt(s.end,3)}`,s.meter||'判定保留',sectionBpm,s.manual?'手動修正':(description||s.type||'推定区間'),s.manual?'手動指定':s.meter==='判定保留'?'保留':s.meterAmbiguous?'複数候補':s.confidence>=.7?'強め':s.confidence>=.45?'中程度':'弱め'];
    for(const [j,value]of values.entries()){const td=document.createElement('td');if(j===1){const badge=document.createElement('span');badge.className='meter-badge';badge.textContent=value;td.append(badge);if(s.alternatives?.length&&!s.manual){const small=document.createElement('small');small.className='meter-alternatives';small.textContent='別候補 '+s.alternatives.slice(0,2).join(' / ');td.append(small);}}else td.textContent=value;row.append(td);}
    const td=document.createElement('td'),btn=document.createElement('button');btn.className='text-btn';btn.textContent='試聴・修正 ↗';btn.addEventListener('click',()=>selectSection(i));td.append(btn);row.append(td);tbody.append(row);
  });
  if(!r.sections.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='拍の周期が不明瞭なため、区間を生成できませんでした。';row.append(td);tbody.append(row);}
  $('notes').replaceChildren();
  const notes=[...(r.notes||[]),'拍子の分母（4分音符・8分音符）や6/8と3/4の違いは音源だけでは一意に決まりません。拍子候補・クリック音・実際の演奏を照合してください。'];
  for(const note of [...new Set(notes)]){const li=document.createElement('li'),hintPrefix=Number.isFinite(r.tempoHint)&&r.tempoHint>0?`選択した${r.tempoHint} BPM付近`:null;li.textContent=hintPrefix&&note.startsWith(hintPrefix)?`選択した${num(r.tempoHint)} BPM付近${note.slice(hintPrefix.length)}`:note;$('notes').append(li);}
  $('duration').textContent=fmt(state.duration);$('seekBar').max=state.duration;$('exportBtn').disabled=false;
  renderTempoDisplay();
  renderReference();
  renderTempoChanges();
  renderTempoRegions();
  renderUnresolvedGaps();
  draw();
}
function visibleTempoChanges(){
  if(state.result?.tempoModel==='constant-clock')return [];
  return (state.result?.tempoChanges||[]).filter(change=>
    Number.isFinite(change.start)&&Number.isFinite(change.end)&&change.start>=0&&change.end>=change.start&&change.end<=state.duration+.01&&
    Number.isFinite(change.fromBpm)&&change.fromBpm>0&&Number.isFinite(change.toBpm)&&change.toBpm>0);
}
function tempoChangeEstimate(change){return change.reportedTiming?.estimate??(Number.isFinite(change.timeEstimate)?change.timeEstimate:(change.start+change.end)/2);}
function renderTempoChanges(){
  const changes=visibleTempoChanges(),list=$('tempoChangesList'),empty=$('tempoChangesEmpty');list.replaceChildren();
  const constant=state.result?.tempoModel==='constant-clock';
  $('tempoChangesCount').textContent=changes.length?`${changes.length}件の候補`:constant?'一定テンポ':'判定保留';
  $('tempoChangeSummary').textContent=changes.length?'時刻とBPMは推定候補です。変化の前から試聴して確認できます。':constant?'一定テンポを検出しました。BPM変化の候補はありません。':'確かなBPM変化を特定できませんでした。グラフと音源を照合してください。';
  empty.hidden=changes.length>0;list.hidden=!changes.length;
  empty.textContent=constant?'周期が明瞭な区間は同じテンポで推定されています。':'手掛かりが弱い区間や細かな変化は、候補にできない場合があります。';
  changes.forEach((change,index)=>{
    const item=document.createElement('li');item.className='tempo-change-item';item.classList.toggle('selected',index===state.selectedChange);
    const number=document.createElement('span');number.className='tempo-change-number';number.textContent=String(index+1);number.setAttribute('aria-hidden','true');
    const details=document.createElement('div');details.className='tempo-change-details';
    const heading=document.createElement('div');heading.className='tempo-change-heading';
    const label=document.createElement('strong');label.textContent=change.type==='accelerando'?'加速':change.type==='ritardando'?'減速':'切り替え';
    const time=document.createElement('span');time.className='tempo-change-time';time.textContent=change.type==='step'||change.end-change.start<.15?fmt(tempoChangeEstimate(change),2):`${fmt(change.start,2)} — ${fmt(change.end,2)}`;
    heading.append(label,time);
    const rates=document.createElement('p');rates.className='tempo-change-rates';rates.textContent=`${num(change.fromBpm)} → ${num(change.toBpm)} BPM`;
    const strength=document.createElement('span');strength.className='tempo-change-strength';strength.textContent=(change.confidence??.5)>=.7?'強めの候補':(change.confidence??.5)>=.4?'中程度の候補':'弱めの候補';
    if(change.ambiguity)strength.textContent+=' · 別の拍解釈あり';
    const report=change.reportedTiming,uncertainty=report?.uncertainty??change.timeUncertainty;
    if(report?.boundsClipped)strength.textContent+=` · 候補範囲 ${fmt(report.start,2)} — ${fmt(report.end,2)}`;
    else if(Number.isFinite(uncertainty)&&uncertainty>0)strength.textContent+=` · ${change.type==='step'?'推定時刻':'区間端の推定'} ±${uncertainty.toFixed(2)}秒`;
    details.append(heading,rates,strength);
    const button=document.createElement('button');button.className='button secondary small-button tempo-change-play';button.textContent='試聴 ↗';button.disabled=state.busy;
    button.setAttribute('aria-label',`${time.textContent}の${label.textContent}候補、${num(change.fromBpm)}から${num(change.toBpm)} BPMを試聴`);
    if(index===state.selectedChange)button.setAttribute('aria-current','true');
    button.addEventListener('click',()=>listenToTempoChange(index));item.append(number,details,button);list.append(item);
  });
}
async function listenToTempoChange(index){
  const change=visibleTempoChanges()[index];if(!change||state.busy)return;
  clearClicks();state.loop=false;state.selectedChange=index;state.selectedRegion=-1;state.lastBeat=-1;$('loopBtn').setAttribute('aria-pressed','false');
  audio.currentTime=clamp(change.start-1.5,0,state.duration);$('currentTime').textContent=fmt(audio.currentTime);$('seekBar').value=audio.currentTime;
  highlightTempoItem('tempoChangesList',index);highlightTempoItem('tempoRegionsList',-1);
  draw();await startPlayback();
}
function highlightTempoItem(listId,index){
  [...$(listId).children].forEach((item,i)=>{item.classList.toggle('selected',i===index);const button=item.querySelector('button');if(i===index)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');});
}
function visibleTempoRegions(){
  if(state.result?.tempoModel==='constant-clock')return [];
  return (state.result?.tempoRegions||[]).filter(region=>Number.isFinite(region.start)&&Number.isFinite(region.end)&&region.start>=0&&region.end>=region.start&&region.end<=state.duration+.01&&Number.isFinite(region.bpm)&&region.bpm>0);
}
function renderTempoRegions(){
  const regions=visibleTempoRegions(),panel=$('tempoRegionsPanel'),list=$('tempoRegionsList');panel.hidden=!regions.length;list.replaceChildren();
  $('tempoRegionsCount').textContent=`${regions.length}件の候補`;
  regions.forEach((region,index)=>{
    const item=document.createElement('li');item.className='tempo-change-item';item.classList.toggle('selected',index===state.selectedRegion);
    const badge=document.createElement('span');badge.className='tempo-region-badge';badge.textContent='候補';
    const details=document.createElement('div');details.className='tempo-change-details';
    const time=document.createElement('strong');time.className='tempo-change-time';time.textContent=`${fmt(region.start,2)} — ${fmt(region.end,2)}`;
    const rates=document.createElement('p');rates.className='tempo-change-rates';rates.textContent=`${num(region.bpm)} BPM`;
    if(region.ambiguous){const label=document.createElement('span');label.className='tempo-region-ambiguous';label.textContent='複数候補';rates.append(label);}
    const strength=document.createElement('span');strength.className='tempo-change-strength';strength.textContent=(region.confidence??.5)>=.7?'強めの候補':(region.confidence??.5)>=.4?'中程度の候補':'弱めの候補';
    if(Number.isFinite(region.timeUncertainty)&&region.timeUncertainty>0)strength.textContent+=` · 推定時刻 ±${region.timeUncertainty.toFixed(2)}秒`;
    details.append(time,rates,strength);
    const alternatives=[...new Set((region.alternatives||[]).filter(c=>Number.isFinite(c.bpm)&&c.bpm>0&&Math.abs(c.bpm-region.bpm)>.05).map(c=>num(c.bpm)))].slice(0,2);
    if(alternatives.length){const other=document.createElement('span');other.className='tempo-change-strength';other.textContent=`別候補 ${alternatives.join(' / ')} BPM`;details.append(other);}
    const button=document.createElement('button');button.className='button secondary small-button tempo-change-play';button.textContent='試聴 ↗';button.disabled=state.busy;button.setAttribute('aria-label',`${time.textContent}の区間候補、${num(region.bpm)} BPMを試聴`);
    if(index===state.selectedRegion)button.setAttribute('aria-current','true');button.addEventListener('click',()=>listenToTempoRegion(index));item.append(badge,details,button);list.append(item);
  });
}
async function listenToTempoRegion(index){
  const region=visibleTempoRegions()[index];if(!region||state.busy)return;
  clearClicks();state.loop=false;state.selectedChange=-1;state.selectedRegion=index;state.lastBeat=-1;$('loopBtn').setAttribute('aria-pressed','false');
  audio.currentTime=clamp(region.start-1.5,0,state.duration);$('currentTime').textContent=fmt(audio.currentTime);$('seekBar').value=audio.currentTime;
  highlightTempoItem('tempoChangesList',-1);highlightTempoItem('tempoRegionsList',index);draw();await startPlayback();
}
function selectSection(i){
  const s=state.result?.sections[i];if(!s)return;
  state.selected=i;audio.currentTime=s.start;state.lastBeat=-1;
  $('sectionStart').value=preciseInput(s.start);$('sectionEnd').value=preciseInput(s.end);$('manualBpm').value=preciseInput(s.bpm);
  $('manualMeter').value=[...$('manualMeter').options].some(o=>o.value===s.meter)?s.meter:'auto';
  $('correctionStatus').textContent='開始時刻を1拍目として補正します。クリック音で位置を確認してください。';$('correctionPanel').hidden=false;render();$('correctionPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function saveCorrection(){
  const r=state.result;if(!r||state.busy)return;
  const start=Number($('sectionStart').value),end=Number($('sectionEnd').value),bpm=Number($('manualBpm').value),meter=$('manualMeter').value;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>state.duration+.01||end<=start||!Number.isFinite(bpm)||bpm<=0){$('correctionStatus').textContent='区間は音源内で開始＜終了、BPMは0より大きい数にしてください。';return;}
  if((end-start)*bpm/60>20000){$('correctionStatus').textContent='拍の数が多すぎます。修正する区間を短くしてください。';return;}
  correctionHistory.push(structuredClone(r));if(correctionHistory.length>20)correctionHistory.shift();$('undoCorrection').disabled=false;
  const unchangedBeatSteps=(r.tempoChanges||[]).filter(event=>(event.source==='regular-beat-timing-step'||event.beatTimingVerified)&&(event.end<=start||event.start>=end));
  const unchangedRamps=(r.tempoChanges||[]).filter(event=>event.source==='beat-phase-ramp'&&(event.end<=start||event.start>=end));
  clearClicks();r.tempoModel='manual';r.constantTempo=null;
  r.notes=(r.notes||[]).filter(note=>note!=='周期が明瞭な区間に同じテンポが合うため、一定テンポとして推定しています。');
  const old=r.sections.find(s=>s.start<=start&&s.end>start)||r.sections[0];
  const signature=meter==='auto'?(old?.meter||'判定保留'):meter;
  const [n,d]=signature.split('/').map(Number);
  const change={...old,start,end,bpm,meter:signature,meterConfirmed:meter!=='auto',numerator:n||null,denominator:d||null,confidence:1,manual:true,label:'手動修正',type:'manual',alternatives:[],accentPeriod:n||null,tempoMin:bpm,tempoMax:bpm,tempoVariation:0,tempoLabel:'手動固定'};
  const sections=[];
  for(const s of r.sections){if(s.end<=start||s.start>=end)sections.push(s);else{if(s.start<start)sections.push({...s,end:start});if(s.end>end)sections.push({...s,start:end});}}
  sections.push(change);r.sections=sections.sort((a,b)=>a.start-b.start);
  r.beats=r.beats.filter(b=>b.time<start||b.time>=end);
  for(let time=start,i=0;time<end-.001;time+=60/bpm,i++)r.beats.push({time,bpm,strength:1,downbeat:n?i%n===0:false,bar:n?Math.floor(i/n)+1:null,beatInBar:n?i%n+1:null,numerator:n||null,denominator:d||null,manual:true});
  r.beats.sort((a,b)=>a.time-b.time);
  const previousCurve=(r.tempoCurve||[]).filter(point=>point.time<start||point.time>=end);
  const manualCurve=r.beats.filter(beat=>beat.time>=start&&beat.time<end).map(({time,bpm,tempoChange,tempoGap})=>({time,bpm,tempoChange,tempoGap,manual:true,tempoEvidence:1}));
  r.tempoCurve=[...previousCurve,...manualCurve].sort((a,b)=>a.time-b.time);
  r.tempoChanges=annotateTempoChangeEvidence(mergeShortTempoRamps(mergeBeatTempoSteps(detectTempoChanges(r.tempoCurve,state.duration),unchangedBeatSteps,{tempoCurve:r.tempoCurve,duration:state.duration}),unchangedRamps,{tempoCurve:r.tempoCurve}),r.tempoCurve);state.selectedChange=-1;
  r.tempoRegions=(r.tempoRegions||[]).filter(region=>region.end<=start||region.start>=end);state.selectedRegion=-1;
  if(!r.tempoRegions.length)r.notes=r.notes.filter(note=>!note.startsWith('一部の区間は拍の連続性'));
  for(const section of r.sections){section.beatStart=r.beats.findIndex(b=>b.time>=section.start);const after=r.beats.findIndex(b=>b.time>=section.end);section.beatEnd=after<0?r.beats.length:after;if(section.beatStart<0)section.beatStart=section.beatEnd;}
  r.bpm=median(r.beats.map(b=>b.bpm));const bpms=r.tempoCurve.map(p=>p.bpm).filter(Number.isFinite);r.bpmMin=bpms.length?Math.min(...bpms):bpm;r.bpmMax=bpms.length?Math.max(...bpms):bpm;
  state.selected=r.sections.indexOf(change);state.lastBeat=-1;render();$('correctionStatus').textContent='修正を適用しました。書き出しにも反映されます。';toast('指定区間のBPM・拍子候補・拍位置を更新しました。');
}
function context(canvas){const rect=canvas.getBoundingClientRect();if(!rect.width)return null;const dpr=Math.min(window.devicePixelRatio||1,2);canvas.width=rect.width*dpr;canvas.height=rect.height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);return {ctx,w:rect.width,h:rect.height};}
function draw(){drawWave();drawTempo();}
function drawWave(){
  const c=context($('waveform'));if(!c||!state.result)return;const {ctx,w,h}=c,r=state.result;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#f6f8f5';ctx.fillRect(0,0,w,h);
  r.sections.forEach((s,i)=>{if(i%2===0){ctx.fillStyle='#e9efe9';ctx.fillRect(s.start/state.duration*w,0,(s.end-s.start)/state.duration*w,h);}});
  const played=audio.currentTime/state.duration*w;
  for(let i=0;i<state.peaks.length;i++){const x=i/state.peaks.length*w;const amplitude=Math.max(1,state.peaks[i]*h*.39);ctx.fillStyle=x<played?'#17634a':'#9db8aa';ctx.fillRect(x,h/2-amplitude,Math.max(1,w/state.peaks.length),amplitude*2);}
  const limit=r.beats.length>2500?Math.ceil(r.beats.length/2500):1;
  for(let i=0;i<r.beats.length;i+=limit){const b=r.beats[i],x=b.time/state.duration*w;ctx.strokeStyle=b.downbeat?'#26755188':'#477d5320';ctx.beginPath();ctx.moveTo(x,b.downbeat?0:h*.8);ctx.lineTo(x,h);ctx.stroke();}
  ctx.fillStyle='#133f32';ctx.fillRect(played,0,2,h);
  const selected=r.sections[state.selected];if(state.loop&&selected){ctx.strokeStyle='#36755a';ctx.lineWidth=2;ctx.strokeRect(selected.start/state.duration*w,1,(selected.end-selected.start)/state.duration*w,h-2);}
}
function drawTempo(){
  const c=context($('tempoChart'));if(!c||!state.result)return;const {ctx,w,h}=c;
  const points=state.result.tempoCurve.filter(p=>Number.isFinite(p.bpm)&&p.bpm>0);ctx.clearRect(0,0,w,h);
  if(!points.length&&!reference){ctx.fillStyle='#7a857c';ctx.font='13px sans-serif';ctx.fillText('テンポの推移を算出できませんでした',24,50);return;}
  const values=[...points.map(p=>p.bpm),...(reference?.events||[]).filter(p=>p.time<=state.duration).map(p=>p.bpm)];
  if(!values.length){ctx.fillStyle='#7a857c';ctx.font='13px sans-serif';ctx.fillText('音源の範囲内に表示できる推定・参照BPMがありません',24,50);return;}
  const min=Math.floor(Math.min(...values)/5)*5-5,max=Math.ceil(Math.max(...values)/5)*5+5;
  const left=44,right=w-14,top=15,bottom=h-26;
  let lastLabel=-Infinity;
  visibleTempoChanges().forEach((change,index)=>{
    const bounds=change.reportedTiming||change;
    const start=left+clamp(bounds.start/state.duration,0,1)*(right-left),end=left+clamp(bounds.end/state.duration,0,1)*(right-left);
    const selected=index===state.selectedChange,x=change.type==='step'?left+clamp(tempoChangeEstimate(change)/state.duration,0,1)*(right-left):start;
    ctx.fillStyle=selected?'#c8aa6644':'#c8aa661c';ctx.fillRect(start,top,Math.max(2,end-start),bottom-top);
    ctx.strokeStyle=selected?'#8e7135':'#ad8d5088';ctx.lineWidth=selected?1.5:1;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.setLineDash([]);
    if(x-lastLabel>25){ctx.fillStyle='#8e7135';ctx.font='10px sans-serif';ctx.fillText(String(index+1),x+4,top+10);lastLabel=x;}
  });
  ctx.lineWidth=1;ctx.font='11px sans-serif';ctx.fillStyle='#87928a';ctx.strokeStyle='#e6eae4';
  for(let i=0;i<4;i++){const value=min+(max-min)*i/3,y=bottom-(bottom-top)*i/3;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillText(Math.round(value),5,y+4);}
  for(let i=0;i<=4;i++){const t=state.duration*i/4;ctx.fillText(fmt(t),left+(right-left)*i/4-12,h-6);}
  const xy=p=>[left+p.time/state.duration*(right-left),bottom-(p.bpm-min)/(max-min)*(bottom-top)];
  const spans=points.length?[[]]:[];
  for(const point of points){
    if(point.tempoGap&&spans.at(-1).length)spans.push([]);
    const span=spans.at(-1),previous=span.at(-1);
    if(point.tempoChange&&previous)span.push({time:point.time,bpm:previous.bpm});
    span.push(point);
  }
  const gradient=ctx.createLinearGradient(0,top,0,bottom);
  gradient.addColorStop(0,'#acd7af66');gradient.addColorStop(1,'#d5e9cb11');
  for(const span of spans){
    const first=xy(span[0]),last=xy(span.at(-1));
    ctx.beginPath();ctx.moveTo(first[0],bottom);
    for(const point of span)ctx.lineTo(...xy(point));
    ctx.lineTo(last[0],bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
    ctx.beginPath();ctx.moveTo(...first);
    for(const point of span.slice(1))ctx.lineTo(...xy(point));
    ctx.strokeStyle='#267755';ctx.lineWidth=2;ctx.lineJoin='round';ctx.stroke();
  }
  if(reference){
    ctx.save();ctx.strokeStyle='#8550b3';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.beginPath();
    reference.events.forEach((event,i)=>{const end=Math.min(state.duration,reference.events[i+1]?.time??reference.end),start=Math.max(0,event.time);if(end<=start)return;ctx.moveTo(...xy({time:start,bpm:event.bpm}));ctx.lineTo(...xy({time:end,bpm:event.bpm}));const next=reference.events[i+1];if(next&&next.time>=0&&next.time<=state.duration)ctx.lineTo(...xy(next));});ctx.stroke();ctx.restore();
    ctx.fillStyle='#8550b3';ctx.font='11px sans-serif';ctx.fillText('紫破線：参照TJA（推定とは別）',left+8,top+12);
  }
}
function clickBeat(beat,delay){if(!state.ctx||state.ctx.state!=='running')return;const osc=state.ctx.createOscillator(),gain=state.ctx.createGain(),t=state.ctx.currentTime+Math.max(0,delay);osc.frequency.value=beat.downbeat?1400:900;gain.gain.setValueAtTime(.055,t);gain.gain.exponentialRampToValueAtTime(.001,t+.035);osc.connect(gain);gain.connect(state.ctx.destination);state.clickNodes.add(osc);osc.onended=()=>{state.clickNodes.delete(osc);osc.disconnect();gain.disconnect();};osc.start(t);osc.stop(t+.04);}
function scheduleClicks(){
  if(!state.click||audio.paused||!state.result||!state.ctx)return;
  const time=audio.currentTime,beats=$('clickSource').value==='reference'?referenceBeats:state.result.beats,section=state.result.sections[state.selected];let lo=0,hi=beats.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(beats[mid].time<time-.012)lo=mid+1;else hi=mid;}
  for(let i=lo;i<beats.length&&beats[i].time<time+.16;i++){const b=beats[i];if(state.loop&&section&&b.time>=section.end)break;if(b.time>state.scheduledUntil){clickBeat(b,(b.time-time)/audio.playbackRate);state.scheduledUntil=b.time;}}
}
function animation(){
  if(state.result&&!audio.paused){
    const selected=state.result.sections[state.selected];if(state.loop&&selected&&audio.currentTime>=selected.end){audio.currentTime=selected.start;state.lastBeat=-1;}
    $('currentTime').textContent=fmt(audio.currentTime);$('seekBar').value=audio.currentTime;drawWave();
  }
  requestAnimationFrame(animation);
}
function wav(samples,sr){const buf=new ArrayBuffer(44+samples.length*2),v=new DataView(buf);const str=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};str(0,'RIFF');v.setUint32(4,36+samples.length*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,samples.length*2,true);for(let i=0;i<samples.length;i++)v.setInt16(44+i*2,clamp(samples[i],-1,1)*32767,true);return new Blob([buf],{type:'audio/wav'});}
function demo(kind='steady'){
  if(state.busy)return;
  const rapid=kind==='variable'&&$('variableDemoKind').value==='rapid';
  const oneBar=kind==='variable'&&$('variableDemoKind').value==='one-bar';
  const data=kind==='variable'?(oneBar?createOneBarAccelerationDemo():rapid?createRapidVariableDemo():createVariableDemo()):kind==='gap'?createGapDemo():createSteadyDemo();
  const {samples,sampleRate}=data,blob=wav(samples,sampleRate);
  const sequence=kind==='variable'?(oneBar?`${data.ramp.fromBpm}→${data.ramp.toBpm}`:data.stages.map(stage=>stage.bpm).join('→')):'';
  const name=kind==='variable'?`${oneBar?'1小節加速BPMデモ':rapid?'大きな変動BPMデモ':'変動BPMデモ'}_${sequence}.wav`:kind==='gap'?'空白を挟むデモ_120から150BPM.wav':'一定BPMデモ_120BPM.wav';
  selectFile(new File([blob],name,{type:'audio/wav'}));
  if(kind==='variable')$('uploadMeta').textContent=oneBar?`デモ：${data.ramp.fromBpm} → ${data.ramp.toBpm} BPMを1小節で加速 · 4/4・4拍を1小節とする検証用音源 · 音源から自動解析します`:`デモのBPM順序：${data.stages.map(stage=>stage.bpm).join(' → ')} · 音源から自動解析します`;
  analyze();
}
$('chooseFileBtn').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',e=>selectFile(e.target.files[0]));
const drop=$('dropZone');for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('dragover');});for(const event of ['dragleave','drop'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.remove('dragover');});drop.addEventListener('drop',e=>selectFile(e.dataTransfer.files[0]));
$('analyzeBtn').addEventListener('click',analyze);$('cancelBtn').addEventListener('click',()=>{cancel();toast('解析を中止しました。');});$('demoBtn').addEventListener('click',()=>demo());$('gapDemoBtn').addEventListener('click',()=>demo('gap'));$('variableDemoBtn').addEventListener('click',()=>demo('variable'));
$('variableDemoKind').addEventListener('change',()=>{const option=$('variableDemoKind').selectedOptions[0];$('variableDemoSequence').textContent=`${option.textContent}の検証用音源。BPM：${option.dataset.sequence}。${option.dataset.assumption||''}`;});
for(const [id,ratio]of [['halfTempoBtn',.5],['doubleTempoBtn',2]])$(id).addEventListener('click',()=>{const action=getTempoReanalysis(state.result,ratio);if(action)analyze(action.bpm,action.tempoScale);});
$('resetBtn').addEventListener('click',()=>{cancel();clearResult();if(state.url)URL.revokeObjectURL(state.url);state.url=null;state.file=null;audio.removeAttribute('src');$('fileInput').value='';$('uploadTitle').textContent='音源をドラッグ＆ドロップ';$('uploadMeta').textContent='MP3 / WAV / M4A / FLAC / OGG · 100 MB・15分まで';controls();window.scrollTo({top:0,behavior:'smooth'});});
$('playBtn').addEventListener('click',async()=>{if(!state.result)return;if(!audio.paused){stop();return;}await startPlayback();});
audio.addEventListener('ended',stop);audio.addEventListener('seeking',clearClicks);audio.addEventListener('pause',clearClicks);audio.addEventListener('seeked',()=>{state.lastBeat=-1;$('currentTime').textContent=fmt(audio.currentTime);$('seekBar').value=audio.currentTime;drawWave();});
$('seekBar').addEventListener('input',e=>{audio.currentTime=Number(e.target.value);state.lastBeat=-1;drawWave();});
$('waveform').addEventListener('click',e=>{if(!state.result)return;const r=e.currentTarget.getBoundingClientRect();audio.currentTime=clamp((e.clientX-r.left)/r.width,0,1)*state.duration;});
$('metronomeBtn').addEventListener('click',async()=>{state.click=!state.click;clearClicks();$('metronomeBtn').setAttribute('aria-pressed',state.click);try{if(state.click){state.ctx??=new AudioContext();await state.ctx.resume();}}catch{state.click=false;$('metronomeBtn').setAttribute('aria-pressed','false');toast('クリック音を開始できませんでした。');}});
$('loopBtn').addEventListener('click',()=>{if(!state.result?.sections.length)return;state.loop=!state.loop;$('loopBtn').setAttribute('aria-pressed',state.loop);if(state.loop){audio.currentTime=state.result.sections[state.selected].start;toast(`区間 ${state.selected+1} をループします。表の「試聴・修正」で区間を選べます。`);}drawWave();});
$('precisionAnchors').addEventListener('input',()=>{currentMeasurement=null;$('useMeasurement').disabled=true;});
$('measureAnchors').addEventListener('click',()=>{
  if(state.busy||!state.result)return;
  try{currentMeasurement=measureAnchors(parseAnchors($('precisionAnchors').value,state.duration));
    const m=currentMeasurement;$('precisionResult').textContent=`${m.bpm.toFixed(6)} BPM · ${m.anchorCount}点 / ${m.beatIntervals}拍間隔 · 一定テンポへのずれ RMS ${m.residualRmsMs.toFixed(3)} ms / 最大 ${m.residualMaxMs.toFixed(3)} ms。${m.anchorCount===2?'2点では内部の変動や位置の誤りは検出できません。':'ずれが大きい場合はテンポ変化・拍番号・時刻を確認してください。'} 小数桁数や適合誤差は、真のBPMの精度を保証しません。`;$('useMeasurement').disabled=false;
  }catch(error){currentMeasurement=null;$('useMeasurement').disabled=true;$('precisionResult').textContent=error.message;}
});
$('useMeasurement').addEventListener('click',()=>{
  if(!currentMeasurement||state.busy||!state.result)return;
  const m=currentMeasurement;
  if(m.firstBeatTime<0||m.firstBeatTime>=m.end){toast('適合した最初の拍位置が範囲外です。入力を確認してください。');return;}
  $('sectionStart').value=preciseInput(m.firstBeatTime);$('sectionEnd').value=preciseInput(m.end);$('manualBpm').value=preciseInput(m.bpm);$('manualMeter').value='auto';$('correctionPanel').hidden=false;
  $('correctionStatus').textContent='計測値を転記しました。まだ結果には適用していません。一定テンポの範囲とクリック位置を確認してから適用してください。';$('correctionPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
});
$('undoCorrection').addEventListener('click',()=>{
  if(state.busy||!correctionHistory.length)return;clearClicks();state.result=correctionHistory.pop();state.selected=Math.min(state.selected,state.result.sections.length-1);state.selectedChange=-1;state.selectedRegion=-1;$('undoCorrection').disabled=!correctionHistory.length;render();$('correctionPanel').hidden=true;toast('直前の修正を元に戻しました。');
});
$('saveCorrection').addEventListener('click',saveCorrection);$('closeCorrection').addEventListener('click',()=>$('correctionPanel').hidden=true);
$('exportBtn').addEventListener('click',()=>{if(!state.result)return;const out={schemaVersion:1,fileName:state.file.name,analyzedAt:new Date().toISOString(),bpmUnit:'detected pulses per minute; meter notation is a candidate',...state.result,reviewDiagnostics:{unresolvedTempoIntervals,notDetectedChanges:true,interpolated:false},...(reference?{referenceComparison:{source:'user-supplied TJA; not automatic inference',reference,comparison:referenceComparison}}:{})};const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=state.file.name.replace(/\.[^.]+$/,'')+'.rhythm.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('区間・拍位置・修正をJSONで書き出しました。');});
$('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());$('closeHelpBtn').addEventListener('click',()=>$('helpDialog').close());$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog'))$('helpDialog').close();});
drop.addEventListener('keydown',e=>{if(e.target===drop&&(e.key==='Enter'||e.key===' ')){e.preventDefault();if(!state.busy)$('fileInput').click();}});
window.addEventListener('resize',draw);window.addEventListener('beforeunload',()=>{state.worker?.terminate();if(state.url)URL.revokeObjectURL(state.url);});
controls();setInterval(scheduleClicks,25);requestAnimationFrame(animation);

function resetReferenceClicks(){
 clearClicks();referenceBeats=[];if($('clickSource').value==='reference'){state.click=false;$('metronomeBtn').setAttribute('aria-pressed','false');}
 $('clickSource').value='estimated';$('referenceClickOption').disabled=true;$('referenceAudition').textContent='音源だけで推定拍のクリックを聴けます。手元にTJAがある場合だけ、参照クリックも選べます。';
}
function clearReference(){
 resetReferenceClicks();referenceReadRevision++;
 reference=null;referenceText='';referenceComparison=null;
 $('referenceText').value='';$('referenceFile').value='';$('referenceCourse').replaceChildren();$('referenceCourseLabel').hidden=true;$('clearReference').disabled=true;
 $('referenceSummary').hidden=true;$('referenceTableWrap').hidden=true;$('referenceRows').replaceChildren();$('referenceStatus').classList.remove('reference-error');$('referenceStatus').textContent='参照なし。音源だけで解析できます。TJAは任意で、読み込んでも自動推定は変わりません。';
}
function referenceError(message){resetReferenceClicks();reference=null;referenceComparison=null;$('referenceSummary').hidden=true;$('referenceTableWrap').hidden=true;$('referenceRows').replaceChildren();$('clearReference').disabled=true;$('referenceStatus').classList.add('reference-error');$('referenceStatus').textContent=message;draw();}
function referenceWaveMatches(wave){const base=value=>String(value||'').replace(/^"|"$/g,'').split(/[\\/]/).at(-1).normalize('NFC').toLowerCase();return !!wave&&base(wave)===base(state.file?.name);}
function selectReferenceChart(){
 try{const parsed=parseTjaReference(referenceText,{chartId:$('referenceCourse').value});if(!referenceWaveMatches(parsed.wave))throw new Error(`WAVE「${parsed.wave||'未指定'}」と音源「${state.file?.name||'未選択'}」が一致しません。対応する譜面を選んでください。`);resetReferenceClicks();reference=parsed;referenceBeats=generateTjaReferenceBeats(parsed,{duration:state.duration});$('referenceClickOption').disabled=!referenceBeats.length;$('referenceAudition').textContent=referenceBeats.length?`参照クリック：${referenceBeats.length}拍（${fmt(referenceBeats[0].time,3)} — ${fmt(referenceBeats.at(-1).time,3)}）。TJAの開始位置から四分音符を連続して刻みます。音符そのものや小節頭ではありません。`:'音源の範囲内に参照クリックがありません。OFFSETと譜面の長さを確認してください。';renderReference();draw();controls();}
 catch(error){referenceError(error.message||'参照譜面を読み込めませんでした。');}
}
function readReference(text){
 referenceReadRevision++;
 if(state.busy||!state.result){toast('音源の解析が完了してから参照を読み込んでください。');return;}
 try{referenceText='';$('referenceCourse').replaceChildren();$('referenceCourseLabel').hidden=true;if(text.length>1000000)throw new Error('参照TJAは1 MB相当以下にしてください。');const charts=listTjaCharts(text);referenceText=text;const select=$('referenceCourse');select.replaceChildren();if(charts.length>1){const prompt=document.createElement('option');prompt.value='';prompt.textContent='難易度・プレイヤーを選択';prompt.disabled=true;prompt.selected=true;select.append(prompt);}for(const chart of charts){const option=document.createElement('option');option.value=chart.id;option.textContent=`${chart.course||'難易度未指定'}${chart.player?' / '+chart.player:''}`;select.append(option);}$('referenceCourseLabel').hidden=charts.length<=1;if(charts.length>1){referenceError('複数の譜面があります。比較する難易度・プレイヤーを選択してください。');$('referenceStatus').classList.remove('reference-error');}else selectReferenceChart();}
 catch(error){referenceError(error.message||'参照譜面を読み込めませんでした。');}
}
function renderReference(){
 if(!reference||!state.result)return;
 try{referenceComparison=compareTjaReference(reference,state.result);}catch(error){referenceError(error.message);return;}
 $('referenceStatus').classList.remove('reference-error');$('referenceStatus').textContent=`参照：${reference.title||'タイトル未指定'} · ${reference.course||''} · WAVE: ${reference.wave} · OFFSET: ${reference.offset} 秒。ファイル名の一致は、音源内容や同期の保証ではありません。`;
 const box=$('referenceSummary');box.hidden=false;box.className='reference-metrics';box.textContent=referenceSummaryText(referenceComparison);
 const tbody=$('referenceRows');tbody.replaceChildren();reference.events.slice(0,500).forEach((event,i)=>{const row=document.createElement('tr');for(const text of [(event.time<0?'−':'')+fmt(Math.abs(event.time),3),String(event.bpm)+' BPM'+(i===0?'（初期）':'')]){const td=document.createElement('td');td.textContent=text;row.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.className='text-btn';button.textContent='この位置へ';button.disabled=event.time<0||event.time>state.duration;button.addEventListener('click',()=>{audio.currentTime=clamp(event.time,0,state.duration);$('seekBar').value=audio.currentTime;draw();});td.append(button);row.append(td);tbody.append(row);});$('referenceTableWrap').hidden=false;$('clearReference').disabled=state.busy;
}
function referenceSummaryText(c){
 if(!c.available)return c.reason+' 紫の破線は譜面の指定値のみです。';
 return `${state.result?.tempoModel==='manual'?'現在の結果（手動修正を含む）':'音声の推定結果'}との参照比較：${fmt(c.start,3)} — ${fmt(c.end,3)} / ${c.duration.toFixed(3)} 秒。BPM ±${(c.tolerance*100).toFixed(0)}% 一致：${c.directAgreementPercent.toFixed(1)}%（評価時間全体）。推定できた時間：${c.coveragePercent.toFixed(1)}% / 未推定 ${c.unsupportedSeconds.toFixed(3)} 秒。OFFSET自動調整・倍半分の読み替えなし。${reference.events.length>500?'変更一覧は先頭500件を表示。':''}`;
}
$('chooseReference').addEventListener('click',()=>$('referenceFile').click());
$('referenceFile').addEventListener('change',async()=>{const file=$('referenceFile').files?.[0];if(!file)return;const revision=state.revision,request=++referenceReadRevision;try{if(file.size>1000000)throw new Error('参照TJAは1 MB以下にしてください。');const bytes=await file.arrayBuffer();if(revision!==state.revision||request!==referenceReadRevision)return;let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('shift_jis',{fatal:true}).decode(bytes);}readReference(text);}catch(error){if(revision===state.revision&&request===referenceReadRevision){clearReference();referenceError(error.message||'UTF-8またはShift_JISのTJAを選んでください。');}}});
$('readReference').addEventListener('click',()=>readReference($('referenceText').value));
$('referenceCourse').addEventListener('change',selectReferenceChart);
$('clearReference').addEventListener('click',()=>{clearReference();draw();});

$('clickSource').addEventListener('change',()=>{clearClicks();if($('clickSource').value==='reference'&&!referenceBeats.length){$('clickSource').value='estimated';toast('参照TJAを読み込んでください。');}else toast($('clickSource').value==='reference'?'クリックを参照TJAの四分音符に切り替えました。':'クリックを現在の推定拍に切り替えました。');});

function renderTempoDisplay(){
 const view=getTempoDisplaySummary(state.result?.bpm,Number($('bpmDisplayScale').value));
 $('bpmValue').textContent=view.text;$('bpmDisplayAlternatives').textContent=view.alternatives.map(item=>`${item.scale===.5?'半分':item.scale===1?'元の値':'倍'} ${item.text} BPM`).join(' · ');
 $('bpmDisplayLabel').textContent=`代表テンポ（表示 ×${view.scale}）`;$('bpmDisplayNote').textContent='表示単位のみ変更。下のグラフ・区間・参照TJA・比較値・クリック位置・書き出しは元の値のままです。倍・半分の表記自体を誤りとは判定しません。';
}
$('bpmDisplayScale').addEventListener('change',renderTempoDisplay);

function renderUnresolvedGaps(){
 unresolvedTempoIntervals=deriveUnresolvedTempoIntervals(state.result);
 const panel=$('unresolvedGapPanel'),rows=$('unresolvedGapRows');rows.replaceChildren();panel.hidden=!unresolvedTempoIntervals.length;
 for(const interval of unresolvedTempoIntervals){
  const item=document.createElement('li'),heading=document.createElement('strong'),rates=document.createElement('p'),note=document.createElement('p'),button=document.createElement('button');
  heading.textContent=`${fmt(interval.start,2)} — ${fmt(interval.end,2)}：変化の有無・位置は未確定`;
  rates.textContent=`前の安定した推定 ${num(interval.fromBpm)} BPM / 後の安定した推定 ${num(interval.toBpm)} BPM`;
  note.textContent='間のBPMは推定できていません。1回の変化とは限らず、拍単位の違いや推定誤りもあり得ます。解析窓の影響があるため、この範囲内で変化したと断定するものではありません。';
  button.textContent='前後を試聴';button.className='button secondary small-button';button.disabled=state.busy;button.addEventListener('click',()=>{stop();state.loop=false;$('loopBtn').setAttribute('aria-pressed','false');audio.currentTime=Math.max(0,interval.start-2);$('seekBar').value=audio.currentTime;startPlayback();});
  item.append(heading,rates,note,button);rows.append(item);
 }
}

function renderExportBlockerReview(report){
 if(report===lastExportBlockerReport)return;lastExportBlockerReport=report;
 const panel=$('tjaBlockerReview');panel.hidden=!report?.applicable;panel.open=false;$('tjaBlockerRows').replaceChildren();
 if(!report?.applicable)return;
 const total=report.items.length+report.unlocated.length;
 $('tjaBlockerSummary').textContent=`保存を止めている推定箇所を確認（${total}件）`;
 $('tjaBlockerExplanation').textContent=report.explanation+` 対象サンプル ${report.rejectedSampleCount}個・候補領域 ${report.regionCount}件。確認しても推定や書き出し条件は変わりません。`;
 const currentResult=state.result,currentRevision=state.revision;
 for(const item of [...report.items,...report.unlocated].slice(0,50)){
  const li=document.createElement('li'),text=document.createElement('span');
  const location=Number.isFinite(item.start)?`${item.start.toFixed(3)}${item.end===item.start?'':'–'+item.end.toFixed(3)} 秒`:'場所未特定';
  const source=item.kind==='sample-span'?`推定サンプル #${item.firstIndex}–${item.lastIndex} (${item.sampleCount}個)` :item.kind==='sample'?`推定サンプル #${item.index}`:`候補領域 #${item.index??'不明'}`;
  text.textContent=`${location} · ${item.labels?.join(' / ')||item.reason} · ${source}${item.reason?' · '+item.reason:''}`;li.append(text);
  if(Number.isFinite(item.seekTime)){
   const button=document.createElement('button');button.className='button secondary small-button';button.textContent='この時刻へ移動';button.disabled=state.busy;
   button.addEventListener('click',()=>{
    if(state.busy||state.result!==currentResult||state.revision!==currentRevision||lastExportBlockerReport!==report)return;
    stop();const time=Math.max(0,Math.min(state.duration||state.result.duration,item.seekTime));audio.currentTime=time;$('seekBar').value=String(time);$('currentTime').textContent=fmt(time);state.lastBeat=-1;drawWave();
   });li.append(button);
  }$('tjaBlockerRows').append(li);
 }
 if(total>50){const li=document.createElement('li');li.textContent=`表示は先頭50件です（全${total}件）。`; $('tjaBlockerRows').append(li);}
}
function updateTjaExportAction(){
 const meter=$('tjaConfirmedMeter').value||null;let eligibilityError=null;
 if(state.result&&!state.busy&&(state.result.tempoModel==='manual'||state.result.tempoModel==='constant-clock')){
  if(!tjaPreflightCache||tjaPreflightCache.result!==state.result||tjaPreflightCache.meter!==meter||tjaPreflightCache.revision!==state.revision){
   let error=null;try{error=makeCurrentTjaDraft().errors?.[0]||null;}catch(e){error=e.message||'書き出し条件を確認できません。';}
   tjaPreflightCache={result:state.result,meter,revision:state.revision,error,blockers:deriveConstantExportBlockers(state.result)};
  }eligibilityError=tjaPreflightCache.error;
 }
 const action=getTjaExportAction({result:state.result,busy:state.busy,confirmedMeter:meter,eligibilityError});
 renderExportBlockerReview(state.busy?null:tjaPreflightCache?.result===state.result?tjaPreflightCache.blockers:null);
 $('tjaMeterInline').hidden=state.result?.tempoModel!=='constant-clock';
 const node=$('tjaExportActionStatus');if(node){node.textContent=action.message;node.dataset.state=action.code;}
 $('saveTjaBtn').disabled=!action.canSave;
}
function resetTjaDraft(){
 tjaReplacement.invalidate();tjaPreflightCache=null;
 $('tjaDraftPreview').value='';$('tjaDraftMetadata').textContent='';$('tjaDraftRows').replaceChildren();$('tjaDraftWarnings').replaceChildren();
 $('tjaDraftStatus').textContent='';$('tjaSaveStatus').textContent='';updateTjaExportAction();
}
function makeCurrentTjaDraft(){return buildTimingDraft(state.result,{title:state.file?.name.replace(/\.[^.]+$/,'')||'PULSE timing draft',audioName:state.file?.name,confirmedMeter:$('tjaConfirmedMeter').value||null});}
function showTjaDraft(d,openDetails=false){
 if(openDetails)$('tjaOutputSettings').open=true;
 $('tjaDraftPreview').value=d.previewText||d.text||'';
 $('tjaDraftMetadata').textContent=d.preview?.length?`手入力用の候補（ファイルは空欄）：BPM ${d.preview[0].bpm} / OFFSET ${d.offset} / WAVE ${state.file.name}`:'';
 $('tjaDraftStatus').textContent=d.available?`${d.barCount}個の空小節。${d.omitted?.length?'省略：'+d.omitted.map(o=>`${o.start.toFixed(3)}–${o.end.toFixed(3)} 秒`).join('、')+'。':''}`:d.errors?.[0]||'この結果は書き出せません。';
 $('tjaDraftWarnings').replaceChildren();$('tjaDraftRows').replaceChildren();
 for(const message of [...(d.errors||[]),...(d.warnings||[]),...(d.omitted||[]).map(o=>`省略：${o.start}–${o.end} 秒。`)]){const li=document.createElement('li');li.textContent=message;$('tjaDraftWarnings').append(li);}
 for(const row of d.preview||[]){const tr=document.createElement('tr');for(const value of [`${row.start}–${row.end}`,String(row.bpm),String(row.encodedEnd),(row.errorSeconds*1000).toFixed(6)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('tjaDraftRows').append(tr);}
}
function freshTjaForSave(){
 let d;try{d=makeCurrentTjaDraft();}catch(error){d={available:false,errors:[error.message||'下書きを作成できませんでした。']};}
 showTjaDraft(d);updateTjaExportAction();
 if(!d.available){$('tjaSaveStatus').textContent=d.errors?.[0]||'現在の結果は保存できません。';if(state.result?.tempoModel==='constant-clock'&&!$('tjaConfirmedMeter').value)$('tjaConfirmedMeter').focus();return null;}
 return d;
}
function previewTjaDraft(){if(!state.result||state.busy)return;const d=freshTjaForSave();$('tjaOutputSettings').open=true;controls();return d;}
function requestCurrentTjaDownload(d,audioName){
 try{requestTjaDownload({text:d.text,fileName:tjaFileName(audioName),document,urlApi:URL,BlobClass:Blob,schedule:setTimeout});$('tjaSaveStatus').textContent='ダウンロードを要求しました。WindowsではCtrl+Jまたは「ダウンロード」フォルダーを確認してください。保存完了はこの画面では確認できません。';}
 catch(error){$('tjaSaveStatus').textContent='ダウンロードを開始できませんでした。ブラウザーの設定を確認してください。';}
}
$('previewTjaBtn').addEventListener('click',previewTjaDraft);
$('tjaConfirmedMeter').addEventListener('change',resetTjaDraft);
$('saveTjaBtn').addEventListener('click',()=>{
 if(state.busy||!state.result)return;
 const d=freshTjaForSave();if(d)requestCurrentTjaDownload(d,state.file.name);
});
