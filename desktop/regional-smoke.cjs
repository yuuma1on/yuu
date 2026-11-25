// Loaded only for the explicit packaged-app smoke CLI. This fixture contains no
// music, reference labels, or external files: it is generated deterministically.
function createSyntheticRegionalWav(){
 const rate=8000,duration=70,samples=new Float32Array(duration*rate);let seed=0x462198,noise=0;
 const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let i=0;i<samples.length;i++){noise=.75*noise+.25*(2*random()-1);samples[i]=.012*noise;}
 for(let time=.1;time<duration-.1;time+=.10+.74*random()){
  const amplitude=.58*(.3+.7*random()),frequency=65+185*random(),decay=.008+.035*random(),mid=.1+.5*random(),start=Math.round(time*rate);
  for(let i=0;i<.09*rate&&start+i<samples.length;i++){const t=i/rate,envelope=(1-Math.exp(-t/.00035))*Math.exp(-t/decay);samples[start+i]+=amplitude*envelope*(Math.sin(2*Math.PI*frequency*t)+mid*Math.sin(2*Math.PI*523*t)+.1*(2*random()-1));}
 }
 for(let i=24*rate;i<46*rate;i++){
  const t=i/rate-24,fade=Math.min(1,t/.25,(22-t)/.25),clock=(t-.143)*173.125/60,modulation=.16+.84*((1+Math.cos(2*Math.PI*clock))/2)**3;
  samples[i]=.00025*fade*modulation*(Math.sin(2*Math.PI*99*t)+.42*Math.sin(2*Math.PI*701*t));
 }
 const bytes=new Uint8Array(56+samples.length*4),view=new DataView(bytes.buffer);
 const text=(at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i);};
 text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,32,true);
 text(36,'fact');view.setUint32(40,4,true);view.setUint32(44,samples.length,true);text(48,'data');view.setUint32(52,samples.length*4,true);
 for(let i=0;i<samples.length;i++)view.setFloat32(56+i*4,samples[i],true);
 return bytes;
}

function createSyntheticReferenceTja(){
 return 'TITLE:Synthetic\nBPM:173.125\nWAVE:synthetic-regional.wav\nOFFSET:0\nCOURSE:Oni\nLEVEL:1\n#START\n'+Array(54).fill('1000,').join('\n')+'\n#END';
}

async function rendererSmoke(createWav,createReference){
 const $=id=>{const node=document.getElementById(id);if(!node)throw new Error('Missing smoke control: '+id);return node;};
 const expect=(value,message)=>{if(!value)throw new Error(message);};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const basic={nodeAvailable:typeof process!=='undefined',secureContext:window.isSecureContext,workerAvailable:typeof Worker==='function',desktopBridge:typeof window.pulseDesktop?.getUpdateState==='function'};
 const state=await window.pulseDesktop.getUpdateState();
 expect(!basic.nodeAvailable&&basic.secureContext&&basic.workerAvailable&&basic.desktopBridge,'Renderer isolation or secure context failed');
 const displayedVersion=$('pulseDesktopVersion').checkVisibility()?$('pulseDesktopVersion').textContent:null;
 expect(displayedVersion==='v'+state.appVersion,'Installed version is not visibly displayed');
 let exportPromise=null,tjaDownloads=0;
 const originalClick=HTMLAnchorElement.prototype.click;
 HTMLAnchorElement.prototype.click=function(){
  if(this.download==='synthetic-regional.rhythm.json'&&this.href.startsWith('blob:'+location.origin+'/')){exportPromise=fetch(this.href).then(response=>response.json());return;}
  if(/\.tja$/i.test(this.download)){tjaDownloads++;return;}
  return originalClick.call(this);
 };
 const values=[],progress=$('progressBar');
 const observer=new MutationObserver(records=>{for(const record of records){if(record.oldValue!==null)values.push(Number(record.oldValue));}values.push(Number(progress.getAttribute('aria-valuenow')));});
 observer.observe(progress,{attributes:true,attributeFilter:['aria-valuenow'],attributeOldValue:true});
 try{
  const wav=createWav(),transfer=new DataTransfer();transfer.items.add(new File([wav],'synthetic-regional.wav',{type:'audio/wav'}));
  $('fileInput').files=transfer.files;$('fileInput').dispatchEvent(new Event('change',{bubbles:true}));
  expect(!$('analyzeBtn').disabled,'Synthetic WAV was not accepted by the normal file input');
  $('analyzeBtn').click();
  const deadline=performance.now()+120000;
  while(performance.now()<deadline&&($('results').hidden||$('analyzeBtn').disabled||!$('progressPanel').hidden))await pause(100);
  expect(!$('results').hidden&&!$('analyzeBtn').disabled&&$('progressPanel').hidden,'Normal WebAudio/Worker analysis timed out');
  $('exportBtn').click();expect(exportPromise,'Normal JSON export was not requested');const result=await exportPromise;
  expect(result.tempoModel==='regional-candidates'&&result.bpm===null,'Expected a partial regional result with unknown whole-track BPM');
  for(const key of ['beats','sections','tempoCurve','tempoChanges'])expect(Array.isArray(result[key])&&result[key].length===0,'Partial result fabricated '+key);
  expect(result.tempoRegions.length>0,'No regional candidate was recovered');
  expect(result.tempoRegions.some(region=>[region,...(region.alternatives||[])].some(candidate=>Math.abs(candidate.bpm-173.125)<.6)),'Known synthetic local cycle was not represented');
  expect(result.tempoRegions.every(region=>region.ambiguous&&region.requiresReview&&region.start>=24&&region.end<=46&&region.end>region.start),'Regional uncertainty or acoustic bounds were lost');
  expect($('bpmValue').textContent==='—'&&!$('tempoRegionsPanel').hidden&&$('tempoRegionsList').children.length===result.tempoRegions.length,'Regional candidate rows or unknown BPM are missing');
  expect(!$('trackMeta').textContent.includes('0拍を検出')&&$('halfTempoBtn').disabled&&$('doubleTempoBtn').disabled,'Partial result offers a fabricated whole-track beat interpretation');
  const audition=$('tempoRegionsList').querySelector('button');expect(audition&&!audition.disabled,'Candidate audition is unavailable');audition.click();await pause(50);
  expect(Number($('seekBar').value)>0&&$('loopBtn').getAttribute('aria-pressed')==='false','Candidate audition did not seek to its actual audio region');
  if($('playBtn').getAttribute('aria-label')==='一時停止')$('playBtn').click();
  $('referenceText').value=createReference();
  $('readReference').click();await pause(100);
  $('tjaConfirmedMeter').value='4/4';$('tjaConfirmedMeter').dispatchEvent(new Event('change',{bubbles:true}));
  $('previewTjaBtn').click();$('saveTjaBtn').click();await pause(50);
  expect($('tjaExportActionStatus').dataset.state==='regional-candidates-unconfirmed','Meter or reference unlocked a partial TJA');
  expect($('tjaDraftPreview').value===''&&$('tjaSaveStatus').textContent.includes('局所の周期候補')&&tjaDownloads===0,'Partial result generated or requested an unsupported TJA');
  exportPromise=null;$('exportBtn').click();expect(exportPromise,'Post-reference export was not requested');const afterReference=await exportPromise;
  expect(afterReference.referenceComparison?.source==='user-supplied TJA; not automatic inference','Synthetic reference was not actually loaded');
  const inference=value=>{const {analyzedAt,referenceComparison,...unchanged}=value;return JSON.stringify(unchanged);};
  expect(inference(afterReference)===inference(result),'Reference or meter mutated the original inference export');
  const comparison=afterReference.referenceComparison.comparison;
  expect(comparison?.available&&Array.isArray(comparison.localCandidateRegions),'Synthetic reference did not expose its actual local candidate comparison');
  const matchedRegion=comparison.localCandidateRegions.find(region=>region.start===32&&region.end===36);
  const matchedCandidate=matchedRegion?.candidates.find(candidate=>Math.abs(candidate.bpm-173.125)<.6);
  expect(matchedCandidate?.matchingSeconds===4,'Expected synthetic local candidate did not match the actual 32–36s span');
  expect(matchedRegion.candidates.filter(candidate=>candidate!==matchedCandidate).every(candidate=>candidate.matchingSeconds===0),'Reference comparison silently folded a beat-unit alternative');
  expect(comparison.supportedSeconds===0&&comparison.matchingSeconds===0&&comparison.coveragePercent===0&&comparison.directAgreementPercent===0&&comparison.supportedOnlyAgreementPercent===null&&comparison.unsupportedSeconds===comparison.duration,'Local reference match inflated full-track inference coverage or agreement');
  expect(comparison.offsetFitted===false&&comparison.octaveFolded===false&&comparison.referenceOnly===true,'Reference comparison adjusted timing or reinterpreted pulse units');
  const summary=$('referenceSummary'),row=[...summary.querySelectorAll('li')].find(item=>item.textContent.includes('0:32.000')&&item.textContent.includes('0:36.000'));
  expect(!summary.hidden&&summary.textContent.includes('曲全体のBPMは未推定')&&summary.textContent.includes('局所の周期候補')&&row?.textContent.includes(matchedCandidate.bpm.toFixed(2)+' BPM（4.000秒）'),'Actual local reference span, seconds, or two-decimal candidate BPM is missing from the UI');
  expect(values.length>=4&&values.every((value,index)=>Number.isFinite(value)&&value>=0&&value<=100&&(!index||value>=values[index-1])),'Analysis progress is invalid or moved backward');
  return {ok:true,...basic,appVersion:state.appVersion,displayedVersion,regionalCandidates:result.tempoRegions.length,wholeTrackBpm:null,fullTrackTimingEmpty:true,tjaGuarded:true,tjaDownloads,referenceDidNotMutateAnalysis:true,localReferenceMatched:true,localReferenceMatchingSeconds:matchedCandidate.matchingSeconds,referenceComparisonVisible:true,wholeTrackCoveragePercent:comparison.coveragePercent,wholeTrackDirectAgreementPercent:comparison.directAgreementPercent,auditionSeeked:true,progressMonotonic:true,fixture:{kind:'generated-interrupted-body-clock',duration:70,sampleRate:8000,wavBytes:wav.length,referenceMeasures:54}};
 }finally{observer.disconnect();HTMLAnchorElement.prototype.click=originalClick;}
}

async function runRegionalSmoke(webContents){
 return webContents.executeJavaScript(`(${rendererSmoke.toString()})(${createSyntheticRegionalWav.toString()},${createSyntheticReferenceTja.toString()})`,true);
}
module.exports={runRegionalSmoke,createSyntheticRegionalWav,createSyntheticReferenceTja};
