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
  for (const note of score.notes) add(JSON.stringify([note.midi, note.start, note.duration, note.scoreHand ?? note.hand]));
  return `${score.notes.length}-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function rememberScoreFingering(note) {
  if (!Object.hasOwn(note, 'scoreHand')) note.scoreHand = note.hand;
  if (!Object.hasOwn(note, 'scoreFinger')) note.scoreFinger = isFinger(note.finger) ? note.finger : null;
  if (!Object.hasOwn(note, 'scoreFingering')) note.scoreFingering = typeof note.fingering === 'string' ? note.fingering : '';
}

export function applyFingerings(score, overrides = {}) {
  const annotations = isMap(overrides) ? overrides : {};
  const attacks = new Map();
  // Older saves edited just one engraved voice. Carry that choice across its
  // siblings too; the last drawn voice wins if a legacy save disagrees with itself.
  const key = note => `${note.scoreHand ?? note.hand}:${note.start}:${note.midi}`;
  for (const note of score.notes) {
    if (Object.hasOwn(annotations, note.id) && isFinger(annotations[note.id])) attacks.set(key(note), annotations[note.id]);
  }
  for (const note of score.notes) {
    rememberScoreFingering(note);
    const finger = attacks.get(key(note));
    const originalHand = note.hand === note.scoreHand;
    note.finger = isFinger(finger) ? finger : originalHand ? note.scoreFinger : null;
    note.fingering = isFinger(finger) ? String(finger) : originalHand ? note.scoreFingering : '';
    note.fingeringOrigin = isFinger(finger) ? 'personal' : originalHand && note.scoreFingering ? 'score' : '';
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
  for (const member of attackNotes(score, note)) {
    rememberScoreFingering(member);
    if (finger === null) delete annotations[member.id];
    else annotations[member.id] = finger;
  }
  applyFingerings(score, annotations);
  return annotations;
}

// Two engraved voices can represent one physical key strike. Edit them together,
// but never merge the same pitch assigned to opposite hands in the source.
function attackNotes(score, note) {
  return score.notes.filter(candidate => candidate.midi === note.midi
    && Math.abs(candidate.start - note.start) < .00001
    && (candidate.scoreHand ?? candidate.hand) === (note.scoreHand ?? note.hand));
}

export function applyHands(score, overrides = {}) {
  const annotations = isMap(overrides) ? overrides : {};
  for (const note of score.notes) {
    rememberScoreFingering(note);
    const hand = Object.hasOwn(annotations, note.id) ? annotations[note.id] : undefined;
    note.hand = hand === 'left' || hand === 'right' ? hand : note.scoreHand;
  }
  return score;
}

export function setNoteHand(score, noteId, hand, hands = {}, fingers = {}) {
  if (hand !== null && hand !== 'left' && hand !== 'right') throw new RangeError('Choose left or right hand.');
  const note = score.notes.find(candidate => String(candidate.id) === String(noteId));
  if (!note) return hands;
  for (const member of attackNotes(score, note)) {
    rememberScoreFingering(member);
    const next = hand ?? member.scoreHand;
    if (next !== member.hand) delete fingers[member.id];
    if (next === member.scoreHand) delete hands[member.id];
    else hands[member.id] = next;
  }
  applyHands(score, hands);
  applyFingerings(score, fingers);
  return hands;
}
