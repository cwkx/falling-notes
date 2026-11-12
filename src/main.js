import './style.css';
import { loadScore } from './musicxml.js';
import { PianoAudio } from './audio.js';
import { FallingRenderer } from './renderer.js';
import { Transport } from './transport.js';
import defaultScoreUrl from '../prelude-in-c-sharp-minor-opus-3-no-2-sergei-rachmaninoff.mxl?url';

const paths = {
  play: '<path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  open: '<path d="M3 8V5h6l2 3h10v11H3z"/><path d="M3 11h18"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  collapse: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6"/>',
  headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  restart: '<path d="M4 9a8 8 0 1 1 0 6M4 3v6h6"/>',
  next: '<path d="m6 5 9 7-9 7zM18 5v14"/>',
  loop: '<path d="m16 2 4 4-4 4M4 11V8a2 2 0 0 1 2-2h14M8 22l-4-4 4-4m12-1v3a2 2 0 0 1-2 2H4"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
const icon = name => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
const $ = selector => document.querySelector(selector);
const saved = (key, fallback) => { try { return localStorage.getItem(`falling-notes:${key}`) || fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(`falling-notes:${key}`, value); } catch { /* Storage is optional. */ } };
let theme = saved('theme', 'dark') === 'light' ? 'light' : 'dark';

$('#app').innerHTML = `
  <header class="app-bar">
    <a class="brand" href="./" aria-label="Falling Notes home"><span class="brand-mark"><i></i><i></i><i></i></span><span>falling<span class="brand-light">notes</span></span></a>
    <div class="piece-info"><h1 id="piece-title">Prelude in C-sharp Minor</h1><p id="composer">Sergei Rachmaninoff · Op. 3, No. 2</p></div>
    <nav class="header-actions" aria-label="Player options">
      <button id="open" class="button open-button" title="Open MusicXML (.mxl, .musicxml, .xml)">${icon('open')}<span>Open piece</span></button>
      <button id="theme" class="icon-button" aria-label="Switch to light mode"></button>
      <button id="settings" class="icon-button" aria-label="Practice settings">${icon('settings')}</button>
      <button id="fullscreen" class="icon-button" aria-label="Enter fullscreen">${icon('expand')}</button>
    </nav>
    <input id="file" type="file" accept=".mxl,.musicxml,.xml,application/vnd.recordare.musicxml,application/vnd.recordare.musicxml+xml" hidden />
  </header>
  <main class="workspace">
    <div class="practice-bar">
      <div class="mode-switch" role="group" aria-label="Practice mode">
        <button id="wait-mode" class="selected" aria-pressed="true" title="Wait for the notes you play on your piano">${icon('mic')}<span>Wait for me</span></button>
        <button id="listen-mode" aria-pressed="false" title="Play through the piece">${icon('headphones')}<span>Listen</span></button>
      </div>
      <div id="status" class="status" role="status"><span id="status-dot" class="status-dot"></span><span id="status-text">Loading score…</span><span id="mic-meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></div>
      <div class="hand-key"><span><i class="left-dot"></i>Left</span><span><i class="right-dot"></i>Right</span></div>
    </div>
    <div id="stage" class="stage">
      <canvas id="roll" aria-label="Falling piano notes. Drag vertically to move through the score; horizontally to change speed. Use the timeline to seek with a keyboard."></canvas>
      <div id="gesture-feedback" class="gesture-feedback" aria-hidden="true"></div>
      <div id="drop-overlay" class="drop-overlay">${icon('open')}<span>Open MusicXML</span></div>
    </div>
  </main>
  <footer class="controls">
    <div class="timeline-row"><span id="measure" class="measure">Measure 1</span><div class="timeline-wrap"><div id="loop-region"></div><input id="timeline" aria-label="Position in piece" type="range" min="0" max="100" step="0.01" value="0" /></div><span id="time" class="time">0:00 <span>/ 0:00</span></span></div>
    <div class="transport-row">
      <div class="transport-side"><button id="loop" class="icon-button" aria-label="Set loop start" title="Loop: set start, set end, clear">${icon('loop')}<span id="loop-label"></span></button><span id="loop-readout" class="loop-readout"></span></div>
      <div class="playback-buttons"><button id="restart" class="icon-button" aria-label="Restart" title="Restart (Home)">${icon('restart')}</button><button id="play" class="play-button" aria-label="Play" title="Play / pause (Space)" disabled>${icon('play')}</button><button id="next" class="icon-button" aria-label="Next notes" title="Next notes (Right arrow)">${icon('next')}</button></div>
      <div class="speed-control"><button id="speed-value" aria-label="Reset speed to 100%" title="Reset speed">100<span>%</span></button><input id="speed" aria-label="Playback speed" type="range" min="25" max="150" step="5" value="100" /></div>
    </div>
  </footer>
  <div id="toast" class="toast" role="alert" hidden></div>
  <dialog id="settings-dialog">
    <div class="dialog-heading"><h2>Practice settings</h2><button id="close-settings" class="icon-button" aria-label="Close settings">${icon('close')}</button></div>
    <label class="setting-row"><span>Hands</span><select id="hands"><option value="both">Both hands</option><option value="right">Right hand</option><option value="left">Left hand</option></select></label>
    <label class="setting-row"><span>Microphone sensitivity</span><output id="sensitivity-value">55%</output><input id="sensitivity" aria-label="Microphone sensitivity" type="range" min="15" max="95" step="5" value="55" /></label>
    <label class="setting-row"><span>Piano tuning · A4</span><div class="number-unit"><input id="tuning" type="number" min="415" max="466" step="1" value="440" aria-label="Piano tuning A4 in Hertz" /><span>Hz</span></div></label>
    <label class="setting-row"><span>Notes ahead</span><select id="lookahead"><option value="5">5 seconds</option><option value="8" selected>8 seconds</option><option value="12">12 seconds</option></select></label>
    <div class="settings-note">Microphone audio stays on your device. Play notes together or build a chord one note at a time.</div>
    <div class="gesture-help"><span>↕ Drag to seek</span><span>↔ Drag to change speed</span><span>Space to play / pause</span></div>
  </dialog>
`;

const audio = new PianoAudio();
const renderer = new FallingRenderer($('#roll'));
let transport;
let score;
let lookAhead = 8;
let loadRevision = 0;
let fileRevision = 0;
let startRevision = 0;
let starting = false;
let loopStart = null;
let wakeLock;
let seekDragging = false;
let gesture = null;
let active = new Map();
let lastAudioPoll = 0;
let audioResult = { level: 0, matches: [] };
let lastToken = '';
let lastRecognitionRevision = -1;
let toastTimer;

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').content = theme === 'dark' ? '#101416' : '#f1f4f1';
  $('#theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('#theme').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  save('theme', theme);
}
applyTheme();

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

function formatTime(time) {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      const lock = await navigator.wakeLock.request('screen');
      if (!transport?.playing || document.hidden) await lock.release();
      else wakeLock = lock;
    }
  }
  catch { /* Screen wake lock is a progressive enhancement. */ }
}

function pause() {
  startRevision++;
  starting = false;
  if (transport) transport.playing = false;
  audio.stopMicrophone();
  audio.stopSounds();
  audioResult = { level: 0, matches: [] };
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  updateControls();
}

async function play() {
  if (!transport) return;
  if (transport.playing || starting) { pause(); return; }
  const revision = ++startRevision;
  starting = true;
  updateControls();
  try {
    await audio.resume();
    if (revision !== startRevision) return;
    if (transport.mode === 'wait') await audio.startMicrophone();
    if (revision !== startRevision) return;
    if (transport.position >= score.duration) transport.seek(-1.5);
    lastToken = '';
    transport.playing = true;
    keepAwake();
  } catch (error) {
    if (revision === startRevision) toast(error.message || 'Microphone unavailable. Check browser permissions or select Listen.');
  } finally {
    if (revision === startRevision) starting = false;
    updateControls();
  }
}

function seek(time) {
  if (!transport) return;
  transport.seek(time);
  audio.reset();
  audio.stopSounds();
  active.clear();
  lastToken = '';
  updateControls();
}

function setSpeed(percent) {
  percent = Math.max(25, Math.min(150, Math.round(percent / 5) * 5));
  if (transport) transport.speed = percent / 100;
  $('#speed').value = percent;
  $('#speed-value').innerHTML = `${percent}<span>%</span>`;
  $('#speed').style.setProperty('--progress', `${(percent - 25) / 1.25}%`);
  save('speed', percent);
}

function setMode(mode) {
  if (!transport || transport.mode === mode) return;
  pause();
  transport.setMode(mode);
  $('#wait-mode').classList.toggle('selected', mode === 'wait');
  $('#listen-mode').classList.toggle('selected', mode === 'listen');
  $('#wait-mode').setAttribute('aria-pressed', mode === 'wait');
  $('#listen-mode').setAttribute('aria-pressed', mode === 'listen');
  updateControls();
}

function clearLoop() {
  loopStart = null;
  if (transport) transport.loop = null;
  $('#loop').classList.remove('selected');
  $('#loop').setAttribute('aria-label', 'Set loop start');
  $('#loop-label').textContent = '';
  $('#loop-readout').textContent = '';
  $('#loop-region').style.display = 'none';
}

function currentMeasure() {
  if (!score) return null;
  const time = Math.max(0, transport.position);
  return score.measures.findLast(measure => measure.start <= time + .0001) || score.measures[0];
}

function updateControls() {
  if (!transport) return;
  const playing = transport.playing || starting;
  $('#play').innerHTML = icon(playing ? 'pause' : 'play');
  $('#play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#play').classList.toggle('playing', playing);
  const position = Math.max(0, transport.position);
  if (!seekDragging) $('#timeline').value = position;
  $('#timeline').style.setProperty('--progress', `${position / Math.max(1, score.duration) * 100}%`);
  $('#timeline').setAttribute('aria-valuetext', `${formatTime(position)} of ${formatTime(score.duration)}`);
  const measure = currentMeasure();
  $('#measure').textContent = `Measure ${measure?.number ?? 1}`;
  $('#time').innerHTML = `${formatTime(position)} <span>/ ${formatTime(score.duration)}</span>`;
  let status = 'Ready when you are';
  if (transport.position >= score.duration && !playing) status = 'Complete';
  else if (starting) status = transport.mode === 'wait' ? 'Connecting microphone…' : 'Starting…';
  else if (transport.playing) status = transport.mode === 'listen' ? 'Playing' : transport.waiting ? 'Your turn' : 'Listening';
  else if (transport.position > 0) status = 'Paused';
  if ($('#status-text').textContent !== status) $('#status-text').textContent = status;
  $('#status-dot').classList.toggle('live', transport.playing);
  $('#status-dot').classList.toggle('waiting', transport.waiting && transport.playing);
  $('#mic-meter').classList.toggle('live', audio.active && transport.playing);
  const level = Math.min(1, (audioResult.level || 0) * 2.5);
  [...$('#mic-meter').children].forEach((bar, index) => { bar.style.height = `${3 + level * [7, 13, 17, 11, 6][index]}px`; });
}

async function openScore(input, filename, isDefault = false) {
  const revision = ++loadRevision;
  pause();
  $('#status-text').textContent = 'Opening score…';
  try {
    const loaded = await loadScore(input, filename);
    if (revision !== loadRevision) return;
    score = loaded;
    transport = new Transport(score);
    transport.setHand($('#hands').value);
    renderer.setScore(score);
    if (isDefault) {
      $('#piece-title').textContent = 'Prelude in C-sharp Minor';
      $('#composer').textContent = 'Sergei Rachmaninoff · Op. 3, No. 2';
    } else {
      $('#piece-title').textContent = score.title || filename.replace(/\.(mxl|musicxml|xml)$/i, '');
      $('#composer').textContent = score.composer || 'MusicXML';
    }
    document.title = `${$('#piece-title').textContent} · Falling Notes`;
    $('#timeline').max = score.duration;
    $('#play').disabled = false;
    $('#wait-mode').classList.add('selected');
    $('#wait-mode').setAttribute('aria-pressed', 'true');
    $('#listen-mode').classList.remove('selected');
    $('#listen-mode').setAttribute('aria-pressed', 'false');
    setSpeed(Number(saved('speed', '100')) || 100);
    clearLoop();
    updateControls();
  } catch (error) {
    if (revision !== loadRevision) return;
    toast(error.message || 'Could not read this score. Choose a MusicXML file.');
    if (transport) updateControls();
    else $('#status-text').textContent = 'Open a MusicXML piece';
  }
}

async function openFile(file) {
  if (!file) return;
  const revision = ++fileRevision;
  if (file.size > 20 * 1024 * 1024) { toast('Choose a score smaller than 20 MB.'); return; }
  loadRevision++;
  try {
    const bytes = await file.arrayBuffer();
    if (revision === fileRevision) await openScore(bytes, file.name);
  }
  catch { if (revision === fileRevision) toast('Could not open that file. Try choosing it again.'); }
}

$('#open').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', event => { openFile(event.target.files[0]); event.target.value = ''; });
$('#theme').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); });
$('#play').addEventListener('click', play);
$('#restart').addEventListener('click', () => seek(transport?.loop?.start ?? -2));
$('#next').addEventListener('click', () => {
  if (!transport) return;
  const next = transport.events.find(event => event.time > transport.position + .02);
  seek(next?.time ?? score.duration);
});
$('#wait-mode').addEventListener('click', () => setMode('wait'));
$('#listen-mode').addEventListener('click', () => setMode('listen'));
$('#speed').addEventListener('input', event => setSpeed(Number(event.target.value)));
$('#speed-value').addEventListener('click', () => setSpeed(100));
$('#timeline').addEventListener('pointerdown', () => { seekDragging = true; });
$('#timeline').addEventListener('input', event => seek(Number(event.target.value)));
window.addEventListener('pointerup', () => { seekDragging = false; });
window.addEventListener('pointercancel', () => { seekDragging = false; });
$('#loop').addEventListener('click', () => {
  if (!transport) return;
  if (transport.loop) { clearLoop(); return; }
  if (loopStart === null) {
    loopStart = Math.max(0, transport.position);
    $('#loop').classList.add('selected');
    $('#loop-label').textContent = 'A';
    $('#loop-readout').textContent = formatTime(loopStart);
    $('#loop').setAttribute('aria-label', 'Set loop end');
    toast('Loop start set. Move to the end, then tap loop again.');
  } else {
    const start = Math.min(loopStart, Math.max(0, transport.position));
    const end = Math.min(score.duration, Math.max(loopStart, transport.position, start + 1));
    if (end <= start) { clearLoop(); return; }
    transport.loop = { start, end };
    $('#loop-label').textContent = 'A–B';
    $('#loop-readout').textContent = `${formatTime(start)}–${formatTime(end)}`;
    $('#loop').setAttribute('aria-label', 'Clear loop');
    $('#loop-region').style.cssText = `display:block;left:${start / score.duration * 100}%;width:${(end - start) / score.duration * 100}%`;
    seek(start);
  }
});

$('#settings').addEventListener('click', () => $('#settings-dialog').showModal());
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('click', event => {
  if (event.target === $('#settings-dialog')) {
    const box = event.target.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
  }
});
$('#hands').addEventListener('change', event => { transport?.setHand(event.target.value); active.clear(); });
$('#sensitivity').addEventListener('input', event => {
  audio.sensitivity = Number(event.target.value) / 100;
  $('#sensitivity-value').value = `${event.target.value}%`;
});
$('#tuning').addEventListener('change', event => {
  const value = Math.max(415, Math.min(466, Number(event.target.value) || 440));
  event.target.value = value;
  audio.referencePitch = value;
});
$('#lookahead').addEventListener('change', event => { lookAhead = Number(event.target.value); });

$('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    } else {
      document.documentElement.classList.toggle('focus-mode');
      if (document.documentElement.classList.contains('focus-mode')) toast('For edge-to-edge fullscreen on iPhone, add to Home Screen.');
    }
  } catch { document.documentElement.classList.toggle('focus-mode'); }
  updateFullscreen();
});
function updateFullscreen() {
  const expanded = !!(document.fullscreenElement || document.webkitFullscreenElement || document.documentElement.classList.contains('focus-mode'));
  $('#fullscreen').innerHTML = icon(expanded ? 'collapse' : 'expand');
  $('#fullscreen').setAttribute('aria-label', expanded ? 'Exit fullscreen' : 'Enter fullscreen');
}
document.addEventListener('fullscreenchange', updateFullscreen);
document.addEventListener('webkitfullscreenchange', updateFullscreen);

$('#roll').addEventListener('pointerdown', event => {
  if (!transport || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const midi = renderer.noteAt(event.clientX, event.clientY);
  if (midi !== null && midi !== undefined) {
    renderer.hit(midi);
    active.set(midi, performance.now() + 400);
    if (!audio.active) audio.resume().then(() => audio.play(midi, .6)).catch(() => {});
    transport.accept([midi]);
    return;
  }
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, position: transport.position, speed: transport.speed, axis: null };
  $('#roll').setPointerCapture(event.pointerId);
});
$('#roll').addEventListener('pointermove', event => {
  if (!gesture || gesture.id !== event.pointerId) return;
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (!gesture.axis && Math.hypot(dx, dy) > 8) {
    gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'speed' : 'time';
    if (gesture.axis === 'time') audio.stopSounds();
  }
  if (!gesture.axis) return;
  if (gesture.axis === 'time') {
    seek(gesture.position - dy / Math.max(180, $('#roll').clientHeight - 100) * lookAhead);
    $('#gesture-feedback').textContent = formatTime(transport.position);
  } else {
    setSpeed((gesture.speed + dx / Math.max(300, $('#roll').clientWidth) * 1.5) * 100);
    $('#gesture-feedback').textContent = `${Math.round(transport.speed * 100)}%`;
  }
  $('#gesture-feedback').classList.add('visible');
});
function endGesture(event) {
  if (!gesture || gesture.id !== event.pointerId) return;
  gesture = null;
  $('#gesture-feedback').classList.remove('visible');
}
$('#roll').addEventListener('pointerup', endGesture);
$('#roll').addEventListener('pointercancel', endGesture);
$('#roll').addEventListener('wheel', event => {
  if (!transport) return;
  event.preventDefault();
  if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) setSpeed(transport.speed * 100 + Math.sign(event.deltaX || event.deltaY) * 5);
  else seek(transport.position + event.deltaY * .012);
}, { passive: false });

let dragDepth = 0;
window.addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop-overlay').classList.add('visible'); } });
window.addEventListener('dragover', event => { event.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) $('#drop-overlay').classList.remove('visible'); });
window.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.remove('visible');
  openFile(event.dataTransfer.files[0]);
});
window.addEventListener('keydown', event => {
  if (event.target.closest('input, select, button, dialog') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); play(); }
  else if (event.code === 'ArrowRight') { event.preventDefault(); $('#next').click(); }
  else if (event.code === 'ArrowLeft') { event.preventDefault(); seek((transport?.position || 0) - 5); }
  else if (event.code === 'ArrowUp') { event.preventDefault(); setSpeed((transport?.speed || 1) * 100 + 5); }
  else if (event.code === 'ArrowDown') { event.preventDefault(); setSpeed((transport?.speed || 1) * 100 - 5); }
  else if (event.code === 'Home') { event.preventDefault(); seek(-2); }
  else if (event.code === 'Escape') { document.documentElement.classList.remove('focus-mode'); updateFullscreen(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', pause);

let lastFrame = performance.now();
let lastControlUpdate = 0;
let lastRender = 0;
function frame(now) {
  const delta = (now - lastFrame) / 1000;
  lastFrame = now;
  if (transport) {
    const wasPlaying = transport.playing;
    if (!seekDragging && gesture?.axis !== 'time') {
      const previousRevision = transport.revision;
      const notes = transport.step(delta);
      const looped = previousRevision !== transport.revision;
      if (looped) { audio.stopSounds(); active.clear(); }
      for (const note of looped ? [] : notes) {
        audio.play(note.midi, Math.min(8, note.duration / transport.speed));
        renderer.hit(note.midi);
        active.set(note.midi, now + Math.min(2000, note.duration / transport.speed * 1000));
      }
    }
    if (transport.playing && transport.mode === 'wait') {
      if (lastToken !== transport.token) {
        if (lastRecognitionRevision !== transport.revision) {
          audio.reset();
          lastRecognitionRevision = transport.revision;
        }
        audio.setTarget([...transport.expected], transport.token);
        lastToken = transport.token;
      }
      if (now - lastAudioPoll > 32) {
        const accepting = transport.waiting || (transport.target && transport.target.time - transport.position <= .15);
        audioResult = audio.poll([...transport.expected], now, Boolean(accepting));
        lastAudioPoll = now;
        if (audioResult.active === false || audioResult.suspended) {
          pause();
          toast('Microphone interrupted. Press play to reconnect.');
        } else if (!seekDragging && !gesture) {
          for (const midi of transport.accept(audioResult.matches)) {
            renderer.hit(midi);
            active.set(midi, now + 650);
          }
        }
      }
    }
    if (wasPlaying && !transport.playing) pause();
    for (const [midi, until] of active) if (now > until) active.delete(midi);
    if (now - lastRender > (transport.playing ? 12 : 30)) {
      renderer.render({ time: transport.position, lookAhead, playing: transport.playing, waiting: transport.waiting, expected: transport.expected, matched: transport.matched, active: new Set(active.keys()), theme, now, hand: transport.hand });
      lastRender = now;
    }
    if (now - lastControlUpdate > 120) { updateControls(); lastControlUpdate = now; }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

fetch(defaultScoreUrl).then(response => {
  if (!response.ok) throw new Error('Could not load the sample score. Open a MusicXML piece.');
  return response.arrayBuffer();
}).then(bytes => { if (!loadRevision) return openScore(bytes, 'Rachmaninoff.mxl', true); }).catch(error => { toast(error.message); $('#status-text').textContent = 'Open a MusicXML piece'; });
