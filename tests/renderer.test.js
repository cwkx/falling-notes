import test from 'node:test';
import assert from 'node:assert/strict';
import { FallingRenderer, FINGER_COLORS } from '../src/renderer.js';

function rendererFixture({ width = 720, height = 540, reducedMotion = false } = {}) {
  const bounds = { left: 15, top: 25, width, height };
  const text = [];
  const stops = [];
  const fills = [];
  const context = new Proxy({
    fill() { fills.push(this.fillStyle); },
    fillText: (...args) => text.push(args),
    createLinearGradient: () => ({ addColorStop: (offset, color) => stops.push(color) }),
    createRadialGradient: () => ({ addColorStop: (offset, color) => stops.push(color) }),
  }, { get: (target, key) => key in target ? target[key] : () => {} });
  globalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: reducedMotion }) };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => bounds };
  const renderer = new FallingRenderer(canvas);
  const notes = [
    { id: 0, midi: 36, start: 0, duration: 1, hand: 'left' },
    { id: 1, midi: 61, start: .25, duration: .02, hand: 'right', finger: 2, fingering: '2' },
    { id: 2, midi: 84, start: 1, duration: 1, hand: 'right' },
  ];
  renderer.setScore({ notes, measures: [{ number: 1, start: 0, duration: 4 }] });
  return { renderer, bounds, text, stops, fills, notes };
}

test('zoom keeps the chosen piano key under the pinch anchor', () => {
  const { renderer } = rendererFixture();
  const anchor = renderer.keyByMidi.get(61).center;
  renderer.setZoom(2.5, anchor);
  assert.ok(Math.abs(renderer.keyByMidi.get(61).center - anchor) < 1e-8);
  assert.equal(renderer.zoom, 2.5);
  assert.ok(renderer.keys[0].x < 0);
  assert.ok(renderer.keys.at(-1).x + renderer.keys.at(-1).width > renderer.width);
});

test('panning is bounded by the piano edges and reset fits the full score', () => {
  const { renderer } = rendererFixture();
  renderer.setZoom(20);
  assert.equal(renderer.zoom, 4);
  renderer.panBy(100000);
  assert.equal(renderer.keys[0].x, 0);
  renderer.panBy(-100000);
  const last = renderer.keys.at(-1);
  assert.ok(Math.abs(last.x + last.width - renderer.width) < 1e-8);
  renderer.resetView();
  assert.equal(renderer.zoom, 1);
  assert.equal(renderer.pan, 0);
  assert.equal(renderer.keys[0].x, 0);
  assert.equal(renderer.keys.at(-1).x + renderer.keys.at(-1).width, renderer.width);
});

test('keyboard hit detection follows zoomed black and white keys', () => {
  const { renderer, bounds } = rendererFixture();
  const anchor = renderer.keyByMidi.get(61).center;
  renderer.setZoom(3, anchor);
  const black = renderer.keyByMidi.get(61);
  assert.equal(renderer.noteAt(bounds.left + black.center, bounds.top + renderer.strikeY + 12), 61);
  const white = renderer.keyByMidi.get(60);
  assert.equal(renderer.noteAt(bounds.left + white.center, bounds.top + renderer.height - 8), 60);
  assert.equal(renderer.noteAt(bounds.left + white.center, bounds.top + renderer.strikeY - 1), null);
});

test('orientation changes preserve the musical position at the viewport centre', () => {
  const { renderer, bounds } = rendererFixture();
  const anchor = renderer.keyByMidi.get(61).center;
  renderer.setZoom(3, anchor);
  renderer.panBy(renderer.width / 2 - renderer.keyByMidi.get(61).center);
  bounds.width = 390;
  bounds.height = 700;
  renderer.resize();
  assert.ok(Math.abs(renderer.keyByMidi.get(61).center - renderer.width / 2) < 1e-8);
  assert.equal(renderer.zoom, 3);
});

test('short-note fingering badges and hit targets use the same visible geometry', () => {
  const { renderer, bounds, notes, text } = rendererFixture();
  renderer.setZoom(3, renderer.keyByMidi.get(61).center);
  renderer.render({ time: 0, lookAhead: 1, colorMode: 'fingers', hand: 'right' });
  const rect = renderer.noteBounds(notes[1]);
  assert.ok(rect.height >= 17);
  assert.equal(renderer.noteFromPoint(bounds.left + rect.key.center, bounds.top + rect.y + rect.height / 2), notes[1]);
  assert.ok(text.some(([label]) => label === '2'));
  assert.equal(renderer.noteFromPoint(bounds.left + rect.key.center, bounds.top + renderer.height - 2), null);
  renderer.render({ time: 0, lookAhead: 1, colorMode: 'fingers', hand: 'left' });
  assert.equal(renderer.noteFromPoint(bounds.left + rect.key.center, bounds.top + rect.y + rect.height / 2), null);
});

test('finger badges never replace hand colours on marked or unmarked notes', () => {
  const { renderer, stops, fills } = rendererFixture({ width: 1260 });
  for (const theme of ['dark', 'light']) {
    assert.equal(new Set(FINGER_COLORS[theme]).size, 5);
    stops.length = fills.length = 0;
    renderer.render({ time: -.1, lookAhead: 1, colorMode: 'fingers', theme });
    assert.ok(fills.includes(FINGER_COLORS[theme][1]));
    assert.ok(!stops.includes(FINGER_COLORS[theme][1]));
    assert.ok(stops.includes(theme === 'dark' ? '#b8a3ea' : '#9b7bc7'));
    assert.ok(stops.includes(theme === 'dark' ? '#9ae3bf' : '#4eae83'));
  }
});

test('wide notes have no redundant hand letters and ambiguous fingers retain their hand colour', () => {
  const { renderer, text, stops, notes } = rendererFixture({ width: 1260 });
  notes[0].fingering = '3/4';
  notes[1].duration = 1;
  renderer.setZoom(3, renderer.keyByMidi.get(61).center);
  for (const colorMode of ['hands', 'fingers']) {
    for (const theme of ['light', 'dark']) {
      text.length = stops.length = 0;
      renderer.render({ time: -.1, lookAhead: 1, colorMode, theme });
      assert.ok(!text.some(([label]) => label === 'L' || label === 'R'));
    }
  }
  renderer.resetView();
  renderer.render({ time: -.1, lookAhead: 1, colorMode: 'fingers' });
  assert.ok(text.some(([label]) => label === '3/4'));
  assert.ok(stops.includes('#b8a3ea'));
});

test('zoom indicates unplayed offscreen targets and skips already matched ones', () => {
  const { renderer, text } = rendererFixture();
  renderer.setZoom(4);
  renderer.render({ time: 0, waiting: true, expected: new Set([36, 84]), matched: new Set([36]) });
  assert.ok(text.some(([label]) => label === '1 ›'));
  assert.ok(!text.some(([label]) => label === '‹ 1'));
});

test('reduced motion retains hit feedback without moving particles', () => {
  const { renderer } = rendererFixture({ reducedMotion: true });
  renderer.hit(61);
  assert.equal(renderer.particles.length, 0);
  assert.equal(renderer.flashes.has(61), true);
});

test('unmarked notes retain pitch labels in finger mode and zoomed phone keys show their names', () => {
  const { renderer, text } = rendererFixture({ width: 1260 });
  renderer.render({ time: -.1, lookAhead: 1, colorMode: 'fingers' });
  assert.ok(text.some(([label, , y]) => label === 'C' && y < renderer.strikeY));
  const phone = rendererFixture({ width: 320 });
  phone.renderer.setZoom(2.5);
  phone.renderer.render({ time: -.1, lookAhead: 1, colorMode: 'hands' });
  assert.ok(phone.text.some(([label, , y]) => label === 'D' && y > phone.renderer.strikeY));
  assert.ok(phone.text.some(([label, , y]) => label === 'C♯' && y > phone.renderer.strikeY));
});
