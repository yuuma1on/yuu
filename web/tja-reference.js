// A chart is a user-supplied reference, not independently verified audio truth.
// This module never changes automatic analysis, fits an offset, or folds BPM.
const LIMITS = Object.freeze({ text: 2_000_000, charts: 100, measures: 50_000,
  divisions: 500_000, events: 50_000, seconds: 86_400, bpm: 2_000 });
const VISUAL = new Set(['SCROLL', 'BARLINEON', 'BARLINEOFF', 'GOGOSTART', 'GOGOEND', 'LYRIC']);
const fail = (message, line) => { throw new Error(`${line ? `${line}行目: ` : ''}${message}`); };
const number = (value, label, line) => {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(value).trim())) fail(`${label}の数値が不正です。`, line);
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${label}の数値が不正です。`, line);
  return n;
};
const tempo = (value, line) => {
  const n = number(value, 'BPM', line);
  if (!(n > 0 && n <= LIMITS.bpm)) fail(`BPMは0より大きく${LIMITS.bpm}以下にしてください。`, line);
  return n;
};
function scan(text) {
  if (typeof text !== 'string' || text.length > LIMITS.text) fail('TJAは200万文字以内のテキストにしてください。');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/), charts = [];
  if (lines.length > 200_000) fail('TJAの行数が多すぎます。');
  let metadata = {}, active = null;
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1, content = lines[index].split('//')[0].trim();
    if (!content) continue;
    if (/^#START(?:\s|$)/i.test(content)) {
      if (active) fail('#STARTが重複しています。', line);
      const player = content.replace(/^#START/i, '').trim().toUpperCase();
      if (player && !['P1', 'P2'].includes(player)) fail('#STARTのプレイヤー指定に対応していません。', line);
      if (charts.length >= LIMITS.charts) fail('譜面数が多すぎます。', line);
      active = { id: `chart-${charts.length + 1}`, metadata: { ...metadata }, player, line, rows: [] };
      continue;
    }
    if (/^#END(?:\s|$)/i.test(content)) {
      if (!active || content.toUpperCase() !== '#END') fail('#ENDが不正です。', line);
      charts.push(active); active = null; continue;
    }
    if (active) active.rows.push({ content, line });
    else {
      const match = /^([A-Z][A-Z0-9]*):\s*(.*)$/i.exec(content);
      if (match) metadata[match[1].toUpperCase()] = match[2].trim();
      else if (content.startsWith('#')) fail('譜面外の命令には対応していません。', line);
      else fail('譜面外の記述を解釈できません。', line);
    }
  }
  if (active) fail('#ENDがありません。', active.line);
  if (!charts.length) fail('#STARTから#ENDまでの譜面がありません。');
  return charts;
}
function summary(chart) {
  return { id: chart.id, course: chart.metadata.COURSE || '未指定', player: chart.player,
    title: chart.metadata.TITLE || '', wave: chart.metadata.WAVE || '' };
}
export function listTjaCharts(text) { return scan(text).map(summary); }

export function parseTjaReference(text, options = {}) {
  const charts = scan(text);
  if (charts.length > 1 && !options.chartId) fail('複数の譜面があります。難易度・プレイヤーを選択してください。');
  const chart = options.chartId ? charts.find(c => c.id === options.chartId) : charts[0];
  if (!chart) fail('選択した譜面が見つかりません。');
  const header = chart.metadata;
  if (!header.BPM) fail('BPMヘッダーがありません。', chart.line);
  let bpm = tempo(header.BPM, chart.line);
  const offset = number(header.OFFSET ?? '0', 'OFFSET', chart.line);
  if (Math.abs(offset) > LIMITS.seconds) fail('OFFSETが対応範囲を超えています。', chart.line);
  let time = -offset, correction = 0, quarterNote = 0, quarterCorrection = 0, measure = 1, bar = [], divisions = 0, measures = 0, noteCount = 0;
  let firstNote = null, lastNote = null;
  const events = [{ time, bpm, quarterNote, line: chart.line, bar: 1, noteIndex: 0, division: 0, initial: true }];
  function advance(seconds, line, quarters) {
    const adjustedQuarter = quarters - quarterCorrection, nextQuarter = quarterNote + adjustedQuarter;
    quarterCorrection = (nextQuarter - quarterNote) - adjustedQuarter; quarterNote = nextQuarter;
    const corrected = seconds - correction, next = time + corrected;
    correction = (next - time) - corrected; time = next;
    if (!Number.isFinite(time) || time + offset > LIMITS.seconds) fail('譜面の長さが24時間を超えています。', line);
  }
  function command(value, line, seen, count, trailing = false) {
    const match = /^#([A-Z][A-Z0-9]*)(?:\s+(.*))?$/i.exec(value);
    if (!match) fail('命令の形式が不正です。', line);
    const name = match[1].toUpperCase(), argument = (match[2] || '').trim();
    // Normal-scroll mode resets presentation only; it does not advance the
    // chart clock or alter BPM, measure length, or note division.
    if (name === 'NMSCROLL') {
      if (argument) fail('#NMSCROLLには引数を指定できません。', line);
      return;
    }
    if (VISUAL.has(name)) return;
    if (trailing) fail('末尾の時間命令は、カンマで終わる小節内に記述してください。', line);
    if (name === 'BPMCHANGE') {
      bpm = tempo(argument, line);
      if (events.length >= LIMITS.events) fail('BPM変更が多すぎます。', line);
      events.push({ time, bpm, quarterNote, line, bar: measures + 1, noteIndex: seen, division: count });
    } else if (name === 'MEASURE') {
      if (seen) fail('小節途中の#MEASUREには対応していません。', line);
      const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(argument);
      if (!fraction) fail('#MEASUREは正の整数の分数で指定してください。', line);
      const numerator = Number(fraction[1]), denominator = Number(fraction[2]);
      if (!(numerator >= 1 && numerator <= 1e6 && denominator >= 1 && denominator <= 1e6)) fail('#MEASUREの分子・分母が対応範囲外です。', line);
      measure = numerator / denominator;
      if (measure > 64) fail('#MEASUREが大きすぎます。', line);
    } else {
      // Fail closed: branch, delay, stop, time-signature extensions and unknown
      // commands must not silently produce a plausible but wrong timeline.
      fail(`#${name}には対応していません。分岐・遅延を含む譜面は比較できません。`, line);
    }
  }
  function finish(line) {
    if (measures >= LIMITS.measures) fail('小節数が多すぎます。', line);
    const count = bar.reduce((n, item) => n + (item.kind === 'notes' ? item.value.length : 0), 0);
    let seen = 0;
    for (const item of bar) {
      if (item.kind === 'command') command(item.value, item.line, seen, count);
      else for (const symbol of item.value) {
        if (symbol !== '0') {
          const note = { time, symbol }; firstNote ??= note; lastNote = note; noteCount++;
        }
        advance(240 * measure / bpm / count, item.line, 4 * measure / count); seen++;
      }
    }
    if (!count) advance(240 * measure / bpm, line, 4 * measure);
    measures++; bar = [];
  }
  for (const row of chart.rows) {
    const { content, line } = row;
    if (content.startsWith('#')) { bar.push({ kind: 'command', value: content, line }); continue; }
    const chunks = content.replace(/\s/g, '').split(',');
    for (let i = 0; i < chunks.length; i++) {
      const value = chunks[i];
      if (value) {
        if (!/^[0-9AB]+$/i.test(value)) fail('未対応の音符・譜面記述があります。', line);
        divisions += value.length;
        if (divisions > LIMITS.divisions) fail('音符・分割数が多すぎます。', line);
        bar.push({ kind: 'notes', value: value.toUpperCase(), line });
      }
      if (i < chunks.length - 1) finish(line);
    }
  }
  if (bar.some(item => item.kind === 'notes')) fail('最後の小節をカンマで閉じてください。', bar.at(-1).line);
  for (const item of bar) command(item.value, item.line, 0, 0, true);
  if (!measures) fail('譜面に小節がありません。', chart.line);
  return { ...summary(chart), offset, startTime: -offset, initialBpm: events[0].bpm,
    events, firstNote, lastNote, end: time, endQuarterNote: quarterNote, measures, noteCount, divisions,
    referenceOnly: true, warnings: ['譜面を比較用の基準として使用します。音源との一致や正しさを保証するものではありません。',
      'OFFSETは譜面の指定値です。自動同期・自動補正は行いません。'] };
}

export function compareTjaReference(reference, result, options = {}) {
  const tolerance = options.tolerance ?? .01;
  if (!(Number.isFinite(tolerance) && tolerance > 0 && tolerance <= .25)) fail('比較の許容誤差が不正です。');
  if (!result || !Number.isFinite(result.duration) || result.duration <= 0 || !Array.isArray(result.tempoCurve)) fail('音源の解析結果がありません。');
  if (!reference || !Array.isArray(reference.events) || !reference.events.length) fail('譜面のテンポ情報がありません。');
  const events = reference.events;
  if (events.some((e, i) => !Number.isFinite(e.time) || !(e.bpm > 0 && Number.isFinite(e.bpm)) || (i && e.time < events[i - 1].time))) fail('譜面のテンポ情報が不正です。');
  const curve = result.tempoCurve;
  if (curve.some((p, i) => !Number.isFinite(p.time) || (i && p.time <= curve[i - 1].time))) fail('解析曲線の時刻が不正です。');
  const start = Math.max(0, reference.firstNote?.time ?? 0), end = Math.min(result.duration, reference.lastNote?.time ?? 0);
  if (!reference.firstNote || !reference.lastNote || !(end > start)) return { available: false, reason: '比較できる音符区間がありません。', tolerance };
  const duration = end - start;
  let supported = 0, matching = 0;
  const eventAt = time => {
    let low = 0, high = events.length;
    while (low < high) { const middle = (low + high) >> 1; if (events[middle].time <= time) low = middle + 1; else high = middle; }
    return Math.max(0, low - 1);
  };
  for (let i = 0; i < curve.length; i++) {
    const point = curve[i];
    const a = Math.max(start, i ? (curve[i - 1].time + point.time) / 2 : point.time);
    const b = Math.min(end, i + 1 < curve.length ? (point.time + curve[i + 1].time) / 2 : point.time);
    if (!(b > a) || !(Number.isFinite(point.bpm) && point.bpm > 0)) continue;
    supported += b - a;
    let at = a, index = eventAt(a);
    while (at < b) {
      const next = Math.min(b, index + 1 < events.length ? events[index + 1].time : b);
      if (next > at && Math.abs(point.bpm / events[index].bpm - 1) <= tolerance + 8 * Number.EPSILON) matching += next - at;
      if (next >= b) break;
      at = next; index++;
    }
  }
  // All-time denominator includes unknown BPM and unobserved boundary regions.
  return { available: true, tolerance, start, end, duration,
    supportedSeconds: supported, unsupportedSeconds: Math.max(0, duration - supported), matchingSeconds: matching,
    coveragePercent: 100 * supported / duration, directAgreementPercent: 100 * matching / duration,
    supportedOnlyAgreementPercent: supported ? 100 * matching / supported : null,
    referenceChangeCount: events.slice(1).filter(e => e.time >= start && e.time <= end).length,
    automaticChangeCount: Array.isArray(result.tempoChanges) ? result.tempoChanges.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end >= start && c.start <= end).length : 0,
    automaticTotalChangeCount: Array.isArray(result.tempoChanges) ? result.tempoChanges.length : 0,
    countScope: 'evaluation-window',
    offsetFitted: false, octaveFolded: false, referenceOnly: true };
}


/** Uniform quarter-note reference clicks. This is chart-driven audition, not
 * audio inference, bar/downbeat detection, or timing alignment. Tiny measures
 * do not create extra clicks: one continuous musical phase spans all measures.
 * Returned pulses lie in [0, min(duration, reference.end)); the endpoint is not
 * played. Reparse legacy references that lack musical quarter-note positions.
 */
export function generateTjaReferenceBeats(reference, options = {}) {
  const duration = options.duration;
  if (!(Number.isFinite(duration) && duration > 0 && duration <= LIMITS.seconds)) fail('試聴する音源の長さが不正、または24時間を超えています。');
  if (!reference || !Array.isArray(reference.events) || !reference.events.length || reference.events.length > LIMITS.events ||
      !Number.isFinite(reference.end) || !Number.isFinite(reference.endQuarterNote) || reference.endQuarterNote < 0) {
    fail('譜面の拍位置情報がありません。TJAを読み込み直してください。');
  }
  const events = reference.events, maxBeats = 100_000;
  const qEpsilon = q => 32 * Number.EPSILON * Math.max(1, Math.abs(q));
  const timeEpsilon = 1e-9;
  if (events[0].quarterNote !== 0) fail('譜面の開始拍位置が不正です。');
  for (let i = 0; i < events.length; i++) {
    const event = events[i], next = events[i + 1];
    const nextTime = next ? next.time : reference.end, nextQuarter = next ? next.quarterNote : reference.endQuarterNote;
    if (!Number.isFinite(event.time) || !Number.isFinite(event.quarterNote) || event.quarterNote < 0 ||
        !(Number.isFinite(event.bpm) && event.bpm > 0 && event.bpm <= LIMITS.bpm) ||
        !Number.isFinite(nextTime) || !Number.isFinite(nextQuarter) || nextTime < event.time || nextQuarter < event.quarterNote) {
      fail('譜面の拍位置・テンポの順序が不正です。');
    }
    const predictedSpan = (nextQuarter - event.quarterNote) * 60 / event.bpm, span = nextTime - event.time;
    if (Math.abs(predictedSpan - span) > 1e-7 + 1e-10 * Math.max(predictedSpan, span)) fail('譜面の拍位置と時刻が一致しません。TJAを読み込み直してください。');
  }
  const chartSpan = reference.end - events[0].time;
  if (!(chartSpan >= 0 && chartSpan <= LIMITS.seconds + 1e-7) || Math.abs(events[0].time) > LIMITS.seconds) fail('譜面の時間範囲が不正です。');
  const clipEnd = Math.min(duration, reference.end), beats = [];
  if (!(clipEnd > 0)) return beats;
  for (let i = 0; i < events.length; i++) {
    const event = events[i], next = events[i + 1];
    const segmentEnd = Math.min(clipEnd, next ? next.time : reference.end);
    const segmentStart = Math.max(0, event.time);
    if (!(segmentEnd > segmentStart)) continue;
    const firstPosition = event.quarterNote + (segmentStart - event.time) * event.bpm / 60;
    const endPosition = event.quarterNote + (segmentEnd - event.time) * event.bpm / 60;
    const first = Math.max(0, Math.ceil(firstPosition - qEpsilon(firstPosition)));
    const afterLast = Math.ceil(endPosition - qEpsilon(endPosition));
    if (beats.length + Math.max(0, afterLast - first) > maxBeats) fail('参照クリックが10万拍を超えています。短い音源で比較してください。');
    for (let quarter = first; quarter < afterLast; quarter++) {
      let time = event.time + (quarter - event.quarterNote) * 60 / event.bpm;
      if (time < -timeEpsilon || time >= clipEnd - timeEpsilon) continue;
      if (Math.abs(time) < timeEpsilon) time = 0;
      // Segment ownership is half-open, so a tempo command exactly on a pulse
      // assigns that pulse to the new tempo and never produces duplicates.
      if (beats.length && (quarter <= beats.at(-1).quarterNote || time <= beats.at(-1).time)) fail('参照クリックの拍位置が重複しています。');
      beats.push({ time, quarterNote: quarter, bpm: event.bpm, source: 'tja-reference' });
    }
  }
  return beats;
}
