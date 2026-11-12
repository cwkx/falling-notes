const isFinger = value => Number.isInteger(value) && value >= 1 && value <= 5;
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Keep annotations tied to the musical content, not just a filename. Fingering
// itself is excluded so editing an annotation never changes its storage key.
export function fingerprintScore(score) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const add = text => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
  };
  add(JSON.stringify(score.title || ''));
  for (const note of score.notes) add(JSON.stringify([note.midi, note.start, note.duration, note.hand]));
  return `${score.notes.length}-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function rememberScoreFingering(note) {
  if (!Object.hasOwn(note, 'scoreFinger')) note.scoreFinger = isFinger(note.finger) ? note.finger : null;
  if (!Object.hasOwn(note, 'scoreFingering')) note.scoreFingering = typeof note.fingering === 'string' ? note.fingering : '';
}

export function applyFingerings(score, overrides = {}) {
  const annotations = isMap(overrides) ? overrides : {};
  for (const note of score.notes) {
    rememberScoreFingering(note);
    const finger = Object.hasOwn(annotations, note.id) ? annotations[note.id] : undefined;
    note.finger = isFinger(finger) ? finger : note.scoreFinger;
    note.fingering = isFinger(finger) ? String(finger) : note.scoreFingering;
  }
  return score;
}

// A null finger removes the manual annotation and restores any score fingering.
// Score events refer to these same note objects, so no transport rebuild is needed.
export function setFingering(score, noteId, finger, overrides = {}) {
  if (finger !== null && !isFinger(finger)) throw new RangeError('Choose a finger from 1 to 5.');
  const annotations = isMap(overrides) ? overrides : {};
  const note = score.notes.find(candidate => String(candidate.id) === String(noteId));
  if (!note) return annotations;
  rememberScoreFingering(note);
  if (finger === null) {
    delete annotations[note.id];
    note.finger = note.scoreFinger;
    note.fingering = note.scoreFingering;
  } else {
    annotations[note.id] = finger;
    note.finger = finger;
    note.fingering = String(finger);
  }
  return annotations;
}
