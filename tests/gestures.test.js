import test from 'node:test';
import assert from 'node:assert/strict';
import { RollGestures } from '../src/gestures.js';

function fixture() {
  const captures = [];
  const changes = { seeks: [], speeds: [], keys: [], notes: [], zooms: [] };
  const renderer = {
    width: 600, strikeY: 400, zoom: 1, pan: 0,
    noteAt: (x, y) => y >= 500 ? 60 : null,
    noteFromPoint: (x, y) => y >= 100 && y < 200 ? { id: 1, midi: 64 } : null,
    setZoom(zoom, anchor) {
      this.zoom = Math.max(1, Math.min(4, zoom));
      changes.zooms.push({ zoom: this.zoom, anchor });
    },
    panBy(delta) { this.pan += delta; },
  };
  let lookAhead = 8;
  const canvas = {
    addEventListener() {},
    setPointerCapture: id => captures.push(id),
    getBoundingClientRect: () => ({ left: 0 }),
  };
  const gestures = new RollGestures(canvas, {
    renderer, ready: () => true, position: () => 10, speed: () => 1,
    lookAhead: () => lookAhead,
    setLookAhead: value => { lookAhead = Math.round(value * 4) / 4; },
    seek: value => changes.seeks.push(value),
    setSpeed: value => changes.speeds.push(value),
    positionText: () => '0:10',
    stopSounds() {}, viewChanged() {}, feedback() {},
    key: midi => changes.keys.push(midi),
    note: note => changes.notes.push(note),
  });
  return { gestures, renderer, changes, captures };
}

const point = (id, x, y = 150) => ({
  pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0,
  preventDefault() {},
});

test('a third touch cannot replace a pinch endpoint or change its baseline', () => {
  const { gestures, renderer, changes, captures } = fixture();
  gestures.start(point(1, 100));
  gestures.start(point(2, 300));
  gestures.move(point(1, 80));
  assert.ok(Math.abs(renderer.zoom - 1.1) < 1e-8);
  const baseline = gestures.gesture;
  gestures.start(point(3, 550, 520));
  gestures.move(point(3, 0, 10));
  assert.equal(gestures.points.size, 2);
  assert.equal(gestures.gesture, baseline);
  assert.deepEqual(captures, [1, 2]);
  assert.ok(Math.abs(renderer.zoom - 1.1) < 1e-8);
  gestures.end(point(1, 80));
  gestures.move(point(3, 550, 300));
  gestures.move(point(2, 400));
  assert.ok(Math.abs(renderer.zoom - 1.1) < 1e-8);
  gestures.end(point(2, 400));
  gestures.end(point(3, 550, 300));
  assert.equal(gestures.busy, false);
  assert.deepEqual(changes.seeks, []);
  assert.deepEqual(changes.speeds, []);
  assert.deepEqual(changes.keys, []);
  assert.deepEqual(changes.notes, []);
});

test('lifting one pinch finger never turns the surviving finger into a tap or scrub', () => {
  const { gestures, changes } = fixture();
  gestures.start(point(1, 100));
  gestures.start(point(2, 300));
  gestures.move(point(2, 350));
  gestures.end(point(1, 100));
  assert.equal(gestures.scrubbing, true);
  gestures.move(point(2, 350, 40));
  gestures.end(point(2, 350, 40));
  assert.equal(gestures.busy, false);
  assert.equal(gestures.scrubbing, false);
  assert.deepEqual(changes.seeks, []);
  assert.deepEqual(changes.speeds, []);
  assert.deepEqual(changes.notes, []);
});

test('pointer cancellation and lost capture never play keys or open fingering', () => {
  const { gestures, changes } = fixture();
  for (const y of [150, 520]) {
    gestures.start(point(1, 100, y));
    gestures.end(point(1, 100, y), true);
    gestures.end(point(1, 100, y));
  }
  gestures.start(point(1, 100, 520));
  gestures.start(point(2, 300, 520));
  gestures.end(point(1, 100, 520), true);
  gestures.end(point(2, 300, 520));
  assert.equal(gestures.busy, false);
  assert.equal(gestures.scrubbing, false);
  assert.deepEqual(changes.keys, []);
  assert.deepEqual(changes.notes, []);
});

test('cancelling an active gesture clears its state before delayed pointer releases', () => {
  const { gestures, changes } = fixture();
  gestures.start(point(1, 100));
  gestures.start(point(2, 300));
  gestures.cancel();
  gestures.move(point(2, 350));
  gestures.end(point(1, 100));
  gestures.end(point(2, 350));
  assert.equal(gestures.busy, false);
  assert.equal(gestures.scrubbing, false);
  assert.deepEqual(changes.keys, []);
  assert.deepEqual(changes.notes, []);
  assert.deepEqual(changes.seeks, []);
});

test('small trackpad pinch deltas accumulate past a look-ahead slider step', () => {
  const { gestures, changes } = fixture();
  gestures.options.setLookAhead(1);
  const wheel = { ctrlKey: true, deltaY: -1, clientX: 300, preventDefault() {} };
  for (let i = 0; i < 30; i++) gestures.wheel(wheel);
  assert.equal(gestures.options.lookAhead(), .75);
  assert.deepEqual(changes.seeks, []);
  assert.deepEqual(changes.speeds, []);
  gestures.options.setLookAhead(4);
  gestures.wheel(wheel);
  assert.equal(gestures.options.lookAhead(), 4);
});
