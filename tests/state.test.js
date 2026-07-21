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

test('sanitizeState resists prototype pollution and inherited-name collisions', () => {
    const { sanitizeState } = freshPlugin();
    const s = sanitizeState(JSON.parse('{"levels": {"__proto__": 0.1, "constructor": 0.2, "toString": 0.3}}'));
    assert.equal(Object.prototype.hasOwnProperty.call(s.levels, '__proto__'), false);
    assert.equal(({}).polluted, undefined);
    // Inherited names are legal stem ids — kept as OWN keys (canonicalized to
    // lowercase), not skipped via `in` or resolved through the prototype.
    assert.equal(s.levels.constructor, 0.2);
    assert.equal(s.levels.tostring, 0.3);
});

test('sanitizeState folds an alias-only payload into the canonical known key', () => {
    const { sanitizeState } = freshPlugin();
    // Legacy/externally-written state: only the alias, no canonical key.
    const s = sanitizeState({ levels: { voice: 0.9 } });
    assert.equal(s.levels.vocals, 0.9);
    assert.equal('voice' in s.levels, false);
});

test('levelFor uses own keys only and defaults inherited/missing/invalid to 1', () => {
    const { levelFor } = freshPlugin();
    assert.equal(levelFor({ guitar: 0.3 }, 'guitar'), 0.3);
    assert.equal(levelFor({ guitar: 5 }, 'guitar'), 1);      // clamped
    assert.equal(levelFor({ guitar: -2 }, 'guitar'), 0);     // clamped
    assert.equal(levelFor({}, 'strings'), 1);                // missing
    assert.equal(levelFor({}, 'constructor'), 1);            // inherited name, no own key
    assert.equal(levelFor({ constructor: 0.4 }, 'constructor'), 0.4);
    assert.equal(levelFor(null, 'guitar'), 1);
});

test('sanitizeState ignores an array levels payload instead of copying its indices', () => {
    const { sanitizeState, DEFAULT_STATE } = freshPlugin();
    assert.deepEqual(sanitizeState({ levels: [0.5, 0.7] }), DEFAULT_STATE);
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

test('extractStemMeta keeps name/description from object rows, keyed canonically', () => {
    const { extractStemMeta } = freshPlugin();
    const meta = extractStemMeta([
        { id: 'Guitar', name: 'Rhythm Guitar' },
        { id: 'click', name: 'Click', description: 'Metronome click with 4-count lead-in.' },
        { id: 'Voice', name: 'Lead Vox' },          // alias -> vocals
        { id: 'full', name: 'Full Mix' },           // reserved mixdown dropped
        { id: 'bass' },                             // no metadata -> no entry
        { id: 'drums', name: '   ', description: 7 }, // blank / non-string dropped
        'strings',                                  // plain id string -> no entry
        null,
    ]);
    assert.deepEqual(meta.guitar, { name: 'Rhythm Guitar' });
    // Padded values are stored trimmed, not raw.
    assert.deepEqual(extractStemMeta([{ id: 'bass', name: '  Bass VI  ' }]).bass, { name: 'Bass VI' });
    assert.deepEqual(meta.click, { name: 'Click', description: 'Metronome click with 4-count lead-in.' });
    assert.deepEqual(meta.vocals, { name: 'Lead Vox' });
    assert.equal('full' in meta, false);
    assert.equal('bass' in meta, false);
    assert.equal('drums' in meta, false);
    assert.equal('strings' in meta, false);
});

test('extractStemMeta yields an empty map for plain string arrays and junk', () => {
    const { extractStemMeta } = freshPlugin();
    assert.deepEqual(Object.keys(extractStemMeta(['guitar', 'bass'])), []);
    assert.deepEqual(Object.keys(extractStemMeta('nope')), []);
    assert.deepEqual(Object.keys(extractStemMeta(null)), []);
});

test('extractStemMeta reads id/name/description as own keys only', () => {
    const { extractStemMeta } = freshPlugin();
    // Values riding in off the prototype must not become metadata.
    const inherited = Object.create({ id: 'guitar', name: 'Evil', description: 'nope' });
    assert.deepEqual(Object.keys(extractStemMeta([inherited])), []);
    const ownId = Object.create({ name: 'Evil' });
    ownId.id = 'bass';
    assert.deepEqual(Object.keys(extractStemMeta([ownId])), []);
});

test('sameStemSet ignores order, catches membership changes', () => {
    const { sameStemSet } = freshPlugin();
    assert.equal(sameStemSet(['guitar', 'drums'], ['drums', 'guitar']), true);
    assert.equal(sameStemSet(['guitar', 'drums'], ['guitar', 'bass']), false);
    assert.equal(sameStemSet(['guitar'], ['guitar', 'drums']), false);
    assert.equal(sameStemSet(null, ['guitar']), false);
    assert.equal(sameStemSet(['guitar'], null), false);
});

test('stemDisplayName prefers manifest name, then built-in label, then capitalized id', () => {
    const { stemDisplayName, STEM_LABELS } = freshPlugin();
    const meta = { guitar: { name: 'Rhythm Guitar' }, click: { description: 'no name here' } };
    assert.equal(stemDisplayName('guitar', meta), 'Rhythm Guitar');
    assert.equal(stemDisplayName('vocals', meta), STEM_LABELS.vocals); // built-in label ("Voice")
    assert.equal(stemDisplayName('click', meta), 'Click');             // description alone doesn't rename
    assert.equal(stemDisplayName('kazoo', meta), 'Kazoo');             // unknown id capitalized
    assert.equal(stemDisplayName('kazoo', null), 'Kazoo');
    // Inherited names must not leak off Object.prototype.
    assert.equal(stemDisplayName('constructor', {}), 'Constructor');
});

test('loadProfiles tolerates corrupt storage and non-object payloads', () => {
    const { loadProfiles } = freshPlugin();
    global.localStorage.setItem('stem_mixer:profiles', '{not json');
    assert.deepEqual(loadProfiles(), {});
    global.localStorage.setItem('stem_mixer:profiles', '"a string"');
    assert.deepEqual(loadProfiles(), {});
});

test('saveState keeps in-memory truth when the storage write fails', () => {
    const { saveState, getCurrentState } = freshPlugin();
    // Seed a persisted baseline.
    saveState({ levels: { vocals: 0.2 } });
    assert.equal(getCurrentState().levels.vocals, 0.2);

    // Break the store the way quota/private mode does.
    const originalSetItem = global.localStorage.setItem;
    global.localStorage.setItem = () => { throw new Error('quota'); };
    saveState({ levels: { vocals: 0.9 } });
    // Reads must see the failed write, not regress to the stale stored 0.2 —
    // otherwise a UI sweep would snap the live value back mid-session.
    assert.equal(getCurrentState().levels.vocals, 0.9);

    // Once storage recovers, the next save (built from getCurrentState, as
    // every caller does) lands the in-memory truth on disk.
    global.localStorage.setItem = originalSetItem;
    const next = getCurrentState();
    next.levels.bass = 0.5;
    saveState(next);
    assert.equal(getCurrentState().levels.vocals, 0.9);
    assert.equal(getCurrentState().levels.bass, 0.5);
    assert.equal(JSON.parse(global.localStorage.getItem('stem_mixer:state')).levels.vocals, 0.9);
});
