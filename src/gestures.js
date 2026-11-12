const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Keep score scrubbing, two-finger view changes and keyboard taps separate. */
export class RollGestures {
  constructor(canvas, options) {
    this.canvas = canvas;
    this.options = options;
    this.points = new Map();
    this.gesture = null;
    this.pinched = false;
    canvas.addEventListener('pointerdown', event => this.start(event));
    canvas.addEventListener('pointermove', event => this.move(event));
    canvas.addEventListener('pointerup', event => this.end(event));
    canvas.addEventListener('pointercancel', event => this.end(event, true));
    canvas.addEventListener('lostpointercapture', event => this.end(event, true));
    canvas.addEventListener('wheel', event => this.wheel(event), { passive: false });
    // Prevent Safari's page-level gesture from competing with our canvas view.
    for (const type of ['gesturestart', 'gesturechange']) canvas.addEventListener(type, event => event.preventDefault());
  }

  get busy() { return this.points.size > 0; }
  get scrubbing() { return this.pinched || ['time', 'pan'].includes(this.gesture?.axis); }

  pair() {
    const [a, b] = [...this.points.values()];
    return { distance: Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2 };
  }

  start(event) {
    if (!this.options.ready() || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    // Keep the original pair stable if a third finger brushes the screen.
    if (this.points.size >= 2) return;
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.canvas.setPointerCapture(event.pointerId);
    const { renderer } = this.options;
    if (this.points.size === 1) {
      this.pinched = false;
      this.gesture = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        position: this.options.position(), speed: this.options.speed(), axis: event.altKey ? 'pan' : null,
        key: renderer.noteAt(event.clientX, event.clientY),
        note: renderer.noteFromPoint(event.clientX, event.clientY), lastX: event.clientX,
      };
    } else if (this.points.size === 2) {
      this.pinched = true;
      const pair = this.pair();
      this.gesture = { axis: 'pinch', distance: pair.distance, zoom: renderer.zoom, lookAhead: this.options.lookAhead(), lastX: pair.x };
      this.options.stopSounds();
    }
  }

  move(event) {
    if (!this.points.has(event.pointerId)) return;
    this.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { renderer } = this.options;
    const gesture = this.gesture;
    if (this.points.size >= 2 && gesture?.axis === 'pinch') {
      const pair = this.pair();
      const factor = pair.distance / gesture.distance;
      const bounds = this.canvas.getBoundingClientRect();
      renderer.setZoom(gesture.zoom * factor, gesture.lastX - bounds.left);
      renderer.panBy(pair.x - gesture.lastX);
      this.options.setLookAhead(gesture.lookAhead / factor);
      gesture.lastX = pair.x;
      this.options.viewChanged();
      this.options.feedback(`${renderer.zoom.toFixed(1)}× · ${this.options.lookAhead()}s`);
      return;
    }
    if (this.pinched || !gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(dx, dy) > 8) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'speed' : 'time';
      this.options.stopSounds();
    }
    if (gesture.axis === 'time') {
      this.options.seek(gesture.position - dy / Math.max(60, renderer.strikeY) * this.options.lookAhead());
      this.options.feedback(this.options.positionText());
    } else if (gesture.axis === 'speed') {
      this.options.setSpeed((gesture.speed + dx / Math.max(300, renderer.width) * 1.5) * 100);
      this.options.feedback(`${Math.round(this.options.speed() * 100)}%`);
    } else if (gesture.axis === 'pan') {
      renderer.panBy(event.clientX - gesture.lastX);
      gesture.lastX = event.clientX;
      this.options.viewChanged();
    }
  }

  end(event, cancelled = false) {
    if (!this.points.has(event.pointerId)) return;
    this.points.delete(event.pointerId);
    if (!this.points.size) {
      const gesture = this.gesture;
      this.gesture = null;
      if (!cancelled && !this.pinched && gesture && !gesture.axis) {
        if (gesture.key !== null && gesture.key !== undefined) this.options.key(gesture.key);
        else if (gesture.note) this.options.note(gesture.note);
      }
      this.pinched = false;
      this.options.feedback('');
    }
  }

  cancel() {
    this.points.clear();
    this.gesture = null;
    this.pinched = false;
    this.options.feedback('');
  }

  wheel(event) {
    if (!this.options.ready()) return;
    event.preventDefault();
    const { renderer } = this.options;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-clamp(event.deltaY, -100, 100) * .006);
      renderer.setZoom(renderer.zoom * factor, event.clientX - this.canvas.getBoundingClientRect().left);
      const now = performance.now();
      const current = this.options.lookAhead();
      if (!this.wheelZoom || now - this.wheelZoom.at > 250 || current !== this.wheelZoom.applied) {
        this.wheelZoom = { seconds: current };
      }
      // Trackpad events can be much smaller than one slider step. Keep their
      // unrounded total so slow pinches still change temporal magnification.
      this.wheelZoom.seconds = clamp(this.wheelZoom.seconds / factor, .5, 16);
      this.options.setLookAhead(this.wheelZoom.seconds);
      this.wheelZoom.applied = this.options.lookAhead();
      this.wheelZoom.at = now;
      this.options.viewChanged();
    } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      if (renderer.zoom > 1) { renderer.panBy(-(event.deltaX || event.deltaY)); this.options.viewChanged(); }
      else this.options.setSpeed(this.options.speed() * 100 + Math.sign(event.deltaX || event.deltaY) * 5);
    } else this.options.seek(this.options.position() + event.deltaY / Math.max(60, renderer.strikeY) * this.options.lookAhead());
  }
}
