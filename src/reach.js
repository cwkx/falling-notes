const HANDS = ['left', 'right'];

/** Compare new attacks only; sustained notes need not remain held by the hand. */
export function wideHands(notes, reach) {
  if (!Number.isFinite(reach) || reach <= 0) return [];
  return HANDS.filter(hand => {
    let lowest = Infinity;
    let highest = -Infinity;
    for (const note of notes) {
      if (note.hand !== hand) continue;
      lowest = Math.min(lowest, note.midi);
      highest = Math.max(highest, note.midi);
    }
    return highest - lowest > reach;
  });
}

/** A reach hint, not a fingering or a guarantee that a chord fits comfortably. */
export function analyzeReach(score, reach) {
  const wideNoteIds = new Set();
  const events = [];
  if (!Number.isFinite(reach) || reach <= 0) return { wideNoteIds, events };
  for (const event of score.events) {
    const hands = wideHands(event.notes, reach);
    if (!hands.length) continue;
    events.push({ time: event.time, hands });
    for (const note of event.notes) {
      if (hands.includes(note.hand)) wideNoteIds.add(note.id);
    }
  }
  return { wideNoteIds, events };
}
