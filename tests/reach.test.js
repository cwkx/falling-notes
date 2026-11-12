import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReach, wideHands } from '../src/reach.js';

const note = (id, midi, hand = 'right', duration = 1) => ({ id, midi, hand, duration });

test('checks each hand independently and only flags spans beyond the chosen reach', () => {
  const notes = [note(0, 36, 'left'), note(1, 48, 'left'), note(2, 60), note(3, 69)];
  assert.deepEqual(wideHands(notes, 9), ['left']);
  assert.deepEqual(wideHands(notes, 8), ['left', 'right']);
  assert.deepEqual(wideHands(notes, 12), []);
  assert.deepEqual(wideHands([note(0, 24, 'left'), note(1, 84)], 9), []);
});

test('duplicate voices do not make a single key a wide chord', () => {
  assert.deepEqual(wideHands([note(0, 60), note(1, 60)], 1), []);
  assert.deepEqual(wideHands([note(0, 60), note(1, 60), note(2, 72)], 11), ['right']);
});

test('reach hints identify every note in the affected hand without changing the score', () => {
  const notes = [note(0, 36, 'left'), note(1, 48, 'left'), note(2, 60), note(3, 64)];
  const score = { events: [{ time: 2, notes }, { time: 3, notes: [note(4, 65)] }] };
  const before = structuredClone(score);
  const result = analyzeReach(score, 10);
  assert.deepEqual(result.events, [{ time: 2, hands: ['left'] }]);
  assert.deepEqual([...result.wideNoteIds], [0, 1]);
  assert.deepEqual(score, before);
});

test('sustained notes and successive leaps are not counted as simultaneous attacks', () => {
  const score = { events: [
    { time: 0, notes: [note(0, 36, 'left', 8)] },
    { time: 1, notes: [note(1, 60, 'left')] },
  ] };
  assert.deepEqual(analyzeReach(score, 9), { wideNoteIds: new Set(), events: [] });
});

test('recomputing reach uses edited hand assignments', () => {
  const notes = [note(0, 48), note(1, 60), note(2, 64)];
  const score = { events: [{ time: 0, notes }] };
  assert.deepEqual(analyzeReach(score, 9).events, [{ time: 0, hands: ['right'] }]);
  notes[0].hand = 'left';
  assert.deepEqual(analyzeReach(score, 9), { wideNoteIds: new Set(), events: [] });
});

test('a disabled or invalid reach produces no hints', () => {
  const notes = [note(0, 24), note(1, 96)];
  const score = { events: [{ time: 0, notes }] };
  for (const reach of [0, -1, NaN, Infinity, undefined, '12']) {
    assert.deepEqual(wideHands(notes, reach), []);
    assert.deepEqual(analyzeReach(score, reach), { wideNoteIds: new Set(), events: [] });
  }
});
