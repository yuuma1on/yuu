// Representative-number display only. This module does not receive or modify
// beat timestamps, inferred tempo curves, change events, clicks, or TJA data.
export const TEMPO_DISPLAY_SCALES = Object.freeze([.5, 1, 2]);
function validateScale(scale) {
  if (!TEMPO_DISPLAY_SCALES.includes(scale)) throw new RangeError('表示倍率は0.5・1・2から選択してください。');
  return scale;
}
const positiveFinite = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function scaleTempoDisplayBpm(bpm, scale = 1) {
  validateScale(scale);
  if (!positiveFinite(bpm)) return null;
  const value = bpm * scale;
  return positiveFinite(value) ? value : null;
}

export function formatTempoDisplayBpm(value, digits = 1) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) throw new RangeError('表示桁数は0〜6の整数にしてください。');
  return positiveFinite(value) ? value.toFixed(digits) : '—';
}

export function getTempoDisplaySummary(rawBpm, scale = 1) {
  const bpm = scaleTempoDisplayBpm(rawBpm, scale);
  return { scale, bpm, text: formatTempoDisplayBpm(bpm, 2), displayOnly: true,
    alternatives: TEMPO_DISPLAY_SCALES.map(alternativeScale => {
      const value = scaleTempoDisplayBpm(rawBpm, alternativeScale);
      return { scale: alternativeScale, bpm: value, text: formatTempoDisplayBpm(value, 2) };
    }) };
}
