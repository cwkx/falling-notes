import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintScore, applyFingerings, setFingering } from '../src/fingering.js';

const score = () => {
  const notes = [
    { id: 0, midi: 60, start: 0, duration: .5, hand: 'right', finger: 1, fingering: '1–3' },
    { id: 1, midi: 64, start: .5, duration: .5, hand: 'right', finger: null, fingering: '' },
  ];
  return { title: 'Exercise', notes, events: notes.map(note => ({ time: note.start, notes: [note] })) };
};

test('annotations survive a fresh score load without changing their fingerprint', () => {
  const first = score();
  const key = fingerprintScore(first);
  const overrides = setFingering(first, 1, 4, {});
  assert.equal(first.events[1].notes[0].finger, 4);
  assert.equal(fingerprintScore(first), key);
  const reloaded = score();
  applyFingerings(reloaded, JSON.parse(JSON.stringify(overrides)));
  assert.equal(fingerprintScore(reloaded), key);
  assert.equal(reloaded.notes[1].finger, 4);
  assert.equal(reloaded.notes[1].fingering, '4');
});

test('clearing an annotation restores its original fingering including substitutions', () => {
  const piece = score();
  const overrides = { 0: 5 };
  applyFingerings(piece, overrides);
  applyFingerings(piece, overrides);
  assert.equal(piece.notes[0].finger, 5);
  assert.equal(piece.notes[0].scoreFinger, 1);
  assert.equal(piece.notes[0].scoreFingering, '1–3');
  assert.equal(setFingering(piece, '0', null, overrides), overrides);
  assert.deepEqual(overrides, {});
  assert.equal(piece.notes[0].finger, 1);
  assert.equal(piece.notes[0].fingering, '1–3');
});

test('rejects invalid annotations and ignores malformed or inherited stored values', () => {
  const piece = score();
  for (const invalid of [0, 6, 1.5, '3', NaN, undefined]) {
    assert.throws(() => setFingering(piece, 0, invalid, {}), RangeError);
  }
  const inherited = Object.create({ 0: 4 });
  inherited[1] = '2';
  applyFingerings(piece, inherited);
  assert.equal(piece.notes[0].finger, 1);
  assert.equal(piece.notes[1].finger, null);
  for (const malformed of [null, [2], '2', 4]) applyFingerings(piece, malformed);
  assert.equal(piece.notes[0].finger, 1);
  assert.deepEqual(setFingering(piece, 'absent', 3, {}), {});
});

test('score identity changes with pitches, timings, hands, or title', () => {
  const original = score();
  const originalKey = fingerprintScore(original);
  for (const [field, value] of [['midi', 61], ['start', .25], ['duration', 1], ['hand', 'left']]) {
    const changed = score();
    changed.notes[0][field] = value;
    assert.notEqual(fingerprintScore(changed), originalKey);
  }
  const renamed = score();
  renamed.title = 'Another exercise';
  assert.notEqual(fingerprintScore(renamed), originalKey);
  assert.equal(fingerprintScore(structuredClone(original)), originalKey);
});
