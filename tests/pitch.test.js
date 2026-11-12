import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitches, midiFrequency, NoteGate } from '../src/pitch.js';
import { PianoAudio } from '../src/audio.js';

const sampleRate = 48000;
const fftSize = 16384;
// Synthetic spectra use a finite-width log-parabolic peak, the same kind of
// peaks returned by a windowed FFT; tests exercise off-bin interpolation too.
function spectrumFor(notes, { tuning = 440, fundamental = 1, noise = -110 } = {}) {
  const spectrum = new Float32Array(fftSize / 2).fill(noise);
  for (const { midi, gain = 1 } of notes.map(note => typeof note === 'number' ? { midi: note } : note)) {
    for (let harmonic = 1; harmonic <= 7; harmonic++) {
      const centre = midiFrequency(midi, tuning) * harmonic * fftSize / sampleRate;
      const strength = -30 + 20 * Math.log10(gain * (harmonic === 1 ? fundamental : 1 / harmonic));
      for (let bin = Math.max(0, Math.floor(centre - 3)); bin <= Math.min(spectrum.length - 1, Math.ceil(centre + 3)); bin++) {
        const partial = strength - 10 * (bin - centre) ** 2;
        spectrum[bin] = 10 * Math.log10(10 ** (spectrum[bin] / 10) + 10 ** (partial / 10));
      }
    }
  }
  return spectrum;
}

const detected = (spectrum, expected, options) => detectPitches(spectrum, sampleRate, fftSize, expected, options).notes.filter(note => note.present).map(note => note.midi);

test('recognises separated piano chord tones without accepting neighbouring semitones', () => {
  assert.deepEqual(detected(spectrumFor([48, 64, 67]), [48, 49, 63, 64, 66, 67]), [48, 64, 67]);
});

test('supports detuned pianos and an explicit tuning reference', () => {
  assert.deepEqual(detected(spectrumFor([45, 61, 69], { tuning: 435 }), [45, 61, 69]), [45, 61, 69]);
  assert.deepEqual(detected(spectrumFor([45, 61, 69], { tuning: 432 }), [45, 61, 69], { referencePitch: 432 }), [45, 61, 69]);
});

test('silence and broadband noise never match notes', () => {
  assert.deepEqual(detected(new Float32Array(fftSize / 2).fill(-Infinity), [21, 48, 60, 69, 108]), []);
  const noisy = new Float32Array(fftSize / 2).map((_, index) => -45 + Math.sin(index * 13.7) * 2);
  assert.deepEqual(detected(noisy, [21, 48, 60, 69, 108]), []);
});

test('a bass note still matches with a weak fundamental', () => {
  assert.deepEqual(detected(spectrumFor([33], { fundamental: 0.02 }), [33]), [33]);
  assert.deepEqual(detected(spectrumFor([33], { fundamental: 0 }), [33]), [33]);
});

test('a lower note does not pass its octave merely through harmonics', () => {
  assert.deepEqual(detected(spectrumFor([48]), [48, 60, 67, 72]), [48]);
  assert.deepEqual(detected(spectrumFor([33], { fundamental: 0.02 }), [33, 45]), [33]);
  assert.deepEqual(detected(spectrumFor([33], { fundamental: 0 }), [33, 45]), [33]);
});

test('an actually played octave adds enough energy to count as two notes', () => {
  assert.deepEqual(detected(spectrumFor([48, 60]), [48, 60]), [48, 60]);
});

test('distinguishes all three opening Rachmaninoff octaves from the bass alone', () => {
  assert.deepEqual(detected(spectrumFor([33, 45, 57]), [33, 45, 57]), [33, 45, 57]);
  assert.deepEqual(detected(spectrumFor([33]), [33, 45, 57]), [33]);
});

function blackmanSpectrum(midis) {
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  for (let index = 0; index < fftSize; index++) {
    let sample = 0;
    for (const midi of midis) {
      for (let harmonic = 1; harmonic <= 7; harmonic++) {
        // Slight inharmonicity models stretched piano strings.
        const frequency = midiFrequency(midi) * harmonic * Math.sqrt(1 + 0.00015 * harmonic ** 2);
        sample += 0.08 / harmonic * Math.sin(2 * Math.PI * frequency * index / sampleRate);
      }
    }
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * index / fftSize) + 0.08 * Math.cos(4 * Math.PI * index / fftSize);
    real[index] = sample * window;
  }
  for (let index = 1, reverse = 0; index < fftSize; index++) {
    let bit = fftSize >> 1;
    for (; reverse & bit; bit >>= 1) reverse ^= bit;
    reverse ^= bit;
    if (index < reverse) [real[index], real[reverse]] = [real[reverse], real[index]];
  }
  for (let size = 2; size <= fftSize; size *= 2) {
    for (let start = 0; start < fftSize; start += size) {
      for (let index = 0; index < size / 2; index++) {
        const angle = -2 * Math.PI * index / size;
        const odd = start + index + size / 2;
        const even = start + index;
        const r = real[odd] * Math.cos(angle) - imag[odd] * Math.sin(angle);
        const i = real[odd] * Math.sin(angle) + imag[odd] * Math.cos(angle);
        real[odd] = real[even] - r;
        imag[odd] = imag[even] - i;
        real[even] += r;
        imag[even] += i;
      }
    }
  }
  return Float32Array.from(real.subarray(0, fftSize / 2), (value, index) => 20 * Math.log10(Math.max(1e-8, Math.hypot(value, imag[index]) / fftSize)));
}

test('recognises windowed PCM piano spectra with overlapping bass harmonics', () => {
  assert.deepEqual(detected(blackmanSpectrum([33, 45, 57]), [33, 45, 57]), [33, 45, 57]);
  assert.deepEqual(detected(blackmanSpectrum([33]), [33, 45, 57]), [33]);
  assert.deepEqual(detected(blackmanSpectrum([49, 56, 64]), [48, 49, 56, 60, 64, 68]), [49, 56, 64]);
});

const evidence = (midi, strength = -30, present = true) => [{ midi, present, confidence: present ? 0.9 : 0, strength }];

test('requires sustained evidence, then retains played chord notes', () => {
  const gate = new NoteGate();
  gate.setTarget([60, 64], 'one');
  assert.deepEqual(gate.update(evidence(60), 0).matches, []);
  assert.deepEqual(gate.update(evidence(60), 70).matches, [60]);
  gate.update(evidence(64), 100);
  assert.deepEqual(gate.update(evidence(64), 180).matches, [60, 64]);
});

test('a held repeated pitch cannot advance the next score event', () => {
  const gate = new NoteGate();
  gate.setTarget([60], 1);
  for (const timestamp of [0, 40, 80, 120, 160, 200, 240]) gate.update(evidence(60), timestamp);
  gate.setTarget([60], 2);
  for (const timestamp of [250, 300, 400, 600]) assert.deepEqual(gate.update(evidence(60), timestamp).matches, []);
  gate.update(evidence(60, -90, false), 650);
  gate.update(evidence(60, -90, false), 760);
  gate.update(evidence(60), 800);
  assert.deepEqual(gate.update(evidence(60), 880).matches, [60]);
});

test('a fresh strike can retrigger a repeated pitch while the pedal is down', () => {
  const gate = new NoteGate();
  gate.setTarget([60], 1);
  for (const timestamp of [0, 40, 80, 120, 160, 200, 240]) gate.update(evidence(60, -42), timestamp);
  gate.setTarget([60], 2);
  gate.update(evidence(60, -42), 300);
  gate.update(evidence(60, -28), 400);
  assert.deepEqual(gate.update(evidence(60, -28), 480).matches, [60]);
});

test('notices a released pitch while a different score event is active', () => {
  const gate = new NoteGate();
  gate.setTarget([60], 1);
  gate.update(evidence(60), 0);
  gate.update(evidence(60), 80);
  gate.setTarget([64], 2);
  gate.update(evidence(64), 120);
  gate.update(evidence(64), 240);
  gate.setTarget([60], 3);
  gate.update(evidence(60), 280);
  assert.deepEqual(gate.update(evidence(60), 360).matches, [60]);
});

test('does not bank a held chord played early during preroll', () => {
  const gate = new NoteGate();
  gate.setTarget([60], 'upcoming');
  for (const timestamp of [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400]) {
    assert.deepEqual(gate.update(evidence(60), timestamp, true, false).matches, []);
  }
  for (const timestamp of [440, 480, 520]) {
    assert.deepEqual(gate.update(evidence(60), timestamp, true, true).matches, []);
  }
  gate.update(evidence(60, -90, false), 560);
  gate.update(evidence(60, -90, false), 680);
  gate.update(evidence(60), 720);
  assert.deepEqual(gate.update(evidence(60), 800).matches, [60]);
});

function installAudioMocks(t, getUserMedia) {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const noop = () => {};
  class MockContext {
    state = 'running';
    sampleRate = 48000;
    destination = {};
    resume() { this.state = 'running'; return Promise.resolve(); }
    createDynamicsCompressor() {
      return { threshold: {}, ratio: {}, attack: {}, release: {}, connect: noop, disconnect: noop };
    }
    createMediaStreamSource() { return { connect: noop, disconnect: noop }; }
    createAnalyser() {
      return { fftSize: 0, frequencyBinCount: fftSize / 2, disconnect: noop,
        getFloatFrequencyData: data => data.fill(-Infinity),
        getFloatTimeDomainData: data => data.fill(0) };
    }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: MockContext });
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else delete globalThis.navigator;
    if (previousContext) Object.defineProperty(globalThis, 'AudioContext', previousContext);
    else delete globalThis.AudioContext;
  });
}

function fakeStream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
  return { getAudioTracks: () => [track], getTracks: () => [track], track };
}

test('stopping while microphone permission is pending closes the later stream', async t => {
  let allow;
  installAudioMocks(t, () => new Promise(resolve => { allow = resolve; }));
  const audio = new PianoAudio();
  const pending = audio.startMicrophone();
  audio.stopMicrophone();
  const stream = fakeStream();
  allow(stream);
  await pending;
  assert.equal(stream.track.readyState, 'ended');
  assert.equal(audio.active, false);
});

test('an older microphone request cannot replace or stop a newer stream', async t => {
  const allows = [];
  installAudioMocks(t, () => new Promise(resolve => { allows.push(resolve); }));
  const audio = new PianoAudio();
  const first = audio.startMicrophone();
  audio.stopMicrophone();
  const second = audio.startMicrophone();
  const currentStream = fakeStream();
  allows[1](currentStream);
  await second;
  const staleStream = fakeStream();
  allows[0](staleStream);
  await first;
  assert.equal(staleStream.track.readyState, 'ended');
  assert.equal(currentStream.track.readyState, 'live');
  assert.equal(audio.stream, currentStream);
  audio.stopMicrophone();
  assert.equal(currentStream.track.readyState, 'ended');
});

test('denied microphone permission produces an actionable error', async t => {
  installAudioMocks(t, async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  const audio = new PianoAudio();
  await assert.rejects(audio.startMicrophone(), /Allow microphone access in your browser settings/);
  assert.equal(audio.active, false);
});

test('poll reports audio interruption and stopped microphone tracks', async t => {
  const stream = fakeStream();
  installAudioMocks(t, async () => stream);
  const audio = new PianoAudio();
  await audio.startMicrophone();
  assert.equal(audio.poll([60], 0).active, true);
  audio.context.state = 'suspended';
  assert.equal(audio.poll([60], 50).suspended, true);
  await audio.resume();
  assert.equal(audio.poll([60], 100).active, true);
  stream.track.stop();
  assert.equal(audio.poll([60], 150).active, false);
  audio.stopMicrophone();
});
