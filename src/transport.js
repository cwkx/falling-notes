const EPSILON = 0.00001;

export class Transport {
  constructor(score) {
    this.score = score;
    this.position = -2;
    this.speed = 1;
    this.mode = 'wait';
    this.hand = 'both';
    this.playing = false;
    this.waiting = false;
    this.matched = new Set();
    this.loop = null;
    this.loopGap = 1;
    this.loopRest = 0;
    this.revision = 0;
    this.rebuildEvents();
  }

  rebuildEvents() {
    this.events = this.score.events.map(event => ({
      ...event,
      notes: event.notes.filter(note => this.hand === 'both' || note.hand === this.hand),
    })).filter(event => event.notes.length);
    this.seek(this.position);
  }

  get target() { return this.events[this.index] || null; }
  get token() { return `${this.revision}:${this.index}`; }
  get expected() { return new Set(this.target?.notes.map(note => note.midi) || []); }

  setHand(hand) {
    this.hand = hand;
    this.rebuildEvents();
  }

  setMode(mode) {
    this.mode = mode;
    this.seek(this.position);
  }

  seek(position) {
    this.position = Math.max(-2, Math.min(this.score.duration, position));
    this.index = this.events.findIndex(event => event.time >= this.position - EPSILON);
    if (this.index < 0) this.index = this.events.length;
    this.matched.clear();
    this.waiting = false;
    this.loopRest = 0;
    this.revision++;
  }

  accept(pitches) {
    if (!this.playing || this.mode !== 'wait' || !this.waiting || !this.target) return [];
    const expected = this.expected;
    const fresh = [];
    for (const midi of pitches) {
      if (expected.has(midi) && !this.matched.has(midi)) {
        this.matched.add(midi);
        fresh.push(midi);
      }
    }
    if ([...expected].every(midi => this.matched.has(midi))) {
      this.index++;
      this.waiting = false;
      this.position += EPSILON * 2;
      this.matched.clear();
    }
    return fresh;
  }

  step(delta) {
    if (!this.playing) return [];
    const elapsed = Math.min(Math.max(0, delta), 0.1);
    if (this.loopRest > 0) {
      this.loopRest = Math.max(0, this.loopRest - elapsed);
      return [];
    }
    let next = this.position + elapsed * this.speed;
    const sounded = [];
    if (this.mode === 'wait' && this.target && next >= this.target.time) {
      next = this.target.time;
      this.waiting = true;
    } else if (this.mode === 'listen') {
      while (this.target && this.target.time <= next && (!this.loop || this.target.time < this.loop.end)) {
        // Multiple voices may write the same key at one onset. Sound it once,
        // keeping the longest written duration; later attacks still repeat it.
        const pitches = new Map();
        for (const note of this.target.notes) {
          const previous = pitches.get(note.midi);
          if (!previous || note.duration > previous.duration) pitches.set(note.midi, note);
        }
        sounded.push(...pitches.values());
        this.index++;
      }
    }
    if (this.loop && next >= this.loop.end) {
      this.seek(this.loop.start);
      this.loopRest = this.loopGap;
    } else {
      this.position = next;
      if (this.position >= this.score.duration + 0.6) {
        this.position = this.score.duration;
        this.playing = false;
        this.waiting = false;
      }
    }
    return sounded;
  }
}
