import { analyzeAudio } from './analysis.js?v=33';
self.onmessage = async ({data}) => {
  try {
    const result = await analyzeAudio(data.samples, data.sampleRate, data.options,
      progress => self.postMessage({type:'progress', ...progress}));
    self.postMessage({type:'result', result});
  } catch (error) {
    self.postMessage({type:'error', message:error.message || '音源を解析できませんでした。'});
  }
};
