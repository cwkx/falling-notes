import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser as XMLDOMParser } from '@xmldom/xmldom';
import { zipSync, strToU8 } from 'fflate';
import { loadScore } from '../src/musicxml.js';

// Browser DOMParser reports invalid XML as a parsererror document. Match that
// behavior instead of accepting xmldom's tolerant repair of broken fixtures.
globalThis.DOMParser = class {
  parseFromString(source, type) {
    const issues = [];
    const parser = new XMLDOMParser({ onError: (level, message) => issues.push(message) });
    let document;
    try { document = parser.parseFromString(source, type); }
    catch { return new XMLDOMParser().parseFromString('<parsererror/>', type); }
    return issues.length ? new XMLDOMParser().parseFromString('<parsererror/>', type) : document;
  }
};

const score = (measures, attributes = '<divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>') => `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Test score</work-title></work><identification><creator type="composer">Test composer</creator></identification><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes>${attributes}</attributes>${measures}</measure></part></score-partwise>`;
const pitch = (step = 'C', octave = 4, duration = 1, extra = '') => `<note>${extra}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration></note>`;
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);

test('parses the supplied Rachmaninoff archive, including its broken engraving tags', async () => {
  const buffer = await readFile(new URL('../prelude-in-c-sharp-minor-opus-3-no-2-sergei-rachmaninoff.mxl', import.meta.url));
  const result = await loadScore(buffer);
  assert.equal(result.title, 'Prelude, C Sharp Minor');
  assert.equal(result.composer, 'Sergei Rachmaninov');
  assert.equal(result.measures.length, 62);
  assert.ok(result.notes.length > 1500);
  assert.ok(result.events.length > 300);
  assert.equal(result.tempos[0].bpm, 40);
  assert.ok(result.tempos.length >= 10);
  closeTo(result.duration, 196.49899148431177);
  assert.ok(result.minMidi >= 21 && result.maxMidi <= 108);
  assert.deepEqual([...new Set(result.events[0].notes.map((note) => note.midi))], [33, 45, 57]);
  for (const note of result.notes) {
    assert.ok(Number.isFinite(note.start) && note.start >= 0);
    assert.ok(Number.isFinite(note.duration) && note.duration > 0);
    assert.ok(note.hand === 'left' || note.hand === 'right');
  }
  assert.ok(result.notes.some((note) => note.measure === 45 && note.hand === 'left'));
  assert.ok(result.notes.some((note) => note.measure === 45 && note.hand === 'right'));
  assert.ok(result.notes.some(note => note.measure === 14 && note.midi === 64 && note.finger === 5));
  assert.ok(result.notes.some(note => note.finger === null && note.fingering === ''));
});

test('reads primary, alternate, and substitution fingerings without inventing ambiguous fingers', async () => {
  const notation = body => `<notations><technical>${body}</technical></notations>`;
  const result = await loadScore(score(
    pitch('C', 4, 1, notation('<fingering>1</fingering><fingering alternate="yes">2</fingering>')) +
    pitch('D', 4, 1, notation('<fingering>2</fingering><fingering substitution="yes">3</fingering>')) +
    pitch('E', 4, 1, notation('<fingering>3</fingering><fingering>4</fingering>')) +
    pitch('F', 4, 1, notation('<fingering alternate="yes">5</fingering>')),
  ));
  assert.deepEqual(result.notes.map(note => note.finger), [1, 2, null, null]);
  assert.deepEqual(result.notes.map(note => note.fingering), ['1/2', '2–3', '3/4', '5']);
  assert.deepEqual(result.notes[0].fingerings, [
    { text: '1', alternate: false, substitution: false },
    { text: '2', alternate: true, substitution: false },
  ]);
  assert.equal(result.notes[1].fingerings[1].substitution, true);
});

test('preserves non-piano fingering text without assigning piano finger colours', async () => {
  const result = await loadScore(score(
    pitch('C', 4, 1, '<notations><technical><fingering>p</fingering><pluck>i</pluck></technical></notations>') +
    pitch('D', 4, 1, '<notations><technical><fingering>1-3</fingering></technical></notations>') +
    pitch('E', 4, 1, '<notations><technical><fingering>0</fingering></technical></notations>') +
    pitch('F', 4, 1, '<notations><technical><pluck>3</pluck></technical></notations>'),
  ));
  assert.deepEqual(result.notes.map(note => note.finger), [null, null, null, null]);
  assert.deepEqual(result.notes.map(note => note.fingering), ['p', '1-3', '0', '']);
});

test('ties retain the starting finger and a substitution without introducing another attack', async () => {
  const start = '<tie type="start"/><notations><technical><fingering>1</fingering></technical></notations>';
  const end = '<tie type="stop"/><notations><technical><fingering substitution="yes">3</fingering></technical></notations>';
  const result = await loadScore(score(`${pitch('C', 4, 4, start)}</measure><measure number="2">${pitch('C', 4, 4, end)}`));
  assert.equal(result.events.length, 1);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].finger, 1);
  assert.equal(result.notes[0].fingering, '1–3');
  assert.equal(result.notes[0].duration, 4);
});

test('repeated tied passages do not share mutable fingering lists', async () => {
  const start = '<tie type="start"/><notations><technical><fingering>1</fingering></technical></notations>';
  const end = '<tie type="stop"/><notations><technical><fingering substitution="yes">3</fingering></technical></notations>';
  const result = await loadScore(score(`<barline><repeat direction="forward"/></barline>${pitch('C', 4, 4, start)}</measure><measure number="2">${pitch('C', 4, 4, end)}<barline><repeat direction="backward"/></barline>`));
  assert.equal(result.notes.length, 2);
  assert.deepEqual(result.notes.map(note => note.fingering), ['1–3', '1–3']);
  assert.notEqual(result.notes[0].fingerings, result.notes[1].fingerings);
});

test('reads chords, multiple voices, backup, forward, and rests', async () => {
  const xml = score(`${pitch('C', 4, 2)}${pitch('E', 4, 2, '<chord/>')}<note><rest/><duration>2</duration></note><backup><duration>4</duration></backup>${pitch('C', 3, 1, '<voice>2</voice><staff>2</staff>')}<forward><duration>2</duration></forward>${pitch('G', 3, 1, '<voice>2</voice><staff>2</staff>')}`, '<divisions>1</divisions><staves>2</staves>');
  const result = await loadScore(xml);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0].notes.map((note) => note.midi), [48, 60, 64]);
  closeTo(result.events[1].time, 1.5);
  closeTo(result.duration, 2);
  assert.equal(result.notes.find((note) => note.midi === 48).hand, 'left');
  assert.equal(result.notes.find((note) => note.midi === 60).hand, 'right');
});

test('keeps ties as one attack and integrates tempo changes through their duration', async () => {
  const xml = score(`<direction><sound tempo="60"/></direction>${pitch('C', 4, 4, '<tie type="start"/>')}</measure><measure number="2"><direction><sound tempo="120"/></direction>${pitch('C', 4, 4, '<tie type="stop"/><tie type="start"/>')}</measure><measure number="3">${pitch('C', 4, 1, '<tie type="stop"/>')}${pitch('D', 4, 1)}`);
  const result = await loadScore(xml);
  assert.equal(result.notes.length, 2);
  assert.equal(result.events.length, 2);
  closeTo(result.notes[0].duration, 6.5);
  closeTo(result.notes[1].start, 6.5);
  closeTo(result.duration, 8);
});

test('aligns parts and pickup measures, respecting divisions and transpose', async () => {
  const xml = `<score-partwise><part id="P1"><measure number="0" implicit="yes"><attributes><divisions>4</divisions><transpose><chromatic>2</chromatic></transpose></attributes>${pitch('C', 4, 4)}</measure><measure number="1">${pitch('D', 4, 16)}</measure></part><part id="P2"><measure number="0" implicit="yes"><attributes><divisions>2</divisions></attributes>${pitch('C', 3, 2)}</measure><measure number="1">${pitch('G', 3, 8)}</measure></part></score-partwise>`;
  const result = await loadScore(xml);
  assert.deepEqual(result.notes.map((note) => note.midi), [48, 62, 55, 64]);
  closeTo(result.measures[0].duration, 0.5);
  closeTo(result.measures[1].start, 0.5);
  closeTo(result.duration, 2.5);
});

test('honors metronome beat units, dots, tempo offsets, and additive time', async () => {
  const xml = score(`<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>${pitch('C', 4, 2)}<direction><offset>1</offset><sound tempo="120"/></direction>${pitch('D', 4, 3)}`, '<divisions>1</divisions><time><beats>3+2</beats><beat-type>4</beat-type></time>');
  const result = await loadScore(xml);
  assert.equal(result.tempos[0].bpm, 90);
  closeTo(result.tempos[1].time, 2);
  closeTo(result.duration, 3);
});

test('expands repeats and first/second endings without replaying the first ending', async () => {
  const xml = score(`<barline location="left"><repeat direction="forward"/></barline>${pitch('C', 4, 4)}</measure><measure number="2"><barline location="left"><ending number="1" type="start"/></barline>${pitch('D', 4, 4)}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline>${pitch('E', 4, 4)}<barline location="right"><ending number="2" type="stop"/></barline>`);
  const result = await loadScore(xml);
  assert.deepEqual(result.measures.map((measure) => measure.number), [1, 2, 1, 3]);
  assert.deepEqual(result.notes.map((note) => note.midi), [60, 62, 60, 64]);
  closeTo(result.duration, 8);
});

test('restores inherited tempo when jumping back to a repeat', async () => {
  const xml = score('<direction><sound tempo="60"/></direction>' + pitch('C', 4, 4) + '</measure><measure number="2"><barline location="left"><repeat direction="forward"/></barline>' + pitch('D', 4, 4) + '</measure><measure number="3"><direction><sound tempo="120"/></direction>' + pitch('E', 4, 4) + '<barline location="right"><repeat direction="backward"/></barline>');
  const result = await loadScore(xml);
  assert.deepEqual(result.notes.map((note) => note.start), [0, 4, 8, 10, 14]);
  closeTo(result.duration, 16);
});

test('skipping a first ending does not carry its tempo change into the second ending', async () => {
  const xml = score(`<direction><sound tempo="60"/></direction><barline location="left"><repeat direction="forward"/></barline>${pitch('C', 4, 4)}</measure><measure number="2"><barline location="left"><ending number="1" type="start"/></barline><direction><sound tempo="120"/></direction>${pitch('D', 4, 4)}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure><measure number="3"><barline location="left"><ending number="2" type="start"/></barline>${pitch('E', 4, 4)}<barline location="right"><ending number="2" type="stop"/></barline>`);
  const result = await loadScore(xml);
  assert.deepEqual(result.measures.map((measure) => measure.duration), [4, 2, 4, 4]);
  assert.deepEqual(result.tempos.map((tempo) => tempo.bpm), [60, 120, 60]);
  closeTo(result.duration, 14);
});

test('parses timewise MusicXML', async () => {
  const xml = `<score-timewise><measure number="1"><part id="P1"><attributes><divisions>1</divisions></attributes>${pitch('C', 4, 4)}</part><part id="P2"><attributes><divisions>1</divisions></attributes>${pitch('C', 3, 4)}</part></measure><measure number="2"><part id="P1">${pitch('D', 4, 4)}</part><part id="P2">${pitch('D', 3, 4)}</part></measure></score-timewise>`;
  const result = await loadScore(xml);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[1].notes.map((note) => note.midi), [50, 62]);
  closeTo(result.events[1].time, 2);
});

test('loads MXL using the declared container root rather than the first XML file', async () => {
  const zipped = zipSync({
    'irrelevant.xml': strToU8('<irrelevant/>'),
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="music/score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'),
    'music/score.musicxml': strToU8(score(pitch('F', 4, 4))),
  });
  const result = await loadScore(zipped);
  assert.equal(result.notes[0].midi, 65);
});

test('supports XML byte input and title fallback', async () => {
  const result = await loadScore(strToU8(score(pitch()).replace('<work><work-title>Test score</work-title></work>', '')), 'my-piece.musicxml');
  assert.equal(result.title, 'my piece');
});

test('rejects invalid files, entity declarations, empty scores, and oversized uploads', async () => {
  for (const input of ['<html/>', '<score-partwise><part></score-partwise>', score('<note><rest/><duration>4</duration></note>'), '<!DOCTYPE a [<!ENTITY x "abc">]><a/>', new Uint8Array(), new Uint8Array([0x50, 0x4b, 0, 0]), new Uint8Array(20 * 1024 * 1024 + 1)]) {
    await assert.rejects(() => loadScore(input));
  }
});
