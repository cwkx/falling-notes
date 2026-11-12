# Falling Notes

A fullscreen piano practice player. Open a MusicXML `.mxl`, `.musicxml`, or `.xml` file, press play, and play along on your piano. The included Rachmaninoff Prelude opens by default. Dark mode is the default; the sun button switches themes.

## Run

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

## Practice

- **Wait for me:** press play to allow the microphone. The score stops at each attack until all expected notes are heard. Chords can be built one note at a time. Correct notes illuminate the keyboard and release a small shimmer.
- **Listen:** hear a synthesized preview without microphone access.
- Drag the falling notes **up/down** to move forward/backward. Drag **left/right** to slow down/speed up. The timeline and speed slider offer the same controls.
- Tap the loop button to set A, move to another position and tap again to set B. Tap again to clear the loop.
- Settings select either hand, microphone sensitivity, A4 tuning (415–466 Hz), and how much of the score is visible.
- Space plays/pauses; left/right arrows move backward/skip to the next notes; up/down arrows change speed; Home restarts.
- The fullscreen button uses the browser's fullscreen API where available. On iPhone it also offers a compact view; use Safari → Share → Add to Home Screen for standalone fullscreen. Both orientations use the available viewport and safe-area insets.

## Microphone recognition

All file parsing and microphone analysis happen locally. Audio is neither recorded nor uploaded. Microphone access requires HTTPS (GitHub Pages provides it) or localhost. Pausing, changing modes, leaving the page, or hiding the tab stops the microphone.

The detector compares the expected score pitches against a 16,384-sample FFT, interpolates spectral peaks, checks several harmonics, adapts to the spectral noise floor, and rejects likely overtones of lower notes. This handles chords and weak piano fundamentals better than a single-pitch detector. Short confirmation windows reduce transient matches; repeated notes require release or renewed attack energy. Voice-oriented echo cancellation, noise suppression, and automatic gain control are requested off, although browsers and devices may override these constraints. Synthesized feedback is disabled while listening to prevent self-triggering.

Set the phone near the piano in a quiet room. Increase sensitivity for soft playing, reduce it for background noise, and adjust A4 for an instrument tuned away from 440 Hz. This is a heuristic recognizer: dense bass chords, heavy sustain, room resonance, weak phone microphones, and unusual piano timbres can still cause missed or false matches. The next-notes button lets you move past a difficult detection. Synthetic chord tests pass; recognition still needs trials on physical acoustic/digital pianos and iPhones.

## MusicXML support

Compressed MXL containers, partwise/timewise scores, voices, chords, rests, ties, divisions, tempo changes, transposition, pickups, and standard repeats/endings are supported. Notes use sounding pitch. Multi-staff piano music is grouped into hands, including the four-staff passages in the provided score. Grace-note timing is approximate; D.C./D.S./coda jumps and notation-only rubato/fermatas are not interpreted. Wait mode naturally allows longer holds. The supplied MXL contains eight malformed, empty engraving tags; the importer removes those tags in memory without changing the source file.

## GitHub Pages

In the repository's **Settings → Pages → Build and deployment**, select **GitHub Actions**. Push to `main` to run the included workflow. It tests and builds the site, then deploys `dist/`. Pull requests build and test without deploying. Vite uses relative asset paths so the app works under `/falling-notes/` and on custom domains.

No backend or API keys are required.

## Browser checks

```sh
npx playwright install chromium
npm run test:browser
```

The browser suite uses `CHROMIUM_PATH` when provided, system Chromium when installed, or Playwright's Chromium. It covers desktop and phone layouts, themes, imports, touch gestures, playback, wait mode, and loops. Browser emulation does not replace physical-device microphone testing.

Implementation references: [MusicXML containers](https://www.w3.org/2021/06/musicxml40/container-reference/elements/container/), [microphone constraints and secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API), and [GitHub Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
