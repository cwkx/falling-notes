import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { loadScore } from '../src/musicxml.js';

globalThis.DOMParser = DOMParser;
const data = JSON.parse(await readFile(new URL('../data/rachmaninoff-fingerings.json', import.meta.url)));
const archive = await readFile(new URL('../prelude-in-c-sharp-minor-opus-3-no-2-sergei-rachmaninoff.mxl', import.meta.url));
const xml = strFromU8(unzipSync(archive)['score.xml']);
const source = xml
  .replace(/<notations><technical><fingering>[1-5]<\/fingering><\/technical><\/notations>/g, '')
  .replace(/<technical><fingering>[1-5]<\/fingering><\/technical>/g, '')
  .replace(/<fingering>[1-5]<\/fingering>/g, '')
  .replace(/<miscellaneous><miscellaneous-field name="fingering-source">[^<]*<\/miscellaneous-field><\/miscellaneous>/g, '')
  .replace(/<miscellaneous-field name="fingering-source">[^<]*<\/miscellaneous-field>/g, '');

test('the fingering dataset records distinct physical notes and their printed sources', () => {
  assert.equal(data.markings.length, 304);
  assert.equal(data.source.editor, 'Leopold Godowsky');
  assert.equal(data.source.year, 1923);
  const pages = new Set(data.source.pages.map(page => page.pdf));
  const physicalNotes = new Set();
  for (const mark of data.markings) {
    assert.ok(Number.isInteger(mark.finger) && mark.finger >= 1 && mark.finger <= 5);
    assert.ok(pages.has(mark.sourcePage));
    assert.ok(mark.measure >= 14 && mark.measure <= 41);
    const key = `${mark.measure}:${mark.staff}:${mark.midi}:${mark.offset / mark.divisions}`;
    assert.ok(!physicalNotes.has(key), `Duplicate source mark: ${key}`);
    physicalNotes.add(key);
  }
});

test('adding fingerings preserves the cleaned source bytes and all parsed musical data', async () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), data.unannotatedScoreSha256);
  const original = await loadScore(source);
  const annotated = await loadScore(archive);
  const withoutFingering = ({ finger, fingering, fingerings, ...note }) => note;
  const musicalData = score => ({
    ...score,
    notes: score.notes.map(withoutFingering),
    events: score.events.map(event => ({ ...event, notes: event.notes.map(withoutFingering) })),
  });
  assert.deepEqual(musicalData(annotated), musicalData(original));
});

test('the downloadable score is valid XML without tolerant repairs', () => {
  const issues = [];
  const document = new DOMParser({ onError: (level, message) => issues.push({ level, message }) })
    .parseFromString(xml, 'application/xml');
  assert.deepEqual(issues, []);
  assert.equal(document.documentElement.nodeName, 'score-partwise');
});

test('every exported fingering matches its exact source note and no others are added', () => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const children = (node, tag) => [...node.childNodes]
    .filter(child => child.nodeType === 1 && (!tag || child.nodeName === tag));
  const value = (node, tag, fallback = '') => children(node, tag)[0]?.textContent || fallback;
  const key = (measure, staff, midi, beat) => `${measure}:${staff}:${midi}:${beat.toFixed(9)}`;
  const expected = new Map(data.markings.map(mark => [
    key(mark.measure, mark.staff, mark.midi, mark.offset / mark.divisions), mark.finger,
  ]));
  const found = new Set();
  const steps = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let divisions = 1;
  for (const measure of document.getElementsByTagName('measure')) {
    let cursor = 0;
    let lastStart = 0;
    for (const element of children(measure)) {
      if (element.nodeName === 'attributes') {
        divisions = Number(value(element, 'divisions', String(divisions)));
      } else if (element.nodeName === 'backup' || element.nodeName === 'forward') {
        cursor += Number(value(element, 'duration', '0')) / divisions * (element.nodeName === 'backup' ? -1 : 1);
      } else if (element.nodeName === 'note') {
        const chord = children(element, 'chord').length > 0;
        const start = chord ? lastStart : cursor;
        if (!chord) {
          lastStart = start;
          if (!children(element, 'grace').length) cursor += Number(value(element, 'duration', '0')) / divisions;
        }
        const pitch = children(element, 'pitch')[0];
        const fingerings = [...element.getElementsByTagName('fingering')];
        if (!pitch) {
          assert.equal(fingerings.length, 0);
          continue;
        }
        const midi = (Number(value(pitch, 'octave')) + 1) * 12 + steps[value(pitch, 'step')] + Number(value(pitch, 'alter', '0'));
        const identity = key(Number(measure.getAttribute('number')), Number(value(element, 'staff', '1')), midi, start);
        const finger = expected.get(identity);
        assert.deepEqual(fingerings.map(mark => mark.textContent), finger === undefined ? [] : [String(finger)], identity);
        if (finger !== undefined) found.add(identity);
      }
    }
  }
  assert.deepEqual(found, new Set(expected.keys()));
});

test('portable MusicXML contains all checked fingers, including duplicate voices', async () => {
  assert.equal((xml.match(/<fingering\b/g) || []).length, 394);
  assert.ok(xml.includes(`<miscellaneous-field name="fingering-source">${data.source.editor}`));
  assert.ok(xml.includes(data.source.url));
  const score = await loadScore(archive);
  const marked = score.notes.filter(note => note.finger !== null);
  assert.equal(marked.length, 394);
  const physical = new Map();
  for (const note of score.notes) {
    const key = `${note.measure}:${note.start}:${note.hand}:${note.midi}`;
    if (physical.has(key)) assert.equal(note.finger, physical.get(key), `Conflicting voices: ${key}`);
    else physical.set(key, note.finger);
    if (note.finger !== null) {
      assert.equal(note.fingering, String(note.finger));
      assert.deepEqual(note.fingerings, [{ text: String(note.finger), alternate: false, substitution: false }]);
    }
  }
  assert.equal([...physical.values()].filter(finger => finger !== null).length, 304);
});
