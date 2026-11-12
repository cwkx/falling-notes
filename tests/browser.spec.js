import { test, expect } from '@playwright/test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const errors = new WeakMap();
const position = page => page.locator('#timeline').evaluate(input => Number(input.value));
const range = (page, selector, value) => page.locator(selector).evaluate((input, next) => {
  input.value = String(next);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
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

test('real audio analysis requires the complete opening octave chord', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Audio analysis is independent of the viewport.');
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
      async stop() {
        for (const partials of voices.values()) {
          for (const { oscillator, gain } of partials) {
            oscillator.stop();
            oscillator.disconnect();
            gain.disconnect();
          }
        }
        voices.clear();
        await context.close();
      },
    };
  });
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
