const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const EMPTY = new Set();

export const FINGER_COLORS = {
  dark: ['#f0bc6b', '#76c8eb', '#ed91b8', '#a7da83', '#c2a1ed'],
  light: ['#aa691a', '#247ba4', '#b74677', '#507e29', '#7950ad'],
};

const THEMES = {
  dark: {
    background: '#101416', lane: 'rgba(221, 236, 228, .035)',
    octave: 'rgba(221, 236, 228, .075)', measure: 'rgba(221, 236, 228, .08)',
    text: '#708079', right: '#9ae3bf', left: '#b8a3ea',
    rightDark: '#427d64', leftDark: '#756394',
    keyTop: '#e5e9e5', keyBottom: '#bcc7c0', keyEdge: '#929e97',
    blackTop: '#303938', blackBottom: '#151b1b', blackEdge: '#46504b',
    label: '#6b7870', blackLabel: '#9ba9a2', line: '#9ae3bf',
  },
  light: {
    background: '#edf2ef', lane: 'rgba(29, 64, 44, .035)',
    octave: 'rgba(29, 64, 44, .09)', measure: 'rgba(29, 64, 44, .10)',
    text: '#84918a', right: '#4eae83', left: '#9b7bc7',
    rightDark: '#b9dfcd', leftDark: '#d8cae8',
    keyTop: '#ffffff', keyBottom: '#e1e9e3', keyEdge: '#c6d1ca',
    blackTop: '#414d46', blackBottom: '#222e27', blackEdge: '#59665e',
    label: '#7b8c81', blackLabel: '#c6d3ca', line: '#4eae83',
  },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function firstAtOrAfter(items, time, field = 'start') {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (items[mid][field] < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Canvas-only view: musical time and matching are controlled by the transport. */
export class FallingRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.score = null;
    this.notes = [];
    this.measures = [];
    this.maxDuration = 1;
    this.minMidi = 48;
    this.maxMidi = 83;
    this.width = 1;
    this.height = 1;
    this.zoom = 1;
    this.pan = 0;
    this.keys = [];
    this.keyByMidi = new Map();
    this.flashes = new Map();
    this.particles = [];
    this.lastFrame = null;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.resize();
  }

  setScore(score) {
    this.score = score;
    this.notes = [...(score?.notes || [])].sort((a, b) => a.start - b.start);
    this.measures = [...(score?.measures || [])].sort((a, b) => a.start - b.start);
    this.maxDuration = this.notes.reduce((longest, note) => Math.max(longest, note.duration), 1);
    const low = this.notes.reduce((min, note) => Math.min(min, note.midi), 127);
    const high = this.notes.reduce((max, note) => Math.max(max, note.midi), 0);
    this.minMidi = this.notes.length ? clamp(Math.floor(low / 12) * 12, 0, 120) : 48;
    this.maxMidi = this.notes.length ? clamp(Math.ceil((high + 1) / 12) * 12 - 1, 11, 127) : 83;
    // A short exercise still has enough surrounding keys to make its position clear.
    if (this.maxMidi - this.minMidi < 23) {
      this.minMidi = Math.max(0, this.minMidi - 12);
      this.maxMidi = Math.min(127, this.maxMidi + 12);
    }
    this.flashes.clear();
    this.particles.length = 0;
    this.resetView();
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    const center = (this.width / 2 - this.pan) / (this.width * this.zoom);
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.pan = this.width / 2 - center * this.width * this.zoom;
    this.clampPan();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(this.width * ratio);
    const pixelHeight = Math.round(this.height * ratio);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.keyboardHeight = this.height < 320
      ? clamp(this.height * .28, 48, 74)
      : clamp(this.height * .20, 78, 120);
    this.strikeY = this.height - this.keyboardHeight;
    this.layoutKeys();
    if (this.lastFrame) this.render(this.lastFrame);
  }

  clampPan() {
    this.pan = clamp(this.pan, this.width * (1 - this.zoom), 0);
  }

  setZoom(value, anchorX = this.width / 2) {
    const next = clamp(Number(value) || 1, 1, 4);
    const anchor = clamp(anchorX, 0, this.width);
    const position = (anchor - this.pan) / this.zoom;
    this.pan = anchor - position * next;
    this.zoom = next;
    this.clampPan();
    this.layoutKeys();
  }

  panBy(deltaX) {
    if (!Number.isFinite(deltaX)) return;
    this.pan += deltaX;
    this.clampPan();
    this.layoutKeys();
  }

  resetView() {
    this.zoom = 1;
    this.pan = 0;
    this.layoutKeys();
  }

  layoutKeys() {
    const whiteNotes = [];
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      if (!BLACK.has(midi % 12)) whiteNotes.push(midi);
    }
    const whiteWidth = this.width * this.zoom / Math.max(1, whiteNotes.length);
    this.whiteWidth = whiteWidth;
    this.keys = [];
    this.keyByMidi.clear();
    let whiteIndex = 0;
    for (let midi = this.minMidi; midi <= this.maxMidi; midi++) {
      const black = BLACK.has(midi % 12);
      const width = black ? whiteWidth * .62 : whiteWidth;
      const x = this.pan + (black ? whiteIndex * whiteWidth - width / 2 : whiteIndex++ * whiteWidth);
      const key = { midi, black, x, width, center: x + width / 2 };
      this.keys.push(key);
      this.keyByMidi.set(midi, key);
    }
  }

  hit(midi) {
    const key = this.keyByMidi.get(midi);
    if (!key) return;
    const now = performance.now();
    this.flashes.set(midi, now);
    if (this.reducedMotion?.matches || this.particles.length > 200) return;
    for (let i = 0; i < 7; i++) {
      this.particles.push({
        midi, born: now, x: (Math.random() - .5) * key.width,
        dx: (Math.random() - .5) * 34, dy: -24 - Math.random() * 60,
        size: .8 + Math.random() * 1.4,
      });
    }
  }

  noteAt(clientX, clientY) {
    const bounds = this.canvas.getBoundingClientRect();
    const x = (clientX - bounds.left) * this.width / bounds.width;
    const y = (clientY - bounds.top) * this.height / bounds.height;
    if (y < this.strikeY || y > this.height || x < 0 || x >= this.width) return null;
    if (y <= this.strikeY + this.keyboardHeight * .63) {
      const black = this.keys.find(key => key.black && x >= key.x && x < key.x + key.width);
      if (black) return black.midi;
    }
    return this.keys.find(key => !key.black && x >= key.x && x < key.x + key.width)?.midi ?? null;
  }

  noteBounds(note, frame = this.lastFrame) {
    if (!frame || (frame.hand && frame.hand !== 'both' && frame.hand !== note.hand)) return null;
    const time = frame.time ?? 0;
    const lookAhead = Math.max(.5, frame.lookAhead ?? 7);
    if (note.start > time + lookAhead + .1 || note.start + note.duration < time - .04) return null;
    const key = this.keyByMidi.get(note.midi);
    if (!key) return null;
    const pixelsPerSecond = Math.max(1, this.strikeY / lookAhead);
    const bottom = this.strikeY - (note.start - time) * pixelsPerSecond;
    const hasLabel = frame.colorMode === 'fingers' && (note.fingering || note.finger);
    const top = bottom - Math.max(hasLabel ? 17 : 9, note.duration * pixelsPerSecond - 3);
    const x = key.x + Math.min(2, key.width * .13);
    const width = Math.max(2, key.width - Math.min(4, key.width * .26));
    const y = Math.max(-8, top);
    const height = Math.max(3, bottom - y);
    if (x + width <= 0 || x >= this.width || bottom <= 0 || y >= this.strikeY) return null;
    return { x, y, width, height, bottom, key };
  }

  noteFromPoint(clientX, clientY) {
    if (!this.lastFrame) return null;
    const bounds = this.canvas.getBoundingClientRect();
    const x = (clientX - bounds.left) * this.width / bounds.width;
    const y = (clientY - bounds.top) * this.height / bounds.height;
    if (y < 0 || y >= this.strikeY || x < 0 || x >= this.width) return null;
    // Later bars are drawn on top if an unusually short note needs a label badge.
    const end = firstAtOrAfter(this.notes, (this.lastFrame.time ?? 0) + (this.lastFrame.lookAhead ?? 7) + .1);
    for (let index = Math.min(end, this.notes.length - 1); index >= 0; index--) {
      const note = this.notes[index];
      if (note.start < (this.lastFrame.time ?? 0) - this.maxDuration - .1) break;
      const rect = this.noteBounds(note);
      if (rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return note;
    }
    return null;
  }

  render(frame) {
    this.lastFrame = frame;
    const {
      time = 0, lookAhead = 7, waiting = false, expected = EMPTY,
      matched = EMPTY, active = EMPTY, theme = 'dark',
      now = performance.now(), hand = 'both', colorMode = 'hands', selectedNoteId = null, wideNoteIds = EMPTY,
    } = frame;
    const ctx = this.ctx;
    const colors = THEMES[theme] || THEMES.dark;
    const { width, height, strikeY } = this;
    const pixelsPerSecond = Math.max(1, strikeY / Math.max(.5, lookAhead));
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Quiet vertical lanes keep dense chords aligned without competing with notes.
    for (const key of this.keys) {
      if (key.black || key.x < 0 || key.x > width) continue;
      ctx.fillStyle = key.midi % 12 === 0 ? colors.octave : colors.lane;
      ctx.fillRect(Math.round(key.x), 0, 1, strikeY);
    }
    const measureStart = Math.max(0, firstAtOrAfter(this.measures, time) - 1);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (let i = measureStart; i < this.measures.length; i++) {
      const measure = this.measures[i];
      if (measure.start > time + lookAhead) break;
      const y = strikeY - (measure.start - time) * pixelsPerSecond;
      if (y < 2 || y > strikeY - 8) continue;
      ctx.fillStyle = colors.measure;
      ctx.fillRect(0, Math.round(y), width, 1);
      ctx.fillStyle = colors.text;
      ctx.fillText(String(measure.number), 12, y - 5);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, strikeY);
    ctx.clip();
    const start = firstAtOrAfter(this.notes, time - this.maxDuration - .1);
    for (let i = start; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.start > time + lookAhead + .1) break;
      if (note.start + note.duration < time - .04) continue;
      if (hand !== 'both' && note.hand !== hand) continue;
      const bounds = this.noteBounds(note, frame);
      if (!bounds) continue;
      const { key, bottom, x, y, width: noteWidth, height: noteHeight } = bounds;
      const isLeft = note.hand === 'left';
      const knownFinger = Number.isInteger(note.finger) && note.finger >= 1 && note.finger <= 5;
      const fingerMode = colorMode === 'fingers';
      const palette = theme === 'light' ? 'light' : 'dark';
      const fingerColor = fingerMode && knownFinger ? FINGER_COLORS[palette][note.finger - 1] : null;
      const color = isLeft ? colors.left : colors.right;
      const nearLine = Math.abs(note.start - time) < .085;
      const target = nearLine && expected.has(note.midi);
      const complete = target && matched.has(note.midi);
      const fade = clamp((bottom + 16) / 60, .12, 1);
      ctx.globalAlpha = fade * (complete ? .55 : 1);
      const fill = ctx.createLinearGradient(0, y, 0, Math.max(y + 1, bottom));
      fill.addColorStop(0, isLeft ? colors.leftDark : colors.rightDark);
      fill.addColorStop(1, color);
      ctx.fillStyle = fill;
      if (target && waiting) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 11;
      }
      roundRect(ctx, x, y, noteWidth, noteHeight, Math.min(5, noteWidth * .2));
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = color;
      ctx.globalAlpha = fade * .46;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (wideNoteIds.has(note.id)) {
        ctx.globalAlpha = fade;
        ctx.strokeStyle = theme === 'light' ? '#81540c' : '#ffd082';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (note.id === selectedNoteId) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = theme === 'light' ? '#20372c' : '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = fade * .8;
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, bottom - 3, Math.max(1, noteWidth - 2), 2);
      const fingerLabel = colorMode === 'fingers' && (note.fingering || (knownFinger ? String(note.finger) : ''));
      const label = fingerLabel || NOTE_NAMES[note.midi % 12];
      const labelWidth = fingerLabel ? 11 : 19;
      if (label && noteWidth >= labelWidth && noteHeight >= (fingerLabel ? 14 : 23) && bottom > 12) {
        ctx.globalAlpha = fade * .85;
        ctx.fillStyle = theme === 'light' ? '#ffffff' : '#14251e';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const fontSize = fingerLabel ? clamp(noteWidth / Math.max(1.4, label.length * .65), 8, 13) : Math.min(11, noteWidth * .39);
        ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
        const labelY = Math.min(strikeY - 4, bottom - (fingerLabel ? 3 : 7));
        if (fingerColor && noteWidth >= 15) {
          // Fingering annotates the hand-coloured bar without replacing it.
          // Leave a border even on the shortest labelled notes.
          const badgeWidth = Math.min(noteWidth - 4, fontSize * label.length * .65 + 6);
          const badgeHeight = Math.min(noteHeight - 4, fontSize + 4);
          ctx.fillStyle = fingerColor;
          roundRect(ctx, key.center - badgeWidth / 2, labelY - badgeHeight, badgeWidth, badgeHeight + 1, 3);
          ctx.fill();
          ctx.fillStyle = theme === 'light' ? '#ffffff' : '#14251e';
        }
        ctx.fillText(label, key.center, labelY, noteWidth - 2);
      }
    }
    ctx.globalAlpha = 1;

    const horizon = ctx.createLinearGradient(0, Math.max(0, strikeY - 60), 0, strikeY);
    horizon.addColorStop(0, theme === 'light' ? 'rgba(78, 174, 131, 0)' : 'rgba(154, 227, 191, 0)');
    horizon.addColorStop(1, theme === 'light' ? 'rgba(78, 174, 131, .045)' : 'rgba(154, 227, 191, .045)');
    ctx.fillStyle = horizon;
    ctx.fillRect(0, Math.max(0, strikeY - 60), width, 60);

    for (const [midi, born] of this.flashes) {
      const age = (now - born) / 650;
      if (age > 1) { this.flashes.delete(midi); continue; }
      const key = this.keyByMidi.get(midi);
      if (!key) continue;
      const radius = Math.max(18, key.width * 1.5);
      const glow = ctx.createRadialGradient(key.center, strikeY, 0, key.center, strikeY, radius);
      glow.addColorStop(0, `rgba(154, 227, 191, ${.5 * (1 - age)})`);
      glow.addColorStop(1, 'rgba(154, 227, 191, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(key.center - radius, strikeY - radius, radius * 2, radius * 2);
    }

    this.particles = this.reducedMotion?.matches ? [] : this.particles.filter(particle => now - particle.born < 650);
    ctx.fillStyle = colors.right;
    for (const particle of this.particles) {
      const age = (now - particle.born) / 1000;
      const key = this.keyByMidi.get(particle.midi);
      if (!key) continue;
      ctx.globalAlpha = Math.max(0, 1 - age / .65);
      ctx.beginPath();
      ctx.arc(key.center + particle.x + particle.dx * age,
        strikeY - 2 + particle.dy * age + 22 * age * age,
        particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    this.drawKeyboard({ colors, theme, expected, matched, active, waiting, now });
    ctx.fillStyle = colors.line;
    ctx.globalAlpha = waiting ? .9 : .4;
    ctx.fillRect(0, strikeY, width, 1.5);
    ctx.globalAlpha = 1;
    if (this.zoom > 1 && waiting) this.drawOffscreenTargets(expected, matched, colors);
  }

  drawOffscreenTargets(expected, matched, colors) {
    const counts = { left: 0, right: 0 };
    for (const midi of expected) {
      if (matched.has(midi)) continue;
      const key = this.keyByMidi.get(midi);
      if (!key) continue;
      if (key.center < 0) counts.left++;
      else if (key.center > this.width) counts.right++;
    }
    const ctx = this.ctx;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const side of ['left', 'right']) {
      if (!counts[side]) continue;
      const left = side === 'left';
      const x = left ? 5 : this.width - 43;
      const y = Math.max(6, this.strikeY - 39);
      ctx.fillStyle = colors.background;
      roundRect(ctx, x, y, 38, 28, 6);
      ctx.fill();
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = colors.line;
      ctx.textAlign = 'center';
      ctx.fillText(left ? `‹ ${counts.left}` : `${counts.right} ›`, x + 19, y + 14);
    }
  }

  drawKeyboard({ colors, theme, expected, matched, active, waiting, now }) {
    const ctx = this.ctx;
    const { strikeY, keyboardHeight } = this;
    const whites = ctx.createLinearGradient(0, strikeY, 0, this.height);
    whites.addColorStop(0, colors.keyTop);
    whites.addColorStop(.93, colors.keyBottom);
    whites.addColorStop(1, colors.keyEdge);
    const blacks = ctx.createLinearGradient(0, strikeY, 0, strikeY + keyboardHeight * .63);
    blacks.addColorStop(0, colors.blackTop);
    blacks.addColorStop(.91, colors.blackBottom);
    blacks.addColorStop(1, colors.blackEdge);
    for (const black of [false, true]) {
      for (const key of this.keys) {
        if (key.black !== black || key.x + key.width <= 0 || key.x >= this.width) continue;
        const keyHeight = black ? keyboardHeight * .63 : keyboardHeight;
        const gap = black ? Math.min(1, key.width * .05) : Math.min(1.3, key.width * .08);
        ctx.fillStyle = black ? blacks : whites;
        roundRect(ctx, key.x + gap / 2, strikeY + 2, key.width - gap, keyHeight - 2, black ? 2 : 3);
        ctx.fill();
        const born = this.flashes.get(key.midi);
        const flash = born == null ? 0 : Math.max(0, 1 - (now - born) / 650);
        const isActive = active.has(key.midi) || matched.has(key.midi);
        const target = waiting && expected.has(key.midi);
        if (isActive || target || flash > 0) {
          ctx.save();
          ctx.globalAlpha = isActive ? .75 : target ? .45 : flash * .8;
          ctx.fillStyle = colors.right;
          roundRect(ctx, key.x + gap / 2, strikeY + 2, key.width - gap, keyHeight - 2, black ? 2 : 3);
          ctx.fill();
          ctx.restore();
        }
        const showName = !black && (key.midi % 12 === 0 || key.width >= 18) || black && key.width >= 13;
        if (showName && key.width >= 8) {
          ctx.font = `500 ${clamp(key.width * .35, 7, 10)}px system-ui, sans-serif`;
          ctx.fillStyle = black ? colors.blackLabel : colors.label;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = key.midi % 12 === 0 ? `C${Math.floor(key.midi / 12) - 1}` : NOTE_NAMES[key.midi % 12];
          ctx.fillText(label, key.center, strikeY + keyHeight - 9);
        }
        if (target && key.width > 9) {
          ctx.fillStyle = black ? (theme === 'light' ? '#d8efdf' : '#d8efdf') : '#528064';
          ctx.beginPath();
          ctx.arc(key.center, strikeY + keyHeight - (black ? 10 : 24), clamp(key.width * .07, 1.4, 2.3), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  destroy() {
    this.observer.disconnect();
    this.flashes.clear();
    this.particles.length = 0;
  }
}
