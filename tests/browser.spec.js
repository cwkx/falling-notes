import { test, expect } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const errors = new WeakMap();
const position = page => page.locator('#timeline').evaluate(input => Number(input.value));
const range = (page, selector, value) => page.locator(selector).evaluate((input, next) => {
  input.value = String(next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
async function number(page, selector, value) {
  await page.locator(selector).fill(String(value));
  await page.locator(selector).press('Tab');
}
async function drag(page, from, to, touch) {
  if (!touch) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    return;
  }
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, id: 1 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function pinch(page, first, second, scale) {
  const session = await page.context().newCDPSession(page);
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ ...first, id: 1 }, { ...second, id: 2 }],
  });
  for (let step = 1; step <= 8; step++) {
    const factor = 1 + (scale - 1) * step / 8;
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [first, second].map((point, index) => ({
        x: center.x + (point.x - center.x) * factor,
        y: center.y + (point.y - center.y) * factor,
        id: index + 1,
      })),
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

const fingerFixture = `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Finger practice</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><notations><technical><fingering>1</fingering></technical></notations></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>`;
async function importFingerFixture(page) {
  await page.locator('#file').setInputFiles({ name: 'finger-practice.musicxml', mimeType: 'application/xml', buffer: Buffer.from(fingerFixture) });
  await expect(page.locator('#piece-title')).toHaveText('Finger practice');
}

// Find the coloured body of the sole visible note rather than relying on a
// private renderer instance or duplicating the keyboard's pitch geometry.
async function visibleNote(page) {
  return page.locator('#roll').evaluate(canvas => {
    const y = Math.floor(canvas.height * .3);
    const pixels = canvas.getContext('2d').getImageData(0, y, canvas.width, 1).data;
    const coloured = [];
    for (let x = 0; x < canvas.width; x++) {
      const rgb = [...pixels.slice(x * 4, x * 4 + 3)];
      if (Math.max(...rgb) > 85 && Math.max(...rgb) - Math.min(...rgb) > 35) coloured.push(x);
    }
    if (!coloured.length) return null;
    const x = Math.floor((coloured[0] + coloured.at(-1)) / 2);
    const box = canvas.getBoundingClientRect();
    return {
      x: box.x + x / canvas.width * box.width,
      y: box.y + y / canvas.height * box.height,
      rgb: [...pixels.slice(x * 4, x * 4 + 3)],
    };
  });
}

test.beforeEach(async ({ page }) => {
  const pageErrors = [];
  errors.set(page, pageErrors);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'No uncaught browser errors').toEqual([]);
});

test('fits the viewport in both themes and opens settings', async ({ page }, testInfo) => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Wait for me', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#note-legend')).toBeVisible();
  await expect(page.locator('#note-legend')).toContainText('Fingers');
  await expect(page.locator('#note-legend')).toContainText('Unmarked');
  const dimensions = await page.evaluate(() => {
    const canvas = document.querySelector('#roll').getBoundingClientRect();
    const controls = document.querySelector('.controls').getBoundingClientRect();
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
      canvasHeight: canvas.height,
      canvasWidth: canvas.width,
      controlsBottom: controls.bottom,
    };
  });
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.pageHeight).toBeLessThanOrEqual(dimensions.viewportHeight + 1);
  expect(dimensions.controlsBottom).toBeLessThanOrEqual(dimensions.viewportHeight + 1);
  expect(dimensions.canvasHeight).toBeGreaterThan(testInfo.project.name === 'landscape' ? 180 : 400);
  expect(dimensions.canvasWidth).toBeGreaterThan(dimensions.viewportWidth * .9);
  await page.screenshot({ path: join(tmpdir(), `falling-notes-${testInfo.project.name}.png`) });
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  if (testInfo.project.name === 'desktop') await page.screenshot({ path: join(tmpdir(), 'falling-notes-light.png') });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('combobox', { name: 'Hands', exact: true }).selectOption('right');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement || document.documentElement.classList.contains('focus-mode'))).toBe(true);
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeVisible();
});

test('imports MusicXML and MXL, retaining the score after an invalid file', async ({ page }) => {
  const fixture = `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Three notes</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration></note><note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note><note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note></measure></part></score-partwise>`;
  await page.locator('#file').setInputFiles({ name: 'three-notes.musicxml', mimeType: 'application/xml', buffer: Buffer.from(fixture) });
  await expect(page.locator('#piece-title')).toHaveText('Three notes');
  await expect(page.locator('#timeline')).toHaveAttribute('max', '1.5');
  await page.locator('#file').setInputFiles({ name: 'broken.mxl', mimeType: 'application/octet-stream', buffer: Buffer.from('This is not MusicXML.') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#piece-title')).toHaveText('Three notes');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await page.locator('#file').setInputFiles(resolve('prelude-in-c-sharp-minor-opus-3-no-2-sergei-rachmaninoff.mxl'));
  await expect(page.locator('#piece-title')).toContainText('Prelude');
  await expect.poll(() => page.locator('#timeline').getAttribute('max')).not.toBe('1.5');
});

test('Listen advances and pause stops the timeline', async ({ page }) => {
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await range(page, '#timeline', 3);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('Playing');
  await expect.poll(() => position(page)).toBeGreaterThan(3.25);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const stopped = await position(page);
  await page.waitForTimeout(200);
  expect(await position(page)).toBeCloseTo(stopped, 1);
  await expect(page.locator('#status-text')).toHaveText('Paused');
});

test('wait mode uses the microphone and stays at the first chord in silence', async ({ page }) => {
  await range(page, '#timeline', 0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('Your turn');
  await expect(page.locator('#mic-meter')).toHaveClass('live');
  await page.waitForTimeout(850);
  expect(await position(page)).toBeCloseTo(0, 2);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#mic-meter')).not.toHaveClass('live');
});

async function setupTestPiano(page) {
  // Substitute only the microphone source. PCM audio still flows through real
  // MediaStreamAudioSourceNode, AnalyserNode, pitch detection and transport.
  await page.evaluate(() => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const voices = new Map();
    navigator.mediaDevices.getUserMedia = async () => {
      await context.resume();
      return destination.stream;
    };
    window.testPiano = {
      play(midis) {
        for (const midi of midis) {
          if (voices.has(midi)) continue;
          const partials = [];
          for (let harmonic = 1; harmonic <= 7; harmonic++) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12) * harmonic;
            gain.gain.value = .07 / harmonic ** 1.8;
            oscillator.connect(gain).connect(destination);
            oscillator.start();
            partials.push({ oscillator, gain });
          }
          voices.set(midi, partials);
        }
      },
      release(midis = [...voices.keys()]) {
        for (const midi of midis) {
          const partials = voices.get(midi) || [];
          for (const { oscillator, gain } of partials) {
            oscillator.stop();
            oscillator.disconnect();
            gain.disconnect();
          }
          voices.delete(midi);
        }
      },
      async stop() {
        this.release();
        await context.close();
      },
    };
  });
}

test('real audio analysis requires the complete opening octave chord', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Audio analysis is independent of the viewport.');
  await setupTestPiano(page);
  await range(page, '#timeline', 0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('Your turn');
  await page.evaluate(() => window.testPiano.play([33]));
  await expect.poll(() => page.locator('#mic-meter i').first().evaluate(bar => parseFloat(bar.style.height))).toBeGreaterThan(3.2);
  await page.waitForTimeout(850);
  expect(await position(page), 'Bass harmonics must not satisfy the two upper octaves').toBeCloseTo(0, 2);
  await page.evaluate(() => window.testPiano.play([45, 57]));
  await expect.poll(() => position(page), { timeout: 4000 }).toBeGreaterThan(.1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => window.testPiano.stop());
});

test('a held microphone note cannot pass the next loop when the loop pause is off', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Audio analysis is independent of the viewport.');
  const fixture = '<score-partwise><work><work-title>Repeated C</work-title></work><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note></measure></part></score-partwise>';
  await page.locator('#file').setInputFiles({ name: 'repeated-c.musicxml', mimeType: 'application/xml', buffer: Buffer.from(fixture) });
  await expect(page.locator('#piece-title')).toHaveText('Repeated C');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#loop-gap').selectOption('0');
  await page.locator('#loop-measure').click();
  await setupTestPiano(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('Your turn');
  await page.evaluate(() => window.testPiano.play([60]));
  await expect.poll(() => position(page)).toBeGreaterThan(.1);
  await expect.poll(() => position(page)).toBeCloseTo(0, 2);
  await expect(page.locator('#status-text')).toHaveText('Your turn');
  await page.waitForTimeout(500);
  expect(await position(page), 'Held notes must not satisfy another repetition').toBeCloseTo(0, 2);
  await page.evaluate(() => window.testPiano.release([60]));
  await page.waitForTimeout(550);
  await page.evaluate(() => window.testPiano.play([60]));
  await expect.poll(() => position(page)).toBeGreaterThan(.1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.evaluate(() => window.testPiano.stop());
});

test('dragging scrubs in both directions and changes speed', async ({ page }, testInfo) => {
  await range(page, '#timeline', 10);
  const bounds = await page.locator('#roll').boundingBox();
  const x = bounds.x + bounds.width * .5;
  const y = bounds.y + bounds.height * .35;
  const touch = !!testInfo.project.use.hasTouch;
  await drag(page, { x, y }, { x, y: y - 45 }, touch);
  await expect.poll(() => position(page)).toBeGreaterThan(10.3);
  const forward = await position(page);
  await drag(page, { x, y }, { x, y: y + 45 }, touch);
  await expect.poll(() => position(page)).toBeLessThan(forward - .3);
  await drag(page, { x, y }, { x: x + bounds.width * .18, y }, touch);
  expect(Number(await page.locator('#speed').inputValue())).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Reset speed to 100%' }).click();
  await expect(page.locator('#speed')).toHaveValue('100');
});

test('A–B loop returns playback to its start and clears', async ({ page }) => {
  await range(page, '#timeline', 10);
  await page.getByRole('button', { name: 'Set loop start', exact: true }).click();
  await range(page, '#timeline', 12);
  await page.getByRole('button', { name: 'Set loop end', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear loop', exact: true })).toBeVisible();
  expect(await position(page)).toBeCloseTo(10, 1);
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await range(page, '#timeline', 11.8);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => position(page)).toBeLessThan(11);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByRole('button', { name: 'Clear loop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set loop start', exact: true })).toBeVisible();
  await expect(page.locator('#loop-region')).toBeHidden();
});

test('look-ahead supports fractions of a second and playback reaches 10%', async ({ page }) => {
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await number(page, '#lookahead', 1);
  await expect.poll(() => page.locator('#lookahead-range').evaluate(input => Number(input.value))).toBe(1);
  await range(page, '#lookahead-range', .75);
  await expect.poll(() => page.locator('#lookahead').evaluate(input => Number(input.value))).toBe(.75);
  await number(page, '#lookahead', 1);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await range(page, '#speed', 10);
  await expect(page.locator('#speed-value')).toHaveText('10%');
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await range(page, '#timeline', 3);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => position(page)).toBeGreaterThan(3.02);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expect(page.locator('#speed')).toHaveValue('10');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await expect.poll(() => page.locator('#lookahead').evaluate(input => Number(input.value))).toBe(1);
});

test('slow playback starts promptly after restart with a short look-ahead', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Preroll timing is independent of the viewport.');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await number(page, '#lookahead', .5);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await range(page, '#speed', 10);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // Timeline is clamped at zero during preroll, so require positive progress.
  await expect.poll(() => position(page), { timeout: 2500, intervals: [100] }).toBeGreaterThan(.01);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('keyboard zoom, pan and fit controls preserve the score position', async ({ page }) => {
  await range(page, '#timeline', 10);
  await expect(page.locator('#view-pan')).toBeHidden();
  await page.locator('#zoom-in').click();
  await expect.poll(() => page.locator('#keyboard-zoom').evaluate(input => Number(input.value))).toBeGreaterThan(1);
  await expect(page.locator('#view-pan')).toBeVisible();
  await range(page, '#view-pan', 0);
  const left = await page.locator('#roll').evaluate(canvas => canvas.toDataURL());
  await range(page, '#view-pan', 100);
  await expect.poll(() => page.locator('#roll').evaluate(canvas => canvas.toDataURL())).not.toBe(left);
  expect(await position(page)).toBeCloseTo(10, 2);
  await page.locator('#reset-view').click();
  await expect(page.locator('#view-pan')).toBeHidden();
  await expect.poll(() => page.locator('#keyboard-zoom').evaluate(input => Number(input.value))).toBe(1);
  expect(await position(page)).toBeCloseTo(10, 2);
});

test('pinching over the keyboard changes the view without seeking or playing notes', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'Uses a touchscreen gesture.');
  await range(page, '#timeline', 10);
  const beforeLookAhead = await page.locator('#lookahead').evaluate(input => Number(input.value));
  const beforeSpeed = await page.locator('#speed').inputValue();
  await page.evaluate(() => {
    window.oscillatorStarts = 0;
    const originalStart = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.oscillatorStarts++;
      return originalStart.apply(this, args);
    };
  });
  const box = await page.locator('#roll').boundingBox();
  const center = box.x + box.width / 2;
  const y = box.y + box.height - 18;
  await pinch(page, { x: center - 35, y }, { x: center + 35, y }, 2);
  await expect.poll(() => page.locator('#keyboard-zoom').evaluate(input => Number(input.value))).toBeGreaterThan(1.4);
  expect(await page.locator('#lookahead').evaluate(input => Number(input.value))).toBeLessThan(beforeLookAhead);
  expect(await position(page)).toBeCloseTo(10, 2);
  await expect(page.locator('#speed')).toHaveValue(beforeSpeed);
  expect(await page.evaluate(() => window.oscillatorStarts)).toBe(0);
  await expect(page.locator('#finger-dialog')).not.toBeVisible();
});

test('imported finger colours can be edited, remembered, and restored', async ({ page }, testInfo) => {
  const tapNote = point => testInfo.project.use.hasTouch
    ? page.touchscreen.tap(point.x, point.y)
    : page.mouse.click(point.x, point.y);
  await importFingerFixture(page);
  await range(page, '#timeline', 0);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#color-mode').selectOption('fingers');
  await number(page, '#lookahead', 1);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(() => visibleNote(page)).not.toBeNull();
  const original = await visibleNote(page);
  await tapNote(original);
  await expect(page.locator('#finger-dialog')).toBeVisible();
  await expect(page.locator('#finger-note')).toContainText('C');
  await expect(page.locator('#finger-dialog [data-finger="1"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#finger-dialog [data-finger="4"]').click();
  await expect(page.locator('#finger-dialog')).not.toBeVisible();
  await expect.poll(async () => (await visibleNote(page))?.rgb).not.toEqual(original.rgb);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await importFingerFixture(page);
  await range(page, '#timeline', 0);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#color-mode').selectOption('fingers');
  await number(page, '#lookahead', 1);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(() => visibleNote(page)).not.toBeNull();
  const edited = await visibleNote(page);
  await tapNote(edited);
  await expect(page.locator('#finger-dialog [data-finger="4"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#finger-dialog [data-finger="clear"]').click();
  await expect(page.locator('#finger-dialog')).not.toBeVisible();
  await expect.poll(async () => (await visibleNote(page))?.rgb).toEqual(original.rgb);
  const restored = await visibleNote(page);
  await tapNote(restored);
  await expect(page.locator('#finger-dialog [data-finger="1"]')).toHaveAttribute('aria-pressed', 'true');
});

test('colours follow score annotations until a mode is explicitly chosen', async ({ page }) => {
  await expect(page.locator('#color-mode')).toHaveValue('fingers');
  const unmarked = fingerFixture.replace(/<notations>.*?<\/notations>/g, '');
  await page.locator('#file').setInputFiles({ name: 'unmarked.musicxml', mimeType: 'application/xml', buffer: Buffer.from(unmarked) });
  await expect(page.locator('#piece-title')).toHaveText('Finger practice');
  await expect(page.locator('#color-mode')).toHaveValue('hands');
  await importFingerFixture(page);
  await expect(page.locator('#color-mode')).toHaveValue('fingers');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#color-mode').selectOption('hands');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expect(page.locator('#color-mode')).toHaveValue('hands');
  await expect(page.locator('#note-legend')).toHaveText('LeftRight');
});

test('hand redistribution is saved and resets to the printed fingering', async ({ page }, testInfo) => {
  const tapNote = point => testInfo.project.use.hasTouch
    ? page.touchscreen.tap(point.x, point.y)
    : page.mouse.click(point.x, point.y);
  await importFingerFixture(page);
  await range(page, '#timeline', 0);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#color-mode').selectOption('fingers');
  await number(page, '#lookahead', 1);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect.poll(() => visibleNote(page)).not.toBeNull();
  await tapNote(await visibleNote(page));
  await page.locator('#note-hand').selectOption('left');
  await expect(page.locator('#finger-note')).toHaveText('Left · C4');
  await expect(page.locator('#finger-source')).toContainText('choose a finger');
  await expect(page.locator('#finger-dialog [data-finger="1"]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#finger-dialog [data-finger="5"]').click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await importFingerFixture(page);
  await range(page, '#timeline', 0);
  await expect.poll(() => visibleNote(page)).not.toBeNull();
  await tapNote(await visibleNote(page));
  await expect(page.locator('#note-hand')).toHaveValue('left');
  await expect(page.locator('#finger-dialog [data-finger="5"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#note-hand').selectOption('score');
  await expect(page.locator('#finger-note')).toHaveText('Right · C4');
  await expect(page.locator('#finger-source')).toHaveText('Score fingering');
  await expect(page.locator('#finger-dialog [data-finger="1"]')).toHaveAttribute('aria-pressed', 'true');
});

test('reach guide finds a wide attack and offers time to play it in steps', async ({ page }) => {
  const fixture = fingerFixture.replace('</note></measure>', '</note><note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure>');
  await page.locator('#file').setInputFiles({ name: 'reach.musicxml', mimeType: 'application/xml', buffer: Buffer.from(fixture) });
  await expect(page.locator('#piece-title')).toHaveText('Finger practice');
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await expect(page.locator('#reach')).toHaveValue('0');
  await page.locator('#reach').selectOption('9');
  await expect(page.locator('#reach-options')).toBeVisible();
  await page.locator('#next-wide').click();
  await expect.poll(() => position(page)).toBeCloseTo(0, 2);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#status-text')).toHaveText('Wide right chord · play in steps');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await expect(page.locator('#reach')).toHaveValue('9');
});

test('a selected measure loops with a pause between repetitions', async ({ page }) => {
  await importFingerFixture(page);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#practice-measure').selectOption({ index: 1 });
  await page.locator('#jump-measure').click();
  await expect.poll(() => position(page)).toBeCloseTo(2, 2);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).click();
  await page.locator('#loop-gap').selectOption('1');
  await page.locator('#loop-measure').click();
  if (await page.locator('#settings-dialog').isVisible()) await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: 'Clear loop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await range(page, '#timeline', 3.95);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => position(page)).toBeCloseTo(2, 2);
  await page.waitForTimeout(250);
  expect(await position(page)).toBeCloseTo(2, 2);
  await expect.poll(() => position(page)).toBeGreaterThan(2.05);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});
