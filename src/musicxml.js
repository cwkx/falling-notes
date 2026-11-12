import { strFromU8, unzipSync } from 'fflate';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_NOTES = 150000;
const EPSILON = 1e-5;
const STEPS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const BEAT_UNITS = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 };

const name = (node) => node?.localName || node?.nodeName;
const children = (node, tag) => Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1 && (!tag || name(child) === tag));
const child = (node, tag) => children(node, tag)[0];
const value = (node, tag, fallback = '') => child(node, tag)?.textContent?.trim() || fallback;
const numeric = (node, tag, fallback = 0) => {
  const parsed = Number(value(node, tag, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const descendants = (node, tag) => Array.from(node?.getElementsByTagName?.('*') || []).filter((item) => name(item) === tag);

function parseXml(text) {
  if (text.length > MAX_XML_BYTES) throw new Error('This score is too large. Choose a smaller MusicXML file.');
  if (/<!ENTITY\s/i.test(text)) throw new Error('XML entity declarations are not supported.');
  // Some older MuseScore exports contain nameless, empty positioning elements.
  // They carry no musical data; repair only this exact malformed engraving tag.
  text = text.replace(/<\s+(?:default-[xy]="[^"]*"\s*)+\/>/g, '');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (!document.documentElement || descendants(document, 'parsererror').length || name(document.documentElement) === 'parsererror') {
    throw new Error('This MusicXML file could not be read. Try exporting it again.');
  }
  return document;
}

function extractXml(input) {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) throw new Error('This file is empty.');
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Choose a MusicXML file smaller than 20 MB.');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return new TextDecoder().decode(bytes);
  let files;
  let scorePath;
  try {
    const metadata = unzipSync(bytes, {
      filter(entry) {
        if (entry.name.toLowerCase() !== 'meta-inf/container.xml') return false;
        if (entry.originalSize > 1024 * 1024) throw new Error('Archive metadata is too large.');
        return true;
      },
    });
    const containerKey = Object.keys(metadata)[0];
    if (containerKey) {
      const container = parseXml(strFromU8(metadata[containerKey]));
      const roots = descendants(container, 'rootfile');
      scorePath = (roots.find((root) => root.getAttribute('media-type') === 'application/vnd.recordare.musicxml+xml') || roots[0])?.getAttribute('full-path');
    }
    let expandedSize = 0;
    files = unzipSync(bytes, {
      filter(entry) {
        if (scorePath ? entry.name !== scorePath : entry.name.toLowerCase().startsWith('meta-inf/') || !/\.(xml|musicxml)$/i.test(entry.name)) return false;
        expandedSize += entry.originalSize;
        if (expandedSize > MAX_XML_BYTES) throw new Error('Archive expands beyond the score size limit.');
        return true;
      },
    });
  } catch {
    throw new Error('This MXL archive is damaged or too large. Try exporting it again.');
  }
  scorePath ||= Object.keys(files).find((key) => !key.toLowerCase().startsWith('meta-inf/') && /\.(musicxml|xml)$/i.test(key));
  if (!scorePath || !files[scorePath]) throw new Error('No MusicXML score was found in this archive.');
  return strFromU8(files[scorePath]);
}

function scoreParts(root) {
  if (name(root) === 'score-partwise') {
    return children(root, 'part').map((part) => ({
      id: part.getAttribute('id'),
      measures: children(part, 'measure').map((node) => ({ node, number: node.getAttribute('number'), implicit: node.getAttribute('implicit') === 'yes' })),
    }));
  }
  if (name(root) === 'score-timewise') {
    const parts = new Map();
    children(root, 'measure').forEach((measure, index) => {
      children(measure, 'part').forEach((part) => {
        const id = part.getAttribute('id');
        if (!parts.has(id)) parts.set(id, { id, measures: [] });
        parts.get(id).measures[index] = { node: part, number: measure.getAttribute('number'), implicit: measure.getAttribute('implicit') === 'yes' };
      });
    });
    return [...parts.values()];
  }
  throw new Error('Choose a MusicXML score (.mxl, .musicxml or .xml).');
}

function metronomeTempo(direction) {
  const metronome = descendants(direction, 'metronome')[0];
  if (!metronome) return 0;
  const unit = BEAT_UNITS[value(metronome, 'beat-unit')] || 1;
  const dots = children(metronome, 'beat-unit-dot').length;
  const bpm = numeric(metronome, 'per-minute') * unit * (2 - 2 ** -dots);
  return bpm > 0 ? bpm : 0;
}

function parsePart(part, partIndex, partCount) {
  let divisions = 1;
  let nominalDuration = 4;
  let staves = 1;
  let transpose = 0;
  const staffTransposes = new Map();
  let activeEnding = null;
  return part.measures.map((measure, index) => {
    if (!measure) return { notes: [], tempos: [], duration: nominalDuration, number: index + 1 };
    let cursor = 0;
    let end = 0;
    let lastStart = 0;
    const notes = [];
    const tempos = [];
    const meta = { forward: false, backward: false, times: 2, endings: activeEnding };
    const numberText = measure.number || String(index + 1);
    const number = /^\d+$/.test(numberText) ? Number(numberText) : numberText;
    let endingStopped = false;

    for (const element of children(measure.node)) {
      switch (name(element)) {
        case 'attributes': {
          divisions = Math.max(1, numeric(element, 'divisions', divisions));
          staves = Math.max(1, numeric(element, 'staves', staves));
          const time = child(element, 'time');
          if (time && !child(time, 'senza-misura')) {
            const beats = children(time, 'beats');
            const units = children(time, 'beat-type');
            nominalDuration = beats.reduce((total, item, i) => {
              const count = item.textContent.split('+').reduce((sum, beat) => sum + (Number(beat) || 0), 0);
              return total + count * 4 / (Number(units[i]?.textContent) || 4);
            }, 0) || nominalDuration;
          }
          for (const transposition of children(element, 'transpose')) {
            const semitones = numeric(transposition, 'chromatic') + numeric(transposition, 'octave-change') * 12;
            if (transposition.hasAttribute('number')) staffTransposes.set(Number(transposition.getAttribute('number')), semitones);
            else transpose = semitones;
          }
          break;
        }
        case 'backup': cursor = Math.max(0, cursor - numeric(element, 'duration') / divisions); break;
        case 'forward': cursor += numeric(element, 'duration') / divisions; end = Math.max(end, cursor); break;
        case 'direction': {
          const sound = child(element, 'sound');
          const bpm = Number(sound?.getAttribute('tempo')) || metronomeTempo(element);
          if (bpm > 0 && bpm <= 1000) tempos.push({ beat: Math.max(0, cursor + numeric(element, 'offset') / divisions), bpm });
          break;
        }
        case 'sound': {
          const bpm = Number(element.getAttribute('tempo'));
          if (bpm > 0 && bpm <= 1000) tempos.push({ beat: cursor, bpm });
          break;
        }
        case 'barline': {
          for (const repeat of children(element, 'repeat')) {
            if (repeat.getAttribute('direction') === 'forward') meta.forward = true;
            else if (repeat.getAttribute('direction') === 'backward') {
              meta.backward = true;
              meta.times = Math.min(8, Math.max(2, Number(repeat.getAttribute('times')) || 2));
            }
          }
          for (const ending of children(element, 'ending')) {
            if (ending.getAttribute('type') === 'start') {
              activeEnding = (ending.getAttribute('number') || '').match(/\d+/g)?.map(Number) || null;
              meta.endings = activeEnding;
            } else endingStopped = true;
          }
          break;
        }
        case 'note': {
          const isChord = Boolean(child(element, 'chord'));
          const isGrace = Boolean(child(element, 'grace'));
          const duration = isGrace ? 0.125 : Math.max(0, numeric(element, 'duration') / divisions);
          const start = isChord ? lastStart : cursor;
          if (!isChord) lastStart = start;
          if (!isChord && !isGrace) cursor += duration;
          if (!isGrace) end = Math.max(end, start + duration);
          const pitch = child(element, 'pitch');
          if (!pitch || child(element, 'rest') || element.getAttribute('print-object') === 'no' && element.getAttribute('print-spacing') === 'no') break;
          const staff = numeric(element, 'staff', 1);
          const step = value(pitch, 'step');
          const midi = (numeric(pitch, 'octave', 4) + 1) * 12 + STEPS[step] + numeric(pitch, 'alter') + (staffTransposes.get(staff) ?? transpose);
          if (!Number.isFinite(midi) || midi < 0 || midi > 127 || duration <= 0) break;
          const ties = [...children(element, 'tie'), ...descendants(element, 'tied')].map((tie) => tie.getAttribute('type'));
          notes.push({
            midi: Math.round(midi), beat: start, beats: duration, staff,
            voice: value(element, 'voice', '1'), part: part.id || String(partIndex),
            tieStart: ties.includes('start'), tieStop: ties.includes('stop'),
            grace: isGrace, measure: number,
          });
          break;
        }
      }
    }
    if (endingStopped) activeEnding = null;
    const fourStaff = staves >= 4 && notes.some((note) => note.staff >= 3);
    for (const note of notes) {
      note.hand = staves > 1
        ? (fourStaff ? note.staff <= 2 : note.staff === 1) ? 'right' : 'left'
        : partCount > 1 ? partIndex === 0 ? 'right' : 'left' : note.midi >= 60 ? 'right' : 'left';
    }
    return { notes, tempos, number, duration: measure.implicit ? end : Math.max(end, nominalDuration), ...meta };
  });
}

function measureOrder(measures) {
  const stack = [];
  const repeats = [];
  measures.forEach((measure, index) => {
    if (measure.forward) stack.push(index);
    if (measure.backward) repeats.push({ start: stack.pop() ?? 0, end: index, times: measure.times || 2, pass: 1 });
  });
  const order = [];
  let index = 0;
  let lastPass = 1;
  let iterations = 0;
  while (index < measures.length && iterations++ < Math.min(20000, measures.length * 64)) {
    const measure = measures[index];
    const enclosing = repeats.filter((repeat) => repeat.start <= index && repeat.end >= index).sort((a, b) => b.start - a.start)[0];
    const pass = enclosing?.pass || lastPass;
    if (!measure.endings || measure.endings.includes(pass)) order.push(index);
    const repeat = repeats.find((item) => item.end === index);
    if (repeat && repeat.pass < repeat.times) {
      repeat.pass++;
      for (const nested of repeats) if (nested !== repeat && nested.start >= repeat.start && nested.end < repeat.end) nested.pass = 1;
      index = repeat.start;
    } else {
      if (repeat) lastPass = repeat.pass;
      else if (!measure.endings) lastPass = 1;
      index++;
    }
  }
  if (index < measures.length) throw new Error('This score has too many nested repeats.');
  return order;
}

function tempoTimeline(tempos) {
  const ordered = [{ beat: 0, bpm: 120 }, ...tempos].sort((a, b) => a.beat - b.beat);
  const map = [];
  for (const tempo of ordered) {
    if (map.length && Math.abs(map.at(-1).beat - tempo.beat) < EPSILON) map[map.length - 1] = tempo;
    else map.push(tempo);
  }
  let seconds = 0;
  map.forEach((tempo, index) => {
    if (index) seconds += (tempo.beat - map[index - 1].beat) * 60 / map[index - 1].bpm;
    tempo.time = seconds;
  });
  const toSeconds = (beat) => {
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (map[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return map[lo].time + (beat - map[lo].beat) * 60 / map[lo].bpm;
  };
  return { map, toSeconds };
}

/** Read MusicXML / compressed MXL locally. All output times are in seconds. */
export async function loadScore(input, filename = '') {
  let document;
  try { document = parseXml(extractXml(input)); }
  catch (error) {
    if (error instanceof Error && /XML|score|file|archive|Choose/i.test(error.message)) throw error;
    throw new Error('This MusicXML file could not be read. Try exporting it again.');
  }
  const root = document.documentElement;
  const rawParts = scoreParts(root);
  if (!rawParts.length) throw new Error('This score contains no parts.');
  const parts = rawParts.map((part, index) => parsePart(part, index, rawParts.length));
  const count = Math.max(...parts.map((part) => part.length));
  if (!count || count > 10000) throw new Error('This score has no measures or is too large.');
  const aligned = Array.from({ length: count }, (_, index) => {
    const measures = parts.map((part) => part[index]).filter(Boolean);
    return { ...measures[0], duration: Math.max(...measures.map((measure) => measure.duration)) };
  });
  const order = measureOrder(aligned);
  let beat = 0;
  const rawNotes = [];
  const rawTempos = [];
  const rawMeasures = [];
  // Restore tempo at a repeat's destination, even when its tempo was inherited.
  const inheritedTempos = [];
  let inheritedTempo = 120;
  for (let index = 0; index < count; index++) {
    inheritedTempos[index] = inheritedTempo;
    const changes = parts.flatMap((part) => part[index]?.tempos || []).sort((a, b) => a.beat - b.beat);
    if (changes.length) inheritedTempo = changes.at(-1).bpm;
  }
  order.forEach((index, orderIndex) => {
    const measure = aligned[index];
    rawMeasures.push({ number: measure.number, beat, beats: measure.duration });
    if (orderIndex && index < order[orderIndex - 1]) rawTempos.push({ beat, bpm: inheritedTempos[index] });
    parts.forEach((part) => {
      const source = part[index];
      if (!source) return;
      source.notes.forEach((note) => {
        if (rawNotes.length >= MAX_NOTES) throw new Error('This score has too many notes.');
        rawNotes.push({ ...note, beat: note.beat + beat });
      });
      source.tempos.forEach((tempo) => rawTempos.push({ ...tempo, beat: tempo.beat + beat }));
    });
    beat += measure.duration;
  });
  if (!rawNotes.length) throw new Error('This score contains no pitched notes.');
  if (rawNotes.length > MAX_NOTES) throw new Error('This score has too many notes.');

  rawNotes.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const merged = [];
  const openTies = new Map();
  for (const note of rawNotes) {
    const key = `${note.part}:${note.voice}:${note.staff}:${note.midi}`;
    const previous = openTies.get(key);
    if (note.tieStop && previous && Math.abs(previous.beat + previous.beats - note.beat) < EPSILON) previous.beats += note.beats;
    else merged.push(note);
    if (note.tieStart) openTies.set(key, note.tieStop && previous && Math.abs(previous.beat + previous.beats - note.beat - note.beats) < EPSILON ? previous : note);
    else openTies.delete(key);
  }
  const { map, toSeconds } = tempoTimeline(rawTempos);
  const notes = merged.map((note, id) => ({
    id, midi: note.midi, start: toSeconds(note.beat),
    duration: Math.max(0.025, toSeconds(note.beat + note.beats) - toSeconds(note.beat)),
    hand: note.hand, measure: note.measure,
  }));
  const events = [];
  for (const note of notes) {
    const last = events.at(-1);
    if (last && Math.abs(last.time - note.start) < EPSILON) last.notes.push(note);
    else events.push({ time: note.start, notes: [note] });
  }
  const duration = notes.reduce((end, note) => Math.max(end, note.start + note.duration), toSeconds(beat));
  if (!Number.isFinite(duration) || duration > 6 * 60 * 60) throw new Error('This score is too long to load.');
  const work = child(root, 'work');
  const identification = child(root, 'identification');
  const title = value(work, 'work-title') || value(root, 'movement-title') || filename.replace(/\.(mxl|musicxml|xml)$/i, '').replace(/[-_]/g, ' ') || 'Untitled';
  const composer = children(identification, 'creator').find((creator) => creator.getAttribute('type') === 'composer')?.textContent?.trim() || '';
  return {
    title, composer, notes, events,
    measures: rawMeasures.map((measure) => ({ number: measure.number, start: toSeconds(measure.beat), duration: toSeconds(measure.beat + measure.beats) - toSeconds(measure.beat) })),
    duration, tempos: map.map(({ time, bpm }) => ({ time, bpm })),
    minMidi: notes.reduce((min, note) => Math.min(min, note.midi), 127),
    maxMidi: notes.reduce((max, note) => Math.max(max, note.midi), 0),
  };
}
