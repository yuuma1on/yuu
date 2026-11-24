const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Candidate periods come from consecutive observed onsets, rather than from
// multiplying a prior BPM or selecting a harmonic of a melodic spectral line.
function observedPeriods(events, fps, options) {
  const candidates = [];
  for (let start = 0; start + 4 < events.length; start++) {
    for (let count = 5; count <= Math.min(10, events.length - start); count++) {
      const run = events.slice(start, start + count), span = run.at(-1).frame - run[0].frame;
      if (span + 1 < fps * (options.minSpan ?? .8)) continue;
      const intervals = run.slice(1).map((event, index) => event.frame - run[index].frame);
      const period = median(intervals);
      if (!(period > 0) || intervals.some(value => Math.abs(value - period) > Math.max(1, period * (options.maxIntervalScatter ?? .10)))) continue;
      const middle = (count - 1) / 2, origin = run[0].frame;
      const mean = run.reduce((sum, event) => sum + event.frame - origin, 0) / count;
      let xx = 0, xy = 0;
      for (let i = 0; i < count; i++) { xx += (i - middle) ** 2; xy += (i - middle) * (run[i].frame - origin - mean); }
      const fitted = xy / xx;
      const residual = Math.sqrt(run.reduce((sum, event, index) =>
        sum + (event.frame - origin - mean - fitted * (index - middle)) ** 2, 0) / count);
      if (residual > (options.maxResidualFrames ?? .55)) continue;
      const bpm = fps * 60 / fitted;
      if (bpm < (options.minBpm ?? 35) || bpm > (options.maxBpm ?? 1200)) continue;
      candidates.push({ bpm, count, span: span / fps, residualFrames: residual,
        firstFrame: run[0].frame, lastFrame: run.at(-1).frame,
        intervalScatter: Math.max(...intervals.map(value => Math.abs(value / fitted - 1))) });
    }
  }
  return candidates;
}

function expandObservedRun(proposal, events, fps, options) {
  let first = events.findIndex(event => event.frame === proposal.firstFrame);
  let last = events.findIndex(event => event.frame === proposal.lastFrame);
  if (first < 0 || last < first) return null;
  const period = fps * 60 / proposal.bpm;
  const tolerance = Math.max(1, period * (options.maxIntervalScatter ?? .10));
  while (first > 0 && Math.abs(events[first].frame - events[first - 1].frame - period) <= tolerance) first--;
  while (last + 1 < events.length && Math.abs(events[last + 1].frame - events[last].frame - period) <= tolerance) last++;
  const run = events.slice(first, last + 1), count = run.length, middle = (count - 1) / 2;
  const origin = run[0].frame, mean = run.reduce((sum, event) => sum + event.frame - origin, 0) / count;
  let xx = 0, xy = 0;
  for (let i = 0; i < count; i++) { xx += (i - middle) ** 2; xy += (i - middle) * (run[i].frame - origin - mean); }
  const fitted = xy / xx;
  const residual = Math.sqrt(run.reduce((sum, event, index) =>
    sum + (event.frame - origin - mean - fitted * (index - middle)) ** 2, 0) / count);
  if (!(fitted > 0) || residual > (options.maxResidualFrames ?? .55)) return null;
  return { ...proposal, bpm: fps * 60 / fitted, count, residualFrames: residual,
    firstFrame: run[0].frame, lastFrame: run.at(-1).frame,
    span: (run.at(-1).frame - run[0].frame) / fps };
}

/** Short, directly filled body clocks can resolve an alias in an already
 * variable track. This evidence must not override a verified whole-track clock.
 * The lowest material band's events and the pooled body events must agree.
 */
export function estimateDirectBodyClocks(data, { gridFit }, options = {}) {
  const fps = data.fps, duration = data.count / fps;
  const stride = options.strideSeconds ?? .25, window = options.windowSeconds ?? 1.8;
  const body = data.bodyEvents || [], anchor = data.fastAnchorEvents || [];
  const windows = [], runs = [];
  const assess = proposal => {
    const period = fps * 60 / proposal.bpm;
    const first = Math.max(0, Math.floor(proposal.firstFrame - period * .12));
    const last = Math.min(data.count, Math.ceil(proposal.lastFrame + period * .12) + 1);
    const pooled = gridFit(body.filter(event => event.frame >= first && event.frame < last), first, last, period, .5);
    const lowest = anchor.filter(event => event.frame >= first && event.frame < last);
    const low = gridFit(lowest, first, last, period, .5);
    // A long run can alternate loud and quiet instruments. Count actual filled
    // lowest-band slots as well as their weighted strength; a half-empty fast
    // grid cannot pass this check. The initial short-window proof is unchanged.
    const slotCoverage = gridFit(lowest.map(event => ({frame:event.frame,weight:1})), first, last, period, .5).occupancy;
    const strength = Math.min(pooled.capture, pooled.occupancy, low.capture, slotCoverage);
    if (strength < (options.minGridSupport ?? .85) || slotCoverage < (options.minAnchorSlotCoverage ?? .90) ||
      low.occupancy < (options.minAnchorWeightedOccupancy ?? .75)) return null;
    return { ...proposal, strength, bodyCapture: pooled.capture, bodyOccupancy: pooled.occupancy,
      anchorCapture: low.capture, anchorOccupancy: low.occupancy, anchorSlotCoverage:slotCoverage };
  };
  // Probe long observed runs directly: five slow attacks cannot fit inside
  // the ordinary short window. This changes no evidence/occupancy threshold.
  const slowOptions = {...options, maxBpm:Math.min(options.maxBpm ?? 1200, 240 / window)};
  const extendedProposals = [
    ...observedPeriods(body, fps, slowOptions).map(proposal => ({...proposal, stream:'body'})),
    ...observedPeriods(anchor, fps, slowOptions).map(proposal => ({...proposal, stream:'anchor'})),
  ].filter(proposal => proposal.bpm < 240 / window);
  extendedProposals.sort((a,b) => b.count-a.count || a.residualFrames-b.residualFrames);
  for(const proposal of extendedProposals){
    if(runs.some(run => run.stream===proposal.stream && run.firstFrame<=proposal.firstFrame &&
      run.lastFrame>=proposal.lastFrame && Math.abs(Math.log2(run.bpm/proposal.bpm))<.03))continue;
    const expanded=expandObservedRun(proposal,proposal.stream==='body'?body:anchor,fps,options);
    const run=expanded?assess(expanded):null;
    if(run)runs.push(run);
  }
  for (let time = 0; time < duration; time += stride) {
    const first = Math.max(0, Math.round((time - window / 2) * fps));
    const last = Math.min(data.count, Math.round((time + window / 2) * fps));
    const inside = body.filter(event => event.frame >= first && event.frame < last);
    const lowest = anchor.filter(event => event.frame >= first && event.frame < last);
    const proposals = [...observedPeriods(inside, fps, options).map(p => ({ ...p, stream: 'body' })),
      ...observedPeriods(lowest, fps, options).map(p => ({ ...p, stream: 'anchor' }))];
    proposals.sort((a, b) => b.count - a.count || a.residualFrames - b.residualFrames);
    const candidates = [];
    for (const proposal of proposals) {
      if (candidates.some(candidate => Math.abs(Math.log2(candidate.bpm / proposal.bpm)) < .012)) continue;
      const period = fps * 60 / proposal.bpm;
      const pooled = gridFit(inside, first, last, period, .5);
      const low = gridFit(lowest, first, last, period, .5);
      const strength = Math.min(pooled.capture, pooled.occupancy, low.capture, low.occupancy);
      if (strength < (options.minGridSupport ?? .85)) continue;
      const cached = runs.find(run => run.stream === proposal.stream && run.firstFrame <= proposal.firstFrame &&
        run.lastFrame >= proposal.lastFrame && Math.abs(Math.log2(run.bpm / proposal.bpm)) < .03);
      let run = cached;
      if (!run) {
        const expanded = expandObservedRun(proposal, proposal.stream === 'body' ? body : anchor, fps, options);
        run = expanded ? assess(expanded) : null;
        if (run && !runs.some(previous => Math.abs(Math.log2(previous.bpm / run.bpm)) < .012 &&
          previous.firstFrame <= run.firstFrame && previous.lastFrame >= run.lastFrame)) runs.push(run);
      }
      candidates.push(run || { ...proposal, strength, bodyCapture: pooled.capture, bodyOccupancy: pooled.occupancy,
        anchorCapture: low.capture, anchorOccupancy: low.occupancy });
    }
    candidates.sort((a, b) => b.strength - a.strength || b.count - a.count);
    const best = candidates[0];
    windows.push({ time, frame: time * fps, bpm: best?.bpm ?? null, supported: !!best,
      coherence: best?.strength ?? 0, source: 'direct-regular-body-clock',
      ...(best ? { onsetCount: best.count, observedSpan: best.span,
        fitResidualMs: best.residualFrames / fps * 1000,
        bodyCapture: best.bodyCapture, bodyOccupancy: best.bodyOccupancy,
        anchorCapture: best.anchorCapture, anchorOccupancy: best.anchorOccupancy } : {}) });
  }
  const observedRuns = runs.map(run => ({ start: run.firstFrame / fps, end: run.lastFrame / fps,
    bpm: run.bpm, supported: true, coherence: run.strength, onsetCount: run.count,
    observedSpan: run.span, fitResidualMs: run.residualFrames / fps * 1000,
    bodyCapture: run.bodyCapture, bodyOccupancy: run.bodyOccupancy,
    anchorCapture: run.anchorCapture, anchorOccupancy: run.anchorOccupancy,
    anchorSlotCoverage: run.anchorSlotCoverage,
    source: 'direct-regular-body-clock' })).sort((a, b) => a.start - b.start || b.coherence - a.coherence);
  const evidenceAtFrame = frame => {
    const time = frame / fps;
    const observed = observedRuns.filter(run => time >= run.start && time < run.end)
      .sort((a, b) => b.coherence - a.coherence || b.onsetCount - a.onsetCount)[0];
    if (observed) return { ...observed, time, frame, runStart: observed.start, runEnd: observed.end };
    return windows[clamp(Math.round(frame / fps / stride), 0, windows.length - 1)] ||
      { bpm: null, supported: false, coherence: 0, source: 'direct-regular-body-clock' };
  };
  const curve = windows.map(point => ({ ...evidenceAtFrame(point.frame), time: point.time, frame: point.frame }));
  return { curve, runs: observedRuns, evidenceAtFrame, method: 'observed regular onsets / pooled and lowest-band filled grids' };
}
