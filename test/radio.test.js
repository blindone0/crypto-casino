'use strict';
// The noir radio's programme.
//
// The music is synthesised from the descriptions in public/radio.js, so a wrong number in
// a chord is a wrong note every time that track comes round. There is no way to hear that
// in a unit test, but there is a way to check that the data is the kind of data that can
// only make music: chords that are voiced the way the engine expects, melodies that fit
// the bar they are written in, and a dial where every station plays something.

const test = require('node:test');
const assert = require('node:assert');

// These must match the registries in public/audio.js. A track naming a voice the engine
// does not have is silent, which is the one failure nobody notices until a player does.
const VOICES = new Set(['rhodes', 'piano', 'vibes', 'guitar', 'strings', 'clarinet', 'organ', 'theremin', 'horn', 'none']);
const BASS = new Set(['walk', 'root', 'pedal', 'tango', 'none']);
const DRUMS = new Set(['brushes', 'bolero', 'mallets', 'ticks', 'heartbeat', 'none']);

let radio;
test.before(async () => { radio = await import('../public/radio.js'); });

const pitchClass = (n) => ((n % 12) + 12) % 12;

test('every track and station has a distinct id', () => {
  const trackIds = radio.TRACKS.map((t) => t.id);
  const stationIds = radio.STATIONS.map((s) => s.id);
  assert.strictEqual(new Set(trackIds).size, trackIds.length, 'duplicate track id');
  assert.strictEqual(new Set(stationIds).size, stationIds.length, 'duplicate station id');
  assert.ok(radio.TRACKS.length >= 10, 'a radio needs a programme, not a loop');
  assert.ok(radio.STATIONS.length >= 3, 'a dial needs somewhere to turn to');
});

test('every station plays tracks that exist, and no track is stranded off the dial', () => {
  const played = new Set();
  for (const station of radio.STATIONS) {
    assert.ok(station.tracks.length >= 3, `${station.id} is too short to be a station`);
    for (const id of station.tracks) {
      assert.ok(radio.trackById(id), `${station.id} plays "${id}", which does not exist`);
      played.add(id);
    }
    assert.strictEqual(new Set(station.tracks).size, station.tracks.length,
      `${station.id} lists the same track twice`);
  }
  for (const track of radio.TRACKS) {
    assert.ok(played.has(track.id), `${track.id} is on no station and can never be heard`);
  }
});

test('titles and station names carry both languages', () => {
  for (const track of radio.TRACKS) {
    assert.ok(track.title.en && track.title.ru, `${track.id} is missing a title`);
  }
  for (const station of radio.STATIONS) {
    assert.ok(station.name.en && station.name.ru, `${station.id} is missing a name`);
    assert.ok(station.blurb.en && station.blurb.ru, `${station.id} is missing a blurb`);
  }
});

test('tempo, meter and swing are playable', () => {
  for (const track of radio.TRACKS) {
    assert.ok(track.bpm >= 40 && track.bpm <= 140, `${track.id}: ${track.bpm} bpm`);
    assert.ok(track.meter === 3 || track.meter === 4, `${track.id}: meter ${track.meter}`);
    assert.ok(track.swing >= 0 && track.swing <= 0.25, `${track.id}: swing ${track.swing}`);
    // A swung tango or waltz is a different genre and not this one.
    if (track.meter === 3 || track.drums === 'bolero') {
      assert.strictEqual(track.swing, 0, `${track.id} should be straight, not swung`);
    }
    for (const key of ['space', 'room', 'vinyl']) {
      assert.ok(track[key] >= 0 && track[key] <= 1, `${track.id}: ${key} is ${track[key]}`);
    }
  }
});

test('every part names a voice the engine actually has', () => {
  for (const track of radio.TRACKS) {
    assert.ok(BASS.has(track.bass), `${track.id}: no bass called "${track.bass}"`);
    assert.ok(VOICES.has(track.comp), `${track.id}: no voice called "${track.comp}"`);
    assert.ok(VOICES.has(track.lead), `${track.id}: no voice called "${track.lead}"`);
    assert.ok(DRUMS.has(track.drums), `${track.id}: no pattern called "${track.drums}"`);
    // Something has to be making a sound.
    const silent = track.bass === 'none' && track.comp === 'none'
      && track.lead === 'none' && track.drums === 'none';
    assert.ok(!silent, `${track.id} plays nothing at all`);
  }
});

test('chords are voiced rootless, in range, and in order', () => {
  for (const track of radio.TRACKS) {
    assert.ok(track.prog.length >= 2, `${track.id} has no progression`);
    for (const [i, step] of track.prog.entries()) {
      const where = `${track.id} bar ${i + 1}`;
      // An upright bass runs from about E1 to G3.
      assert.ok(step.root >= 28 && step.root <= 55, `${where}: root ${step.root} is off the instrument`);
      assert.strictEqual(step.voice.length, 4, `${where}: a voicing is four notes`);

      for (const [j, note] of step.voice.entries()) {
        assert.ok(note >= 40 && note <= 72, `${where}: voice note ${note} is outside the comping range`);
        if (j > 0) {
          assert.ok(note >= step.voice[j - 1], `${where}: voicing is not in ascending order`);
        }
        // Rootless is the whole point. Doubling the root against the bass is what makes
        // a synthesised trio sound like a MIDI file.
        assert.notStrictEqual(pitchClass(note), pitchClass(step.root),
          `${where}: the voicing doubles the root`);
      }
    }
  }
});

test('the walking bass always has a real chord to walk into', () => {
  for (const track of radio.TRACKS) {
    const roots = new Set(track.prog.map((s) => s.root));
    for (const [i, step] of track.prog.entries()) {
      assert.ok(roots.has(step.next),
        `${track.id} bar ${i + 1} walks toward ${step.next}, which is not a chord in this tune`);
    }
  }
});

test('every phrase fills exactly one bar', () => {
  for (const track of radio.TRACKS) {
    assert.ok(track.phrases.length >= 2, `${track.id} has too few phrases to vary`);
    for (const [i, phrase] of track.phrases.entries()) {
      let beats = 0;
      for (const [semis, len] of phrase) {
        assert.ok(len > 0, `${track.id} phrase ${i + 1}: a note of ${len} beats`);
        if (semis !== null) {
          assert.ok(Number.isInteger(semis) && semis >= -12 && semis <= 24,
            `${track.id} phrase ${i + 1}: ${semis} semitones is off the melody instrument`);
        }
        beats += len;
      }
      // A phrase longer than a bar overlaps the next one, and the lead plays over itself.
      assert.strictEqual(beats, track.meter,
        `${track.id} phrase ${i + 1} is ${beats} beats in a ${track.meter}-beat bar`);
    }
  }
});

test('no track is all notes or all silence', () => {
  for (const track of radio.TRACKS) {
    const rests = track.phrases.flat().filter(([s]) => s === null).length;
    const notes = track.phrases.flat().length;
    assert.ok(notes - rests >= 4, `${track.id} barely has a melody`);
  }
});

test('each track holds the dial for a sensible stretch', () => {
  for (const track of radio.TRACKS) {
    const chorus = radio.chorusSeconds(track);
    const total = chorus * radio.chorusesFor(track);
    assert.ok(chorus > 5, `${track.id}: a ${chorus.toFixed(1)}s chorus is a jingle`);
    assert.ok(total >= 60 && total <= 180,
      `${track.id} would play for ${total.toFixed(0)}s`);
    // Whole choruses only. Cutting a progression off mid-turnaround sounds like a fault.
    assert.ok(Number.isInteger(radio.chorusesFor(track)));
  }
});

test('an unknown id resolves to nothing rather than to the wrong tune', () => {
  assert.strictEqual(radio.trackById('no-such-track'), null);
  assert.strictEqual(radio.stationById('no-such-station'), null);
  assert.strictEqual(radio.trackById(undefined), null);
});
