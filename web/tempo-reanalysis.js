const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;

// Full-source reanalysis scales the original audio path. A manually edited
// representative BPM cannot become its reference without changing that path.
export function getTempoReanalysis(result,ratio=1){
  if(!result||!positive(ratio))return null;
  const manual=result.tempoModel==='manual'||result.manual===true||result.sections?.some(section=>section.manual===true);
  const scale=positive(result.tempoScale)?result.tempoScale:1;
  const base=manual&&positive(result.automaticBpm)?result.automaticBpm*scale:result.bpm;
  const bpm=base*ratio,tempoScale=scale*ratio;
  return positive(bpm)&&positive(tempoScale)?{bpm,tempoScale,manual:!!manual}:null;
}
