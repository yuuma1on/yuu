import { discoverClocks, verifySteadyClock } from './steady-clock.js?v=34';

const scales = [
  { windowSeconds: 16, strideSeconds: 4, proofs: 2, minActive: 10, checkCycles: false },
  { windowSeconds: 24, strideSeconds: 4, proofs: 2, minActive: 17, checkCycles: true },
  { windowSeconds: 12, strideSeconds: 2, proofs: 3, minActive: 7, checkCycles: true },
];

const sameRate = (a, b) => Math.abs(Math.log2(a / b)) <= .008;
const sameOctaveFamily = (a, b) => {
  const ratio = Math.log2(a / b);
  return Math.abs(ratio) <= 2.02 && Math.abs(ratio - Math.round(ratio)) <= .018;
};

// Corroborate the feature-frame clock against PCM power at the original
// analysis sample rate. A held carrier can alias into a slow feature clock.
function rawModulation(samples, sampleRate, first, last, bpm) {
  const length = last - first;
  const angle = 2 * Math.PI * (bpm / 60) / sampleRate;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const windowAngle = 2 * Math.PI / (length - 1);
  const windowCosine = Math.cos(windowAngle), windowSine = Math.sin(windowAngle);
  let real = 0, imaginary = 0, windowReal = 1, windowImaginary = 0, carrierReal = 1, carrierImaginary = 0;
  let weightSum = 0, powerSum = 0, timePower = 0, timeSquared = 0;
  let weightReal = 0, weightImaginary = 0, timeReal = 0, timeImaginary = 0;
  for (let offset = 0; offset < length; offset++) {
    const time = (offset - (length - 1) / 2) / length;
    const weight = (1 - windowReal) / 2;
    const samplePower = samples[first + offset] ** 2 * weight;
    weightSum += weight;
    powerSum += samplePower;
    timePower += time * samplePower;
    timeSquared += time * time * weight;
    real += samplePower * carrierReal;
    imaginary += samplePower * carrierImaginary;
    weightReal += weight * carrierReal;
    weightImaginary += weight * carrierImaginary;
    timeReal += time * weight * carrierReal;
    timeImaginary += time * weight * carrierImaginary;
    const nextCarrier = carrierReal * cosine - carrierImaginary * sine;
    carrierImaginary = carrierImaginary * cosine + carrierReal * sine;
    carrierReal = nextCarrier;
    const nextWindow = windowReal * windowCosine - windowImaginary * windowSine;
    windowImaginary = windowImaginary * windowCosine + windowReal * windowSine;
    windowReal = nextWindow;
  }
  if (powerSum <= 1e-10 || !weightSum || !timeSquared) return 0;
  // Subtract the projections of a constant and a slow linear level drift.
  const mean = powerSum / weightSum, slope = timePower / timeSquared;
  return Math.hypot(real - mean * weightReal - slope * timeReal,
    imaginary - mean * weightImaginary - slope * timeImaginary) / powerSum;
}

function corroborateRegion(data, region) {
  const first = Math.max(0, Math.round(region.start * data.rate));
  const last = Math.min(data.pcm.length, Math.round(region.end * data.rate));
  if (last <= first + 1) return false;
  const candidates = [region, ...region.alternatives];
  const enoughModulation = (samples, start, end, candidate) => rawModulation(samples, data.rate, start, end, candidate.bpm) >= .01;
  if (candidates.some(candidate => enoughModulation(data.pcm, first, last, candidate))) return true;

  // Equal-power changes in timbre can carry a pulse whose full-band power
  // stays flat. Check the low band and its high-frequency residual separately.
  const low = new Float64Array(last - first), high = new Float64Array(low.length);
  const alpha = 1 - Math.exp(-2 * Math.PI * 200 / data.rate);
  let firstPole = 0, secondPole = 0, thirdPole = 0, fourthPole = 0;
  for (let i = Math.max(0, first - Math.round(data.rate * .1)); i < last; i++) {
    const sample = data.pcm[i];
    firstPole += alpha * (sample - firstPole);
    secondPole += alpha * (firstPole - secondPole);
    thirdPole += alpha * (secondPole - thirdPole);
    fourthPole += alpha * (thirdPole - fourthPole);
    if (i >= first) {
      low[i - first] = fourthPole;
      high[i - first] = sample - fourthPole;
    }
  }
  return candidates.some(candidate => enoughModulation(low, 0, low.length, candidate) &&
    enoughModulation(high, 0, high.length, candidate));
}

// Count distinct complete cycles whose flux peaks support the fitted phase.
function hasOccupiedCycles(values, fps, bpm) {
  const period = fps * 60 / bpm;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let real = 0, imaginary = 0;
  for (let i = 0; i < values.length; i++) {
    const angle = 2 * Math.PI * i / period;
    const value = values[i] - mean;
    real += value * Math.cos(angle);
    imaginary += value * Math.sin(angle);
  }
  if (Math.hypot(real, imaginary) <= 1e-12) return false;
  const phase = ((Math.atan2(imaginary, real) * period / (2 * Math.PI)) % period + period) % period;
  const sorted = values.slice().sort();
  const median = sorted[Math.floor((sorted.length - 1) * .5)];
  const high = sorted[Math.floor((sorted.length - 1) * .9)];
  if (high - median <= Math.max(1e-12, high * 1e-6)) return false;
  const threshold = median + .5 * (high - median);
  let total = 0, occupied = 0;
  for (let cycle = Math.ceil((period / 2 - phase) / period), center = phase + cycle * period;
    center <= values.length - period / 2; cycle++, center = phase + cycle * period) {
    total++;
    const first = Math.max(0, Math.ceil(center - .2 * period));
    const last = Math.min(values.length - 1, Math.floor(center + .2 * period));
    for (let i = first; i <= last; i++) {
      if (values[i] >= threshold) {
        occupied++;
        break;
      }
    }
  }
  return occupied >= 8 && occupied / total >= .8;
}

function observeWindow(segment, rms, scale) {
  const block = Math.round(segment.fps);
  const activity = [];
  for (let frame = 0; frame + block <= rms.length; frame += block) {
    const chunk = rms.subarray(frame, frame + block);
    activity.push(chunk.reduce((sum, level) => sum + level, 0) / chunk.length);
  }
  // Compare against the local level so a quiet but coherent passage can count.
  const activityFloor = Math.max(.0001, Math.max(...activity) * .06);
  if (activity.some(level => level < activityFloor)) return [];

  const observations = [];
  for (const { bpm } of discoverClocks(segment, [], { limit: 14 })) {
    const clock = verifySteadyClock(segment, bpm);
    if (!clock.accepted || clock.activeWindows < scale.minActive ||
      observations.some(previous => sameRate(previous.bpm, clock.bpm))) continue;
    const bands = clock.clocks.filter(proof => proof.band < 2 && proof.globalCoherence >= .035 &&
      proof.resultant >= .85 && proof.coverage >= 2 / 3 && proof.positiveCoverage >= .83);
    const fundamental = bands.filter(proof => proof.harmonic === 1 && proof.resultant >= .95 && proof.coverage >= .82 &&
      bands.some(other => other.band !== proof.band) &&
      (!scale.checkCycles || hasOccupiedCycles(segment.bandFlux[proof.band], segment.fps, clock.bpm)));
    observations.push({
      bpm: clock.bpm,
      directStrength: Math.max(0, ...fundamental.map(proof => proof.globalCoherence * proof.coverage)),
    });
  }
  return observations;
}

function findRuns(windows, proofs, duration) {
  const runs = [];
  for (let index = proofs - 1; index < windows.length; index++) {
    const group = windows.slice(index - proofs + 1, index + 1);
    const [first, ...rest] = group;
    const matching = first.candidates.flatMap(candidate => {
      const matches = [candidate];
      for (const window of rest) {
        const match = window.candidates.find(other => sameRate(candidate.bpm, other.bpm));
        if (!match) return [];
        matches.push(match);
      }
      return [{
        bpm: matches.reduce((sum, match) => sum + match.bpm, 0) / proofs,
        strength: Math.min(...matches.map(match => match.directStrength)),
      }];
    });
    const direct = matching.filter(candidate => candidate.strength > 0).sort((a, b) => b.strength - a.strength);
    const strongest = direct[0];
    if (!strongest || direct.some(candidate => !sameOctaveFamily(strongest.bpm, candidate.bpm))) continue;

    const alternatives = matching.filter(candidate => !sameRate(strongest.bpm, candidate.bpm) && sameOctaveFamily(strongest.bpm, candidate.bpm));
    const start = first.center, end = group.at(-1).center;
    const last = runs.at(-1);
    if (last?.lastIndex === index - 1 && last.end >= start && sameRate(last.rates[0], strongest.bpm)) {
      last.end = end;
      last.lastIndex = index;
      last.rates.push(strongest.bpm);
      last.alternatives = last.alternatives.filter(candidate => alternatives.some(other => sameRate(candidate.bpm, other.bpm)));
    } else {
      runs.push({ start, end, lastIndex: index, rates: [strongest.bpm], alternatives });
    }
  }
  return runs.map(({ start, end, rates, alternatives }) => ({
    start, end: Math.min(end, duration),
    bpm: rates.reduce((sum, value) => sum + value, 0) / rates.length,
    confidence: .5, ambiguous: true, requiresReview: true,
    alternatives: alternatives.map(({ bpm }) => ({ bpm })),
    source: 'corroborated-local-periodicity',
  }));
}

/** Retain corroborated local candidates for an otherwise untracked recording.
 * These bands give evidence for repetition, without proving the beat unit or
 * suggesting a timeline through portions where the global path abstains.
 */
export async function findPartialTempoRegions(data, duration, onWindow = () => {}) {
  const { fps, count, rms, bandFlux } = data;
  if (!rms || !data.pcm || !(data.rate > 0) || bandFlux?.length < 2) return [];
  const plans = scales.map(scale => {
    const span = Math.round(fps * scale.windowSeconds);
    const stride = Math.round(fps * scale.strideSeconds);
    const windows = Math.floor((count - span) / stride) + 1;
    return { scale, span, stride, windows };
  }).filter(plan => plan.windows >= plan.scale.proofs);
  const totalWindows = plans.reduce((sum, plan) => sum + plan.windows, 0);
  let observed = 0;
  const regions = [];
  for (const { scale, span, stride } of plans) {
    const windows = [];
    for (let first = 0; first + span <= count; first += stride) {
      const last = first + span;
      const segment = { fps, count: span, bandFlux: bandFlux.map(band => band.subarray(first, last)) };
      windows.push({ center: (first + span / 2) / fps, candidates: observeWindow(segment, rms.subarray(first, last), scale) });
      observed++;
      if (observed % 4 === 0) {
        onWindow(observed / totalWindows);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // The 16-second proof takes priority. New window sizes can only add
    // disjoint partial evidence, so neither rate nor timing is extrapolated.
    for (const region of findRuns(windows, scale.proofs, duration)) {
      if (!regions.some(other => region.start < other.end && region.end > other.start) && corroborateRegion(data, region)) {
        regions.push(region);
      }
    }
  }
  return regions.sort((a, b) => a.start - b.start);
}
