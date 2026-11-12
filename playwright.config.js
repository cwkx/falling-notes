import { defineConfig } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A real browser microphone pipeline, fed silence instead of a host microphone.
const silencePath = join(tmpdir(), 'falling-notes-test-silence.wav');
const samples = 48000;
const silence = Buffer.alloc(44 + samples * 2);
silence.write('RIFF', 0);
silence.writeUInt32LE(silence.length - 8, 4);
silence.write('WAVEfmt ', 8);
silence.writeUInt32LE(16, 16);
silence.writeUInt16LE(1, 20);
silence.writeUInt16LE(1, 22);
silence.writeUInt32LE(samples, 24);
silence.writeUInt32LE(samples * 2, 28);
silence.writeUInt16LE(2, 32);
silence.writeUInt16LE(16, 34);
silence.write('data', 36);
silence.writeUInt32LE(samples * 2, 40);
writeFileSync(silencePath, silence);

const executablePath = process.env.CHROMIUM_PATH
  || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.js',
  fullyParallel: true,
  workers: 3,
  timeout: 20000,
  expect: { timeout: 6000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    permissions: ['microphone'],
    launchOptions: {
      executablePath,
      args: [
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${silencePath}`,
      ],
    },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'landscape', use: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
