const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function midiFrequency(midi, referencePitch = 440) {
  return referencePitch * 2 ** ((midi - 69) / 12);
}

// AnalyserNode supplies a Blackman-windowed spectrum in dB. Interpolating local
// maxima avoids requiring a piano partial to land on the centre of an FFT bin.
function peakAt(spectrum, frequency, binHz, toleranceCents) {
  const centre = frequency / binHz;
  const radius = Math.max(1.5, centre * (2 ** (toleranceCents / 1200) - 1));
  const start = Math.max(2, Math.floor(centre - radius));
  const end = Math.min(spectrum.length - 3, Math.ceil(centre + radius));
  let best = { db: -140, frequency: 0, prominence: 0 };
  for (let index = start; index <= end; index++) {
    const db = spectrum[index];
    if (!Number.isFinite(db) || db < spectrum[index - 1] || db < spectrum[index + 1]) continue;
    const left = Number.isFinite(spectrum[index - 1]) ? spectrum[index - 1] : -140;
    const right = Number.isFinite(spectrum[index + 1]) ? spectrum[index + 1] : -140;
    const denominator = left - 2 * db + right;
    const offset = denominator ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5) : 0;
    const foundFrequency = (index + offset) * binHz;
    const cents = Math.abs(1200 * Math.log2(foundFrequency / frequency));
    // Very low notes have limited FFT resolution. Their higher partials provide
    // the additional evidence needed to distinguish adjacent bass notes.
    const resolutionAllowance = Math.min(25, 650 * binHz / frequency);
    if (cents > toleranceCents + resolutionAllowance) continue;
    const prominence = db - Math.max(spectrum[index - 2] ?? -140, spectrum[index + 2] ?? -140);
    if (db > best.db) best = { db, frequency: foundFrequency, prominence };
  }
  return best;
}

/**
 * Score-informed pitch evidence, not general-purpose piano transcription.
 * The input is an AnalyserNode dB spectrum; the return value contains evidence
 * only for requested pitches. Lower-pitch candidates help reject their upper
 * harmonics. No audio or personal data leaves the browser.
 */
export function detectPitches(spectrum, sampleRate, fftSize, expected, options = {}) {
  const referencePitch = options.referencePitch || 440;
  const sensitivity = clamp(options.sensitivity ?? 0.55, 0, 1);
  const binHz = sampleRate / fftSize;
  const floorSamples = [];
  let loudest = -140;
  const lastBin = Math.min(spectrum.length, Math.ceil(6500 / binHz));
  for (let index = Math.ceil(35 / binHz); index < lastBin; index++) {
    const value = Number.isFinite(spectrum[index]) ? spectrum[index] : -140;
    loudest = Math.max(loudest, value);
    if (index % 13 === 0) floorSamples.push(value);
  }
  floorSamples.sort((a, b) => a - b);
  const noiseFloor = floorSamples[Math.floor(floorSamples.length * 0.5)] ?? -140;
  const threshold = Math.max(-92 + (1 - sensitivity) * 12, noiseFloor + 14 + (1 - sensitivity) * 8, loudest - 43);
  const candidates = new Map();
  const evaluate = midi => {
    if (candidates.has(midi)) return candidates.get(midi);
    const frequency = midiFrequency(midi, referencePitch);
    const partials = [];
    const hits = [];
    for (let harmonic = 1; harmonic <= 7; harmonic++) {
      const partial = peakAt(spectrum, frequency * harmonic, binHz, 38 + harmonic * 1.2);
      partials.push(partial);
      if (partial.db >= threshold && partial.prominence >= 5) hits.push(harmonic);
    }
    const fundamental = hits.includes(1);
    const higherCount = hits.filter(h => h > 1).length;
    const missingFundamental = hits.includes(2) && hits.includes(3) && higherCount >= 3;
    const fundamentalStrong = fundamental && partials[0].db >= threshold + 12;
    const present = (fundamental && higherCount >= 1) || fundamentalStrong || missingFundamental;
    const strongest = Math.max(...partials.map(p => p.db));
    const confidence = present ? clamp(0.48 + hits.length * 0.08 + (strongest - threshold) / 120, 0, 1) : 0;
    // Reattack tracking follows the fundamental where possible; the loudest
    // upper harmonic may actually belong to another note in the same chord.
    const strength = fundamental ? partials[0].db : Math.max(partials[1].db, partials[2].db);
    const result = { midi, present, confidence, strength, partials, hits, cents: 0 };
    // Median partial tuning is less sensitive to one blended neighbour or to a
    // piano's slightly stretched upper harmonics than a single spectral peak.
    const tunings = hits.slice(0, 4).map(h => 1200 * Math.log2(partials[h - 1].frequency / (frequency * h))).sort((a, b) => a - b);
    if (tunings.length) result.cents = tunings[Math.floor(tunings.length / 2)];
    candidates.set(midi, result);
    return result;
  };

  const expectedPitches = new Set(expected);
  const scorePitches = new Set(options.scorePitches ?? expected);
  const notes = [...expectedPitches].filter(midi => Number.isFinite(midi) && midi >= 21 && midi <= 108).map(evaluate);
  for (const note of notes) {
    if (!note.present) continue;
    for (const interval of [12, 19, 24, 28]) {
      const lowerMidi = note.midi - interval;
      if (lowerMidi < 21) continue;
      const lower = evaluate(lowerMidi);
      // A real fundamental or a score-expected bass is required for this veto.
      // Otherwise a perfect fifth can invent an unrelated missing subharmonic.
      if (!lower.present || (!lower.hits.includes(1) && !scorePitches.has(lowerMidi)) || !lower.hits.includes(3) || lower.hits.length < 3) continue;
      const ratio = Math.round(2 ** (interval / 12));
      // Estimate the lower note's harmonic envelope from odd partials. An upper
      // pitch must add energy beyond that envelope to count as a separate note.
      const estimates = [1, 3, 5, 7]
        .filter(h => h !== ratio && lower.hits.includes(h))
        .map(h => lower.partials[h - 1].db + 20 * Math.log10(h / ratio));
      if (!estimates.length) continue;
      estimates.sort((a, b) => a - b);
      const inherited = estimates[Math.floor(estimates.length / 2)];
      if (note.partials[0].db < inherited + 5) {
        note.present = false;
        note.confidence = 0;
        break;
      }
    }
  }
  return { notes, noiseFloor, threshold, loudest };
}

/** Debounces pitch evidence and requires a fresh strike for repeated notes. */
export class NoteGate {
  constructor() {
    this.target = [];
    this.token = undefined;
    this.states = new Map();
    this.accepted = new Set();
    this.lastMatched = new Map();
  }

  setTarget(notes, token) {
    const target = [...new Set(notes)].sort((a, b) => a - b);
    const signature = token ?? target.join(',');
    if (signature === this.token && target.join(',') === this.target.join(',')) return;
    this.token = signature;
    this.target = target;
    this.accepted.clear();
    for (const midi of target) {
      const previous = this.states.get(midi);
      this.states.set(midi, {
        strength: previous?.strength ?? -140,
        since: null,
        absentSince: previous?.absentSince ?? null,
        ready: !this.lastMatched.has(midi) || (previous?.released ?? true),
        released: previous?.released ?? true,
      });
    }
  }

  update(evidence, timestamp, audible = true, accepting = true) {
    let attack = false;
    const byMidi = new Map(evidence.map(note => [note.midi, note]));
    const targets = new Set(this.target);
    // Keep observing earlier targets as well. A note may disappear from one
    // chord and return later; its release must still be noticed in between.
    for (const [midi, state] of this.states) {
      const note = byMidi.get(midi);
      const present = audible && note?.present && note.confidence >= 0.57;
      if (!present) {
        state.since = null;
        state.absentSince ??= timestamp;
        if (timestamp - state.absentSince >= 100) {
          state.ready = true;
          state.released = true;
        }
        state.strength += ((note?.strength ?? -140) - state.strength) * 0.35;
        continue;
      }
      if (!accepting) {
        // Observe the sound's decay while approaching a score event, but don't
        // bank notes played seconds early or accept a held preroll chord.
        state.ready = false;
        state.since = null;
        state.absentSince = null;
        state.released = false;
        state.strength += (note.strength - state.strength) * 0.35;
        continue;
      }
      const freshRise = note.strength - state.strength >= 4.5;
      const lastMatch = this.lastMatched.get(midi) ?? -Infinity;
      if (freshRise && timestamp - lastMatch >= 180) {
        state.ready = true;
        attack = true;
      }
      state.absentSince = null;
      state.released = false;
      if (state.ready && targets.has(midi)) {
        state.since ??= timestamp;
        if (timestamp - state.since >= 65 && !this.accepted.has(midi)) {
          this.accepted.add(midi);
          this.lastMatched.set(midi, timestamp);
          state.ready = false;
        }
      }
      state.strength += (note.strength - state.strength) * 0.35;
    }
    return { matches: [...this.accepted], attack };
  }

  reset() {
    this.states.clear();
    this.accepted.clear();
    this.lastMatched.clear();
    this.token = undefined;
    this.target = [];
  }
}
