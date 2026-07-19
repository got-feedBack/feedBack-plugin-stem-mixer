'use strict';
// Pure-state coverage for screen.js (sanitize/clone/canonicalize/persist).
// Runs under the org reusable CI as `node tests/state.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function makeLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
    };
}

function freshPlugin() {
    global.window = {};
    global.document = { readyState: 'complete', addEventListener: () => {} };
    global.localStorage = makeLocalStorage();
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

test('sanitizeState fills defaults from null/non-object input', () => {
    const { sanitizeState, DEFAULT_STATE } = freshPlugin();
    assert.deepEqual(sanitizeState(null), DEFAULT_STATE);
    assert.deepEqual(sanitizeState(undefined), DEFAULT_STATE);
    assert.deepEqual(sanitizeState('nope'), DEFAULT_STATE);
});

test('sanitizeState clamps stem levels into [0,1]', () => {
    const { sanitizeState } = freshPlugin();
    const s = sanitizeState({ levels: { guitar: 5, bass: -2, vocals: 0.4, drums: 'x' } });
    assert.equal(s.levels.guitar, 1);
    assert.equal(s.levels.bass, 0);
    assert.equal(s.levels.vocals, 0.4);
    assert.equal(s.levels.drums, 1); // non-numeric falls back to 1
});

test('sanitizeState clamps EQ bands into [-12,12]', () => {
    const { sanitizeState, EQ_BANDS } = freshPlugin();
    const eq = EQ_BANDS.map(() => 999);
    eq[0] = -999;
    eq[1] = 3;
    const s = sanitizeState({ eq });
    assert.equal(s.eq[0], -12);
    assert.equal(s.eq[1], 3);
    assert.equal(s.eq[2], 12);
});

test('sanitizeState trims selectedProfile and rejects blank/non-string', () => {
    const { sanitizeState } = freshPlugin();
    assert.equal(sanitizeState({ selectedProfile: '  Rock  ' }).selectedProfile, 'Rock');
    assert.equal(sanitizeState({ selectedProfile: '   ' }).selectedProfile, 'Default');
    assert.equal(sanitizeState({ selectedProfile: 42 }).selectedProfile, 'Default');
});

test('cloneState deep-copies levels/eq so mutation does not leak', () => {
    const { cloneState, DEFAULT_STATE } = freshPlugin();
    const clone = cloneState(DEFAULT_STATE);
    clone.levels.guitar = 0;
    clone.eq[0] = 5;
    assert.equal(DEFAULT_STATE.levels.guitar, 1);
    assert.equal(DEFAULT_STATE.eq[0], 0);
});

test('canonicalStemId resolves aliases and lowercases', () => {
    const { canonicalStemId } = freshPlugin();
    assert.equal(canonicalStemId('Voice'), 'vocals');
    assert.equal(canonicalStemId('VOCAL'), 'vocals');
    assert.equal(canonicalStemId('Guitar'), 'guitar');
    assert.equal(canonicalStemId(''), '');
    assert.equal(canonicalStemId(null), '');
    // Unknown ids pass through lowercased.
    assert.equal(canonicalStemId('Kazoo'), 'kazoo');
});

test('safeDecodeUrl decodes percent-encoding and tolerates malformed input', () => {
    const { safeDecodeUrl } = freshPlugin();
    assert.equal(safeDecodeUrl('/stems/vocals%20lead.mp3'), '/stems/vocals lead.mp3');
    assert.equal(safeDecodeUrl('%'), '%'); // malformed -> passthrough
    assert.equal(safeDecodeUrl(''), '');
    assert.equal(safeDecodeUrl(null), '');
});

test('stemIdFromUrl extracts and canonicalizes the stem name from a /stems/ path', () => {
    const { stemIdFromUrl } = freshPlugin();
    assert.equal(stemIdFromUrl('/library/song/stems/vocals.mp3'), 'vocals');
    assert.equal(stemIdFromUrl('/library/song/stems/voice.ogg'), 'vocals');
    assert.equal(stemIdFromUrl('/library/song/stems/guitar.wav?x=1'), 'guitar');
    assert.equal(stemIdFromUrl('/library/song/other/guitar.wav'), '');
    assert.equal(stemIdFromUrl(''), '');
});

test('loadState round-trips through localStorage and sanitizes on read', () => {
    const { loadState, saveState, DEFAULT_STATE } = freshPlugin();
    assert.deepEqual(loadState(), DEFAULT_STATE);
    saveState({ levels: { guitar: 0.3 }, eq: [], autolevel: true, selectedProfile: 'Live' });
    const reloaded = loadState();
    assert.equal(reloaded.levels.guitar, 0.3);
    assert.equal(reloaded.autolevel, true);
    assert.equal(reloaded.selectedProfile, 'Live');
});

test('loadState recovers from corrupt JSON', () => {
    const { loadState, DEFAULT_STATE } = freshPlugin();
    global.localStorage.setItem('stem_mixer:state', '{not json');
    assert.deepEqual(loadState(), DEFAULT_STATE);
});

test('loadProfiles sanitizes each entry and drops blank-named ones', () => {
    const { loadProfiles, saveProfiles } = freshPlugin();
    saveProfiles({
        'Rock': { levels: { guitar: 2 } }, // out of range -> clamped on load
        '   ': { levels: { guitar: 0.5 } }, // blank name dropped
    });
    const profiles = loadProfiles();
    assert.deepEqual(Object.keys(profiles), ['Rock']);
    assert.equal(profiles.Rock.levels.guitar, 1);
});

test('sanitizeState preserves dynamic (non-STEM_KEYS) levels, canonicalized and clamped', () => {
    const { sanitizeState } = freshPlugin();
    const s = sanitizeState({ levels: { strings: 0.5, Synth: 7, kazoo: -1, full: 0.2, bad: 'x' } });
    assert.equal(s.levels.strings, 0.5);
    assert.equal(s.levels.synth, 1);   // clamped high
    assert.equal(s.levels.kazoo, 0);   // clamped low
    assert.equal('full' in s.levels, false);  // reserved mixdown id dropped
    assert.equal('bad' in s.levels, false);   // non-finite dropped
    // The six known keys keep their defaults.
    assert.equal(s.levels.guitar, 1);
});

test('sanitizeState folds aliased dynamic keys into the canonical known key', () => {
    const { sanitizeState } = freshPlugin();
    // "voice" canonicalizes to "vocals", which the STEM_KEYS pass already set —
    // the alias must not create a duplicate key or overwrite it.
    const s = sanitizeState({ levels: { vocals: 0.4, voice: 0.9 } });
    assert.equal(s.levels.vocals, 0.4);
    assert.equal('voice' in s.levels, false);
});

test('dynamic levels round-trip through localStorage', () => {
    const { loadState, saveState } = freshPlugin();
    saveState({ levels: { guitar: 0.3, strings: 0.6 } });
    const reloaded = loadState();
    assert.equal(reloaded.levels.guitar, 0.3);
    assert.equal(reloaded.levels.strings, 0.6);
});

test('normalizeAvailableStems canonicalizes, dedupes, drops full/blank, handles objects', () => {
    const { normalizeAvailableStems } = freshPlugin();
    assert.deepEqual(
        normalizeAvailableStems(['Voice', 'drums', 'vocal', 'full', '', null, 'strings']),
        ['vocals', 'drums', 'strings']
    );
    assert.deepEqual(normalizeAvailableStems([{ id: 'Guitar' }, { id: 'bass' }, { id: 'guitar' }]), ['guitar', 'bass']);
    assert.deepEqual(normalizeAvailableStems('nope'), []);
    assert.deepEqual(normalizeAvailableStems([]), []);
});

test('loadProfiles tolerates corrupt storage and non-object payloads', () => {
    const { loadProfiles } = freshPlugin();
    global.localStorage.setItem('stem_mixer:profiles', '{not json');
    assert.deepEqual(loadProfiles(), {});
    global.localStorage.setItem('stem_mixer:profiles', '"a string"');
    assert.deepEqual(loadProfiles(), {});
});
