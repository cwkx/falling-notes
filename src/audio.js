import { detectPitches, midiFrequency, NoteGate } from './pitch.js';

const microphoneMessage = error => {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Microphone blocked. Allow microphone access in your browser settings, then try again.';
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'No microphone found. Connect a microphone, or switch to Listen.';
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return 'Microphone unavailable. Close other apps using it, then try again.';
  return 'Could not start the microphone. Try again, or switch to Listen.';
};

export class PianoAudio {
  constructor() {
    this.context = null;
    this.output = null;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.referencePitch = 440;
    this.sensitivity = 0.55;
    this.gate = new NoteGate();
    this.voices = new Set();
    this.lastPoll = -Infinity;
    this.lastResult = { matches: [], level: 0, active: false, attack: false, tuning: 0 };
    this.requestId = 0;
    this.targetToken = undefined;
    this.accepting = true;
  }

  get active() {
    return !!this.stream?.getAudioTracks().some(track => track.readyState === 'live');
  }

  async resume() {
    const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContext) throw new Error('Audio is unavailable in this browser.');
    if (!this.context || this.context.state === 'closed') {
      this.output?.disconnect();
      this.output = null;
      this.context = new AudioContext({ latencyHint: 'interactive' });
    }
    if (!this.output) {
      this.output = this.context.createDynamicsCompressor();
      this.output.threshold.value = -12;
      this.output.ratio.value = 6;
      this.output.attack.value = 0.003;
      this.output.release.value = 0.2;
      this.output.connect(this.context.destination);
    }
    if (this.context.state !== 'running') await this.context.resume();
    return this.context;
  }

  async startMicrophone() {
    if (this.active) {
      await this.resume();
      return;
    }
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access needs HTTPS and a supported browser.');
    }
    const requestId = ++this.requestId;
    // Start resume synchronously in the user's tap, before a permission prompt.
    const contextPromise = this.resume().then(context => ({ context }), error => ({ error }));
    this.stopSounds();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
      });
      const audio = await contextPromise;
      if (audio.error) throw audio.error;
      const { context } = audio;
      if (requestId !== this.requestId) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      this.stream = stream;
      this.stopSounds();
      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 16384;
      this.analyser.smoothingTimeConstant = 0;
      this.analyser.minDecibels = -110;
      this.analyser.maxDecibels = -10;
      this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
      this.waveform = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      // Deliberately never connect the input to speakers: no feedback loop and
      // no recording. The analyser remains usable without an output connection.
      this.gate.reset();
      this.lastPoll = -Infinity;
      if (context.state !== 'running') await context.resume();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (requestId === this.requestId) {
        this.source?.disconnect();
        this.source = null;
        this.stream = null;
      }
      // Observe an early resume rejection even if permission was also denied.
      await contextPromise;
      throw new Error(microphoneMessage(error));
    }
  }

  stopMicrophone() {
    this.requestId++;
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.gate.reset();
    this.lastResult = { matches: [], level: 0, active: false, attack: false, tuning: 0 };
  }

  setTarget(notes, token) {
    this.targetToken = token;
    this.gate.setTarget(notes, token);
    this.lastPoll = -Infinity;
    this.lastResult = { ...this.lastResult, matches: [], attack: false };
  }

  // Use after an explicit seek/restart so the user can play the first target
  // afresh without carrying recognition state from a different score position.
  reset() {
    this.gate.reset();
    this.lastPoll = -Infinity;
  }

  poll(expected = [], timestamp = performance.now(), accepting = true) {
    if (!this.active || !this.analyser || this.context?.state !== 'running') {
      return { matches: [], level: 0, active: this.active, attack: false, tuning: 0, suspended: this.active };
    }
    this.gate.setTarget(expected, this.targetToken);
    if (accepting !== this.accepting) this.lastPoll = -Infinity;
    this.accepting = accepting;
    if (timestamp - this.lastPoll < 30) return this.lastResult;
    this.lastPoll = timestamp;
    this.analyser.getFloatFrequencyData(this.spectrum);
    this.analyser.getFloatTimeDomainData(this.waveform);
    let squared = 0;
    for (let index = 0; index < this.waveform.length; index += 4) squared += this.waveform[index] ** 2;
    const rms = Math.sqrt(squared / (this.waveform.length / 4));
    const level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-7)) + 65) / 55));
    const tracked = [...new Set([...expected, ...this.gate.states.keys()])];
    const evidence = detectPitches(this.spectrum, this.context.sampleRate, this.analyser.fftSize, tracked, {
      referencePitch: this.referencePitch,
      sensitivity: this.sensitivity,
      scorePitches: expected,
    });
    const audible = rms > 0.0005 + (1 - this.sensitivity) * 0.002;
    const result = this.gate.update(evidence.notes, timestamp, audible, accepting);
    const tunings = evidence.notes.filter(note => note.present).map(note => note.cents).sort((a, b) => a - b);
    this.lastResult = { ...result, level, active: true, tuning: tunings[Math.floor(tunings.length / 2)] ?? 0 };
    return this.lastResult;
  }

  play(midi, duration = 0.7) {
    if (this.active || !this.context || this.context.state !== 'running') return;
    const context = this.context;
    const start = context.currentTime;
    const release = Math.max(0.1, Math.min(duration, 8));
    const gain = context.createGain();
    const fundamental = midiFrequency(midi, this.referencePitch);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.075, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.028, start + 0.11);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + release + 0.35);
    gain.connect(this.output);
    const oscillators = [1, 2, 3, 4].filter(harmonic => fundamental * harmonic < context.sampleRate / 2).map(harmonic => {
      const oscillator = context.createOscillator();
      const partialGain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = fundamental * harmonic * (1 + (harmonic - 1) * 0.00015);
      partialGain.gain.value = 1 / harmonic ** 2.4;
      oscillator.connect(partialGain);
      partialGain.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + release + 0.4);
      oscillator.onended = () => { oscillator.disconnect(); partialGain.disconnect(); };
      return oscillator;
    });
    const voice = { gain, oscillators };
    this.voices.add(voice);
    oscillators[0].addEventListener('ended', () => { gain.disconnect(); this.voices.delete(voice); });
    // Bound CPU during fast scrubbing or unusually dense imported scores.
    if (this.voices.size > 48) this.stopVoice(this.voices.values().next().value);
  }

  stopVoice(voice) {
    voice.gain.disconnect();
    for (const oscillator of voice.oscillators) {
      try { oscillator.stop(); } catch { /* Already ended. */ }
    }
    this.voices.delete(voice);
  }

  stopSounds() {
    for (const voice of this.voices) this.stopVoice(voice);
  }
}
