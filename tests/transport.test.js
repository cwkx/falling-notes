import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../src/transport.js';

const notes = [
  { midi: 48, start: 0, duration: 1, hand: 'left' },
  { midi: 60, start: 0, duration: 1, hand: 'right' },
  { midi: 60, start: 1, duration: 1, hand: 'right' },
];
const score = { notes, events: [{ time: 0, notes: notes.slice(0, 2) }, { time: 1, notes: notes.slice(2) }], duration: 2 };

test('wait mode stops exactly at a chord until every expected pitch is played', () => {
  const t = new Transport(score);
  t.seek(-0.05);
  t.playing = true;
  t.step(.1);
  assert.equal(t.position, 0);
  assert.equal(t.waiting, true);
  t.accept([61]);
  t.accept([48]);
  t.step(.1);
  assert.equal(t.position, 0);
  assert.deepEqual([...t.matched], [48]);
  t.accept([60]);
  assert.equal(t.waiting, false);
  assert.equal(t.index, 1);
  t.step(.1);
  assert.ok(t.position > 0);
});

test('seeking clears matches and produces a new recognition token', () => {
  const t = new Transport(score);
  t.playing = true;
  t.seek(0);
  t.step(.01);
  const token = t.token;
  t.accept([48]);
  t.seek(0);
  assert.notEqual(t.token, token);
  assert.equal(t.matched.size, 0);
  assert.equal(t.index, 0);
});

test('listening plays every crossed note once and respects speed', () => {
  const t = new Transport(score);
  t.setMode('listen');
  t.seek(-.05);
  t.playing = true;
  t.speed = .5;
  assert.equal(t.step(.1).length, 2);
  assert.equal(t.position, 0);
  assert.equal(t.step(.1).length, 0);
  assert.equal(t.position, .05);
});

test('single hand practice excludes other-hand notes and empty events', () => {
  const t = new Transport(score);
  t.setHand('left');
  assert.equal(t.events.length, 1);
  assert.deepEqual([...t.expected], [48]);
});

test('a loop resets recognition and continues playing', () => {
  const t = new Transport(score);
  t.setMode('listen');
  t.loop = { start: 0, end: 1 };
  t.seek(.95);
  t.playing = true;
  const token = t.token;
  assert.deepEqual(t.step(.1), []);
  assert.equal(t.position, 0);
  assert.equal(t.playing, true);
  assert.notEqual(t.token, token);
});

test('paused and early recognition cannot complete a future chord', () => {
  const t = new Transport(score);
  assert.deepEqual(t.accept([48, 60]), []);
  t.playing = true;
  assert.deepEqual(t.accept([48, 60]), []);
  assert.equal(t.index, 0);
});

test('loop rest uses real time, even at very slow speed, and can be cleared by seeking', () => {
  const t = new Transport(score);
  t.setMode('listen');
  t.loop = { start: 0, end: 1 };
  t.loopGap = .5;
  t.speed = .1;
  t.seek(.999);
  t.playing = true;
  t.step(.1);
  assert.equal(t.position, 0);
  assert.equal(t.loopRest, .5);
  for (let i = 0; i < 4; i++) assert.deepEqual(t.step(.1), []);
  assert.equal(t.position, 0);
  assert.ok(Math.abs(t.loopRest - .1) < 1e-8);
  t.seek(0);
  assert.equal(t.loopRest, 0);
  assert.equal(t.step(.1).length, 2);
});

test('wait mode never requires a note outside the loop and rests before the next lap', () => {
  const t = new Transport(score);
  t.loop = { start: 0, end: .5 };
  t.loopGap = .5;
  t.seek(.49);
  t.playing = true;
  t.step(.1);
  assert.equal(t.position, 0);
  assert.equal(t.waiting, false);
  assert.deepEqual(t.accept([48, 60]), []);
  assert.equal(t.loopRest, .5);
});
