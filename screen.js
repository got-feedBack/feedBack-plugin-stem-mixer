(function () {
    'use strict';

    const PLUGIN_ID = 'stem_mixer';

    // ── Idempotent re-injection ───────────────────────────────────────────────
    //
    // The host can run this script more than once (screen re-entry, a version change).
    // Without a teardown, the second run builds a SECOND panel and a second observer
    // while the first instance's panel stays on screen — and every module variable in
    // the new instance points at the new, invisible one.
    //
    // The user then clicks the ✕ on the panel they can SEE, the handler runs
    // perfectly, and it closes the OTHER panel. "The X doesn't work" was really
    // "there are two panels and you're looking at the one nobody owns".
    //
    // Every stateful hook has the same problem: two MutationObservers, two sets of
    // bootstrap timers, and a pane registration the host resolves to the dead
    // instance's element (first registration wins).
    if (window.__stemMixerInstance && typeof window.__stemMixerInstance.destroy === 'function') {
        try { window.__stemMixerInstance.destroy(); } catch (e) { /* tear down what we can */ }
    }
    const STEM_KEYS = ['guitar', 'bass', 'vocals', 'drums', 'piano', 'other'];
    const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000];
    const STEM_LABELS = {
        guitar: 'Guitar',
        bass: 'Bass',
        vocals: 'Voice',
        drums: 'Drums',
        piano: 'Piano',
        other: 'Other'
    };
    const STATE_KEY = `${PLUGIN_ID}:state`;
    const PROFILES_KEY = `${PLUGIN_ID}:profiles`;
    const DEFAULT_PROFILE = 'Default';
    const AUTLEVEL_TARGET_RMS = 0.16;
    const AUTLEVEL_SMOOTHING = 0.14;
    const AUTLEVEL_MIN_GAIN = 0.45;
    const AUTLEVEL_MAX_GAIN = 1.7;
    const SHOW_EQ_UI = false;
    const STEM_ALIASES = {
        voice: 'vocals',
        vocal: 'vocals',
        vocals: 'vocals',
        guitar: 'guitar',
        bass: 'bass',
        drums: 'drums',
        piano: 'piano',
        other: 'other'
    };

    const DEFAULT_STATE = {
        levels: STEM_KEYS.reduce((acc, stem) => {
            acc[stem] = 1;
            return acc;
        }, {}),
        eq: EQ_BANDS.map(() => 0),
        autolevel: false,
        selectedProfile: DEFAULT_PROFILE
    };

    let mixerButton = null;
    let mixerPanel = null;
    let mixerPanelHeader = null;
    let paneRegistered = false;
    let chipPanel = null;      // the panel node the pop-out chip is currently on
    let chipDetach = null;     // undo for that attachment
    let obs = null;
    let profileSelect = null;
    let pluginProfileSelect = null;
    let autolevelButton = null;
    let pluginAutolevelButton = null;
    let stemInputs = Object.create(null);
    let pluginStemInputs = Object.create(null);
    let eqInputs = [];
    let pluginEqInputs = [];
    let audioCtx = null;
    let filterChain = [];
    let analyserNode = null;
    let outputGainNode = null;
    let autolevelTimer = null;
    let uiUpdateTimer = null;
    let stemNodes = Object.create(null);
    let stemSourceByAudio = new WeakMap();
    let stemsBridgeInstalled = false;
    let stemsBridgeByStem = Object.create(null);
    let stemBootstrapTimers = [];
    let hideStylesInstalled = false;
    // Perf caches (see setupObservers): the whole-document audio scans and the
    // per-stem volume pushes used to run on every player-DOM mutation, which
    // profiled at 8-17% of main-thread time during playback. Audio topology
    // only changes on song load / audio-element mount, so cache and invalidate
    // on those events instead of recomputing per update.
    let stemAudioMapCache = null;
    let stemsActiveCache = null;
    let appliedLevels = Object.create(null);
    let lastUiUpdateAt = 0;
    const tokenReCache = Object.create(null);
    // The current song's stem ids. Three-valued: null = not known yet (render the
    // default six, exactly the pre-availability behavior), [] = known to have no
    // stems (render the "no stems" message), non-empty = render exactly these.
    let availableStems = null;
    // Per-stem display metadata keyed by canonical id: the manifest's optional
    // `name`/`description` (feedpak §5.3), when a source that carries them
    // (stems:state `stems` rows, getState() rows) has reported. Presentation
    // only — levels, aliases and persistence all stay keyed by id.
    let stemMeta = Object.create(null);
    let onStemsStateEvent = null;
    // Write-behind persistence for slider drags. localStorage is synchronous
    // main-thread work, and the old per-`input`-tick save chain (our state
    // write + the stems plugin's saveVolume/saveMuted + owner-status
    // snapshots) starved the highway's requestAnimationFrame loop and
    // stuttered playback. Drags stage their state here and flush once,
    // shortly after the last tick.
    let pendingState = null;
    let pendingDragLevels = Object.create(null);
    let pendingFlushTimer = null;

    function invalidateAudioCaches() {
        stemAudioMapCache = null;
        stemsActiveCache = null;
        stemNodes = Object.create(null);
        appliedLevels = Object.create(null);
    }

    function cloneState(state) {
        return {
            levels: Object.assign({}, state.levels || {}),
            eq: Array.isArray(state.eq) ? state.eq.slice(0, EQ_BANDS.length) : EQ_BANDS.map(() => 0),
            autolevel: !!state.autolevel,
            selectedProfile: state.selectedProfile || DEFAULT_PROFILE
        };
    }

    function sanitizeState(rawState) {
        const next = cloneState(DEFAULT_STATE);
        if (!rawState || typeof rawState !== 'object') return next;

        STEM_KEYS.forEach((stem) => {
            const n = Number(rawState.levels && rawState.levels[stem]);
            next.levels[stem] = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
        });

        // Songs can carry stems beyond the six known ids ("strings", "synth", …).
        // Their levels live in the same map; keep them or every reload silently
        // resets those stems to full volume.
        const rawLevels = (rawState.levels && typeof rawState.levels === 'object' && !Array.isArray(rawState.levels))
            ? rawState.levels : {};
        Object.keys(rawLevels).forEach((key) => {
            const canonical = canonicalStemId(key);
            // Dedup against the RAW payload, not next.levels — next.levels
            // already owns all six STEM_KEYS (defaulted) before this loop, so
            // checking it would block an alias-only value (e.g. only "voice",
            // no "vocals") from ever reaching its canonical stem. Own-key
            // check, not `in`: inherited names ('constructor', …) are legal
            // stem ids. '__proto__' is the one key plain assignment can't
            // shadow — drop it outright.
            if (!canonical || canonical === 'full' || canonical === '__proto__' ||
                (canonical !== key && Object.prototype.hasOwnProperty.call(rawLevels, canonical))) return;
            const n = Number(rawLevels[key]);
            if (Number.isFinite(n)) next.levels[canonical] = Math.max(0, Math.min(1, n));
        });

        EQ_BANDS.forEach((_, idx) => {
            const n = Number(rawState.eq && rawState.eq[idx]);
            next.eq[idx] = Number.isFinite(n) ? Math.max(-12, Math.min(12, n)) : 0;
        });

        next.autolevel = !!rawState.autolevel;
        if (typeof rawState.selectedProfile === 'string' && rawState.selectedProfile.trim()) {
            next.selectedProfile = rawState.selectedProfile.trim();
        }
        return next;
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);
            if (!raw) return cloneState(DEFAULT_STATE);
            const parsed = JSON.parse(raw);
            return sanitizeState(parsed);
        } catch (_) {
            return cloneState(DEFAULT_STATE);
        }
    }

    function saveState(state) {
        // A direct save supersedes the drag write-behind. Callers either
        // build `state` from getCurrentState() (staged values folded in) or
        // pass a deliberate wholesale replacement (applyProfile) — in both
        // cases this write is the newer truth, so drop the staging: a later
        // flush must not overwrite it with older data. The staged stems-API
        // application still runs — those levels were audible, and the stems
        // plugin's own per-song persistence isn't covered by our store.
        if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
        pendingState = null;
        applyPendingDragLevels();
        const sanitized = sanitizeState(state);
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify(sanitized));
        } catch (_) {
            // Storage failed (private mode, quota, etc). Keep this state as
            // the in-memory truth: getCurrentState() readers must not fall
            // back to the stale stored copy, or a UI sweep would snap live
            // values back for the rest of the session. Any later save either
            // carries this forward (getCurrentState-based callers) or
            // replaces it on purpose — both retry the write.
            pendingState = sanitized;
        }
    }

    // Apply staged drag levels through the FULL stems API — the per-song
    // persistence, button-UI updates and owner-status snapshot that
    // previewStemVolume() deliberately skips on every `input` tick.
    function applyPendingDragLevels() {
        const staged = pendingDragLevels;
        pendingDragLevels = Object.create(null);
        Object.keys(staged).forEach((stem) => {
            try {
                setStemVolumeViaStemsApi(stem, staged[stem]);
            } catch (e) {
                // The stems plugin can throw mid-rebuild (stemsReachable()
                // expects the same). Don't let one stem abort the caller's
                // save or drop the rest — re-stage it (unless a newer level
                // arrived meanwhile) so the next flush/save retries. The
                // audible gain already landed via previewStemVolume().
                if (!(stem in pendingDragLevels)) pendingDragLevels[stem] = staged[stem];
            }
        });
    }

    function flushPending() {
        if (pendingFlushTimer) { clearTimeout(pendingFlushTimer); pendingFlushTimer = null; }
        applyPendingDragLevels();
        if (!pendingState) return;
        const state = pendingState;
        pendingState = null;
        saveState(state);
    }

    function schedulePendingFlush() {
        // Trailing debounce: one flush shortly after the last slider tick.
        // 250 ms is long enough that a continuous drag never flushes mid-drag
        // and short enough that the final value lands effectively instantly.
        if (pendingFlushTimer) clearTimeout(pendingFlushTimer);
        pendingFlushTimer = setTimeout(flushPending, 250);
    }

    function loadProfiles() {
        try {
            const raw = localStorage.getItem(PROFILES_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return {};
            const cleaned = {};
            Object.keys(parsed).forEach((name) => {
                if (!name.trim()) return;
                cleaned[name] = sanitizeState(parsed[name]);
            });
            return cleaned;
        } catch (_) {
            return {};
        }
    }

    function saveProfiles(profiles) {
        try {
            localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles || {}));
        } catch (_) {
            // Ignore storage errors.
        }
    }

    function getCurrentState() {
        // While a drag's write-behind save is pending, the staged state — not
        // localStorage — is the truth. Every reader (applyStoredState's
        // re-push, profile capture, autolevel) must see it, or a mid-drag UI
        // sweep would read the stale stored level and snap the volume back.
        // The sanitize here doubles as a CLONE: callers mutate the returned
        // state, and none of that may alias into pendingState. loadState()
        // already returns a fresh sanitized object, so no second pass there.
        if (pendingState) return sanitizeState(pendingState);
        return loadState();
    }

    function isStemsPluginActive() {
        if (window.stems) return true;
        if (stemsActiveCache !== null) return stemsActiveCache;
        let active = false;
        if (document.getElementById('stems-mixer')) {
            active = true;
        } else {
            const audios = document.querySelectorAll('audio');
            for (let i = 0; i < audios.length; i += 1) {
                const audio = audios[i];
                const src = safeDecodeUrl(String(audio.currentSrc || audio.src || '')).toLowerCase();
                if (src.includes('/stems/')) { active = true; break; }
            }
        }
        stemsActiveCache = active;
        return active;
    }

    function canonicalStemId(stemId) {
        const lower = String(stemId || '').toLowerCase();
        // Own-key lookup: ids like 'constructor' would otherwise resolve to
        // values inherited from Object.prototype.
        return Object.prototype.hasOwnProperty.call(STEM_ALIASES, lower) ? STEM_ALIASES[lower] : lower;
    }

    // Canonical, deduped stem ids from whatever shape the source hands us —
    // string arrays (stems:state stemIds), object arrays (stems.getState() rows).
    // The reserved "full" mixdown is not a mixable stem and is dropped.
    function normalizeAvailableStems(ids) {
        const out = [];
        (Array.isArray(ids) ? ids : []).forEach((entry) => {
            const raw = (entry && typeof entry === 'object') ? entry.id : entry;
            const canonical = canonicalStemId(raw);
            if (canonical && canonical !== 'full' && canonical !== '__proto__' && !out.includes(canonical)) out.push(canonical);
        });
        return out;
    }

    // Display metadata from object rows, keyed by canonical id. Only own,
    // non-blank strings survive — own-key reads throughout, so values riding
    // in off a crafted prototype are never treated as metadata; plain string
    // arrays yield an empty map.
    function extractStemMeta(ids) {
        const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
        const out = Object.create(null);
        (Array.isArray(ids) ? ids : []).forEach((entry) => {
            if (!entry || typeof entry !== 'object') return;
            const canonical = canonicalStemId(own(entry, 'id') ? entry.id : '');
            if (!canonical || canonical === 'full' || canonical === '__proto__') return;
            const meta = {};
            // Stored trimmed: whitespace-only is already rejected, so padding
            // must not survive into the label / tooltip either.
            const rawName = own(entry, 'name') ? entry.name : undefined;
            const rawDescription = own(entry, 'description') ? entry.description : undefined;
            const name = typeof rawName === 'string' ? rawName.trim() : '';
            const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
            if (name) meta.name = name;
            if (description) meta.description = description;
            if (Object.keys(meta).length && !(canonical in out)) out[canonical] = meta;
        });
        return out;
    }

    // Same membership regardless of order. Reorder-only reports must not count
    // as a "new list" for metadata purposes: a plain-id source replaying the
    // same stems in a different order carries no metadata, and treating the
    // reorder as a list change would let it wipe what a richer source provided.
    function sameStemSet(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every(id => b.includes(id));
    }

    function setAvailableStems(ids) {
        const next = ids == null ? null : normalizeAvailableStems(ids);
        const nextMeta = extractStemMeta(ids);
        const listChanged = JSON.stringify(next) !== JSON.stringify(availableStems);
        // A metadata-less report (plain id strings from an older stems plugin,
        // bridge/audio-map derived keys) must never wipe metadata a richer
        // report already provided for the same stems — only a membership
        // change (not a reorder of the same set) or a report that actually
        // carries metadata may replace it.
        const membershipChanged = listChanged && !sameStemSet(next, availableStems);
        const metaChanged = (membershipChanged || Object.keys(nextMeta).length > 0)
            && JSON.stringify(nextMeta) !== JSON.stringify(stemMeta);
        if (!listChanged && !metaChanged) return;
        if (listChanged) availableStems = next;
        if (metaChanged) stemMeta = nextMeta;
        queueUiUpdate();
    }

    // What the slider surfaces should show right now.
    function displayStems() {
        return Array.isArray(availableStems) ? availableStems : STEM_KEYS;
    }

    // Stored level for a stem, defaulting to full volume. Own-key lookup: a
    // dynamic id like 'constructor' would otherwise resolve to a value
    // inherited from Object.prototype and poison the gain math with NaN.
    function levelFor(levels, stem) {
        if (levels && Object.prototype.hasOwnProperty.call(levels, stem)) {
            const n = Number(levels[stem]);
            if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
        }
        return 1;
    }

    function safeDecodeUrl(url) {
        const src = String(url || '');
        if (!src) return '';
        try {
            return decodeURIComponent(src);
        } catch (_) {
            return src;
        }
    }

    function stemIdFromUrl(url) {
        const decoded = safeDecodeUrl(String(url || '')).toLowerCase();
        if (!decoded.includes('/stems/')) return '';
        const m = decoded.match(/\/stems\/([^/?#]+?)\.[a-z0-9]+(?:$|[?#])/i) || decoded.match(/\/stems\/([^/?#]+?)$/i);
        if (!m || !m[1]) return '';
        return canonicalStemId(m[1]);
    }

    function bindStemsBridgeNode(stemId, sourceNode, gainNode) {
        const canonical = canonicalStemId(stemId);
        if (!canonical) return;
        const audio = sourceNode && sourceNode.mediaElement ? sourceNode.mediaElement : null;
        stemsBridgeByStem[canonical] = {
            source: sourceNode || null,
            gain: gainNode || null,
            audio: audio || null
        };
    }

    function installStemsGraphBridge() {
        if (stemsBridgeInstalled) return;
        const proto = window.AudioContext && window.AudioContext.prototype;
        if (!proto || typeof proto.createMediaElementSource !== 'function') return;
        const original = proto.createMediaElementSource;
        proto.createMediaElementSource = function (mediaElement) {
            const sourceNode = original.call(this, mediaElement);
            try {
                const stemId = stemIdFromUrl(mediaElement && (mediaElement.currentSrc || mediaElement.src));
                if (stemId) {
                    const oldConnect = sourceNode.connect.bind(sourceNode);
                    sourceNode.connect = function (destNode, ...rest) {
                        bindStemsBridgeNode(stemId, sourceNode, destNode || null);
                        return oldConnect(destNode, ...rest);
                    };
                }
            } catch (_) {
                // Ignore bridge failures; plugin should still function.
            }
            return sourceNode;
        };
        stemsBridgeInstalled = true;
    }

    function getStemAudioMap() {
        if (stemAudioMapCache) return stemAudioMapCache;
        const map = Object.create(null);
        const audios = document.querySelectorAll('audio');
        const hasToken = (text, token) => {
            if (!text || !token) return false;
            let re = tokenReCache[token];
            if (!re) {
                const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
                tokenReCache[token] = re;
            }
            return re.test(text);
        };
        const looksLikeStemSource = (text, stem) => {
            if (!text) return false;
            const aliases = stem === 'vocals' ? ['vocals', 'vocal', 'voice'] : [stem];
            const pathHit = aliases.some(a => text.includes(`/stems/${a}.`));
            const stemWordHit = text.includes('/stems/') && aliases.some(a => text.includes(a));
            return pathHit || stemWordHit;
        };

        audios.forEach((audio) => {
            const id = String(audio.id || '').toLowerCase();
            const cls = String(audio.className || '').toLowerCase();
            const src = String(audio.currentSrc || audio.src || '').toLowerCase();
            const srcDecoded = safeDecodeUrl(src).toLowerCase();
            const dataStem = String((audio.dataset && audio.dataset.stem) || '').toLowerCase();
            const joined = `${id} ${cls} ${src} ${srcDecoded} ${dataStem}`;

            // Exact-id detection first: data-stem or a /stems/<id>.<ext> path names
            // the stem outright, whatever the id — including ones outside STEM_KEYS.
            // The token heuristics below stay as a fallback for the six known ids.
            const exact = canonicalStemId(dataStem) || stemIdFromUrl(srcDecoded) || stemIdFromUrl(src);
            if (exact && exact !== 'full' && exact !== '__proto__' && !map[exact]) map[exact] = audio;

            STEM_KEYS.forEach((stem) => {
                const stemAlias = stem === 'vocals' ? ['voice', 'vocals', 'vocal'] : [stem];
                const byDataAttr = stemAlias.some(alias => dataStem === alias);
                const byStemPath = looksLikeStemSource(src, stem) || looksLikeStemSource(srcDecoded, stem);
                const byTokens = stemAlias.some(alias => hasToken(joined, alias)) && (
                    hasToken(joined, 'stem') || src.includes('/stems/') || srcDecoded.includes('/stems/')
                );
                if ((byDataAttr || byStemPath || byTokens) && !map[stem]) {
                    map[stem] = audio;
                }
            });
        });
        stemAudioMapCache = map;
        return map;
    }

    function setStemVolumeViaStemsApi(stem, clamped) {
        const canonical = canonicalStemId(stem);
        let applied = false;
        if (window.stems) {
            if (typeof window.stems.setVolume === 'function') {
                window.stems.setVolume(canonical, clamped);
                applied = true;
            }
            if (typeof window.stems.setMuted === 'function') {
                window.stems.setMuted(canonical, false);
                applied = true;
            }
            if (typeof window.stems.getState === 'function') {
                const current = window.stems.getState();
                if (Array.isArray(current)) {
                    current.forEach((item) => {
                        const id = canonicalStemId(item && item.id);
                        if (id !== canonical) return;
                        item.vol = clamped;
                        if (item.gain && item.gain.gain) item.gain.gain.value = clamped;
                        if ('on' in item) item.on = true;
                        if (item.audio) item.audio.muted = false;
                        applied = true;
                    });
                }
            }
            if (Array.isArray(window.stems.stemState)) {
                window.stems.stemState.forEach((item) => {
                    const id = canonicalStemId(item && item.id);
                    if (id !== canonical) return;
                    item.vol = clamped;
                    if (item.gain && item.gain.gain) item.gain.gain.value = clamped;
                    if ('on' in item) item.on = true;
                    if (item.audio) item.audio.muted = false;
                    applied = true;
                });
            }
        }

        const bridged = stemsBridgeByStem[canonical];
        if (bridged) {
            if (bridged.gain && bridged.gain.gain) bridged.gain.gain.value = clamped;
            if (bridged.audio) {
                bridged.audio.muted = false;
                bridged.audio.volume = 1;
            }
            applied = true;
        }
        return applied;
    }

    function ensureAudioContext() {
        if (audioCtx) return audioCtx;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        buildAudioGraph();
        return audioCtx;
    }

    function buildAudioGraph() {
        if (!audioCtx || outputGainNode) return;
        outputGainNode = audioCtx.createGain();
        outputGainNode.gain.value = 1;

        analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 1024;
        analyserNode.smoothingTimeConstant = 0.82;

        filterChain = EQ_BANDS.map((freq, idx) => {
            const f = audioCtx.createBiquadFilter();
            f.type = idx === 0 ? 'lowshelf' : (idx === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking');
            f.frequency.value = freq;
            f.Q.value = idx === 0 || idx === EQ_BANDS.length - 1 ? 0.7 : 1.0;
            f.gain.value = 0;
            return f;
        });

        for (let i = 0; i < filterChain.length - 1; i += 1) {
            filterChain[i].connect(filterChain[i + 1]);
        }
        filterChain[filterChain.length - 1].connect(outputGainNode);
        outputGainNode.connect(analyserNode);
        analyserNode.connect(audioCtx.destination);
    }

    function ensureStemNodes() {
        if (isStemsPluginActive()) return;
        const ctx = ensureAudioContext();
        if (!ctx || !filterChain.length) return;
        const map = getStemAudioMap();

        Object.keys(map).forEach((stem) => {
            const audio = map[stem];
            if (!audio) return;

            if (stemSourceByAudio.has(audio)) {
                stemNodes[stem] = stemSourceByAudio.get(audio).stemGain;
                return;
            }

            try {
                const source = ctx.createMediaElementSource(audio);
                const stemGain = ctx.createGain();
                stemGain.gain.value = 1;
                source.connect(stemGain);
                stemGain.connect(filterChain[0]);
                stemSourceByAudio.set(audio, { source: source, stemGain: stemGain });
                stemNodes[stem] = stemGain;
            } catch (_) {
                // If source already exists elsewhere, fallback to audio.volume only.
            }
        });
    }

    function setStemVolume(stem, level, skipSave) {
        const clamped = Math.max(0, Math.min(1, Number(level) || 0));
        const canonical = canonicalStemId(stem);
        // In worklet mode (stems plugin present) there are no per-stem <audio>
        // elements — the level goes through window.stems. Skip the element map
        // and node graph entirely so this path never touches the DOM.
        if (!window.stems) {
            const map = getStemAudioMap();
            if (map[canonical]) {
                map[canonical].volume = clamped;
                map[canonical].muted = false;
            }
            ensureStemNodes();
            if (stemNodes[canonical]) {
                stemNodes[canonical].gain.value = clamped;
            }
        }
        setStemVolumeViaStemsApi(canonical, clamped);
        appliedLevels[canonical] = clamped;

        if (!skipSave) {
            if (!pendingState) pendingState = getCurrentState();
            pendingState.levels[canonical] = clamped;
            schedulePendingFlush();
        }
    }

    // Per-tick path for slider drags. `input` fires at pointer-move rate, so
    // this does only the work that must track the pointer: the audible gain
    // and the staged state. Everything heavy — our localStorage write, the
    // stems plugin's saveVolume/saveMuted/button updates/owner-status
    // snapshots — waits for flushPending(). Deliberately does NOT write
    // item.vol: the flush's stems.setVolume() only persists when it sees the
    // value change from the one it last saved.
    function previewStemVolume(stem, level) {
        const clamped = Math.max(0, Math.min(1, Number(level) || 0));
        const canonical = canonicalStemId(stem);
        if (!window.stems) {
            const map = getStemAudioMap();
            if (map[canonical]) {
                map[canonical].volume = clamped;
                map[canonical].muted = false;
            }
            ensureStemNodes();
            if (stemNodes[canonical]) {
                stemNodes[canonical].gain.value = clamped;
            }
        } else {
            // stemState is the live internal array (no allocation, unlike
            // getState()); the API docs bless writing gain.gain.value
            // directly as the caller-side fast path.
            const raw = Array.isArray(window.stems.stemState)
                ? window.stems.stemState
                : (typeof window.stems.getState === 'function' ? window.stems.getState() : null);
            const applyItem = (item, fallbackId) => {
                if (!item || typeof item !== 'object') return;
                if (canonicalStemId(item.id != null ? item.id : fallbackId) !== canonical) return;
                if (item.gain && item.gain.gain) item.gain.gain.value = clamped;
                if ('on' in item) item.on = true;
                if (item.audio) item.audio.muted = false;
            };
            // Array (newer) or keyed object (older) — the same two getState()
            // shapes stemsReachable() accepts. Without the object arm, a host
            // whose only surface is object-form getState() would hear nothing
            // until the flush.
            if (Array.isArray(raw)) {
                raw.forEach((item) => applyItem(item, null));
            } else if (raw && typeof raw === 'object') {
                Object.keys(raw).forEach((key) => applyItem(raw[key], key));
            }
        }

        const bridged = stemsBridgeByStem[canonical];
        if (bridged) {
            if (bridged.gain && bridged.gain.gain) bridged.gain.gain.value = clamped;
            if (bridged.audio) {
                bridged.audio.muted = false;
                bridged.audio.volume = 1;
            }
        }

        appliedLevels[canonical] = clamped;
        if (!pendingState) pendingState = getCurrentState();
        pendingState.levels[canonical] = clamped;
        pendingDragLevels[canonical] = clamped;
        schedulePendingFlush();
    }

    function clearStemBootstrapTimers() {
        stemBootstrapTimers.forEach((t) => clearTimeout(t));
        stemBootstrapTimers = [];
    }

    // True once the new song's stems are actually addressable.
    //
    // This MUST cover every surface setStemVolumeViaStemsApi() can write through, or
    // the poll below waits for stems it could already be driving, times out, and the
    // levels are never applied — which is the exact bug that loop exists to fix. The
    // writer supports four; this used to check two.
    //
    // Note what is deliberately NOT here: the mere presence of `stems.setVolume`.
    // That is a capability, not state — it exists before the new song's stems do, so
    // trusting it would declare victory immediately after a song change and push the
    // levels into nothing.  We are waiting for the stems to EXIST, not for the API to.
    function stemsReachable() {
        const stems = window.stems;
        if (stems) {
            try {
                if (typeof stems.getState === 'function') {
                    const s = stems.getState();
                    // Array (newer) or keyed object (older) — both count when non-empty.
                    if (Array.isArray(s) ? s.length > 0 : (s && Object.keys(s).length > 0)) return true;
                }
                // The alternate/older surface. setStemVolumeViaStemsApi writes to it,
                // so a host that only has this one is perfectly drivable.
                if (Array.isArray(stems.stemState) && stems.stemState.length > 0) return true;
            } catch (e) { /* stems plugin mid-rebuild — try again next tick */ }
        }
        // The graph bridge (AudioContext.prototype.createMediaElementSource snooping).
        // If we caught the stems plugin wiring its nodes, we can drive those gains
        // whether or not any <audio> element is discoverable.
        if (Object.keys(stemsBridgeByStem).length > 0) return true;

        return Object.keys(getStemAudioMap()).length > 0;
    }

    // Push the stored levels at the new song until they actually land.
    //
    // This used to be five fixed timeouts ending at 1800 ms — a guess at when the
    // audio would exist. When it guessed wrong (a sloppak still being extracted,
    // the stems plugin still rebuilding its graph) every push hit nothing, the
    // ladder ran out, and the song played at full volume on every stem with the
    // user's mixer settings sitting right there in the UI, apparently applied.
    //
    // So: poll instead of guess. Retry until the stems are reachable, push once
    // more when they are, then stop. Bounded, because a song genuinely without
    // stems must not leave a timer running forever.
    function scheduleStemVolumeBootstrapSync() {
        clearStemBootstrapTimers();
        const INTERVAL_MS = 200;
        const MAX_WAIT_MS = 12000;   // generous: covers a cold sloppak extraction
        let waited = 0;
        let landed = false;

        const tick = () => {
            // Do NOT read the state here. getCurrentState() is a localStorage read
            // plus a JSON.parse plus a sanitize pass, and this polls every 200ms for
            // up to 12s — sixty synchronous storage reads during a song load, to
            // produce a value that is only used once the stems are reachable. Read it
            // in the branch that actually needs it.
            if (stemsReachable()) {
                // Record what this song actually has. getState() is authoritative
                // when non-empty; the bridge/audio-map keys are heuristic-derived,
                // so they only fill in when nothing better has reported yet.
                let reported = null;
                if (window.stems && typeof window.stems.getState === 'function') {
                    try { reported = window.stems.getState(); } catch (e) { reported = null; }
                }
                if (Array.isArray(reported) && reported.length > 0) {
                    setAvailableStems(reported);
                } else if (availableStems === null) {
                    const bridged = Object.keys(stemsBridgeByStem);
                    const mapped = bridged.length ? bridged : Object.keys(getStemAudioMap());
                    if (mapped.length) setAvailableStems(mapped);
                }

                const state = getCurrentState();
                // Force the write (skipSave, and past the appliedLevels
                // idempotence guard) — the audio is new, so whatever that guard
                // thinks was already applied was applied to the PREVIOUS song's
                // nodes.
                appliedLevels = Object.create(null);
                displayStems().forEach((stem) => {
                    const level = levelFor(state.levels, stem);
                    setStemVolume(stem, level, true);
                });
                if (landed) return;          // second successful push — settled, stop.

                // Schedule the confirmation pass and return WITHOUT touching the
                // deadline. MAX_WAIT_MS bounds how long we wait for stems to appear,
                // not what we do once they have: stems that turn up near the cutoff
                // would otherwise get their first push and then be abandoned by the
                // very next line — the one case where the levels are most likely to
                // still be settling.
                landed = true;
                stemBootstrapTimers.push(setTimeout(tick, INTERVAL_MS));
                return;
            }

            waited += INTERVAL_MS;
            if (waited >= MAX_WAIT_MS) {
                // No stems ever became reachable. If nothing (e.g. a stems:state
                // event) established the list either, this is our only signal that
                // the song is stem-less — flip unknown to known-empty so the UI
                // shows the message instead of six dead sliders. Never overwrite
                // an event-established list.
                if (availableStems === null) setAvailableStems([]);
                return;
            }
            stemBootstrapTimers.push(setTimeout(tick, INTERVAL_MS));
        };

        stemBootstrapTimers.push(setTimeout(tick, 120));
    }

    function applyEqToGraph(eqValues) {
        if (isStemsPluginActive()) return;
        if (!filterChain.length) return;
        EQ_BANDS.forEach((_, idx) => {
            const value = Number(eqValues[idx]) || 0;
            filterChain[idx].gain.value = Math.max(-12, Math.min(12, value));
        });
    }

    function setEqBand(index, value, skipSave) {
        const clamped = Math.max(-12, Math.min(12, Number(value) || 0));
        const state = getCurrentState();
        state.eq[index] = clamped;
        ensureAudioContext();
        applyEqToGraph(state.eq);

        if (eqInputs[index]) {
            eqInputs[index].value = String(Math.round(clamped));
            if (eqInputs[index]._valueTag) eqInputs[index]._valueTag.textContent = `${Math.round(clamped)} dB`;
        }
        if (pluginEqInputs[index]) {
            pluginEqInputs[index].value = String(Math.round(clamped));
            if (pluginEqInputs[index]._valueTag) pluginEqInputs[index]._valueTag.textContent = `${Math.round(clamped)}`;
        }

        if (skipSave) return;
        // Write-behind, same as the volume path — EQ `input` fires just as
        // fast as the stem sliders. (The save used to run unconditionally
        // above this guard, so skipSave never actually skipped it.)
        if (!pendingState) pendingState = state;
        pendingState.eq[index] = clamped;
        schedulePendingFlush();
    }

    function updateAutolevelButtonState(enabled) {
        const applyStyle = (btn) => {
            if (!btn) return;
            btn.className = enabled
                ? 'px-2 py-1 bg-blue-900/50 rounded text-xs text-blue-200 transition'
                : 'px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-300 transition';
            btn.textContent = 'Output autolevel';
        };
        applyStyle(autolevelButton);
        applyStyle(pluginAutolevelButton);
    }

    function computeRmsFromAnalyser() {
        if (!analyserNode) return 0;
        const data = new Float32Array(analyserNode.fftSize);
        analyserNode.getFloatTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
            const v = data[i];
            sum += v * v;
        }
        return Math.sqrt(sum / data.length);
    }

    function setAutolevelEnabled(enabled, skipSave) {
        if (isStemsPluginActive()) {
            const state = getCurrentState();
            state.autolevel = false;
            if (!skipSave) saveState(state);
            updateAutolevelButtonState(false);
            if (autolevelTimer) {
                clearInterval(autolevelTimer);
                autolevelTimer = null;
            }
            if (outputGainNode) outputGainNode.gain.value = 1;
            return;
        }
        const ctx = ensureAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const state = getCurrentState();
        state.autolevel = !!enabled;
        if (!skipSave) saveState(state);
        updateAutolevelButtonState(state.autolevel);

        if (autolevelTimer) {
            clearInterval(autolevelTimer);
            autolevelTimer = null;
        }
        if (!state.autolevel || !outputGainNode) {
            if (outputGainNode) outputGainNode.gain.value = 1;
            return;
        }

        autolevelTimer = setInterval(() => {
            if (!outputGainNode) return;
            const rms = computeRmsFromAnalyser();
            if (!rms || rms < 0.0008) return;
            const desired = AUTLEVEL_TARGET_RMS / rms;
            const targetGain = Math.max(AUTLEVEL_MIN_GAIN, Math.min(AUTLEVEL_MAX_GAIN, desired));
            const curr = outputGainNode.gain.value;
            outputGainNode.gain.value = (curr * (1 - AUTLEVEL_SMOOTHING)) + (targetGain * AUTLEVEL_SMOOTHING);
        }, 180);
    }

    function applyStateToUi(state) {
        // Iterate the inputs that exist, not STEM_KEYS — the rendered sliders are
        // per-song and can include ids outside the six known ones.
        [stemInputs, pluginStemInputs].forEach((registry) => {
            Object.keys(registry).forEach((stem) => {
                if (!registry[stem]) return;
                const level = levelFor(state.levels, stem);
                const val = Math.round(level * 100);
                registry[stem].value = String(val);
                if (registry[stem]._pctTag) registry[stem]._pctTag.textContent = `${val}%`;
            });
        });

        EQ_BANDS.forEach((_, idx) => {
            if (!eqInputs[idx]) return;
            const v = Math.round(Number(state.eq[idx]) || 0);
            eqInputs[idx].value = String(v);
            if (eqInputs[idx]._valueTag) eqInputs[idx]._valueTag.textContent = `${v} dB`;
        });
        EQ_BANDS.forEach((_, idx) => {
            if (!pluginEqInputs[idx]) return;
            const v = Math.round(Number(state.eq[idx]) || 0);
            pluginEqInputs[idx].value = String(v);
            if (pluginEqInputs[idx]._valueTag) pluginEqInputs[idx]._valueTag.textContent = `${v}`;
        });

        if (profileSelect) profileSelect.value = state.selectedProfile || DEFAULT_PROFILE;
        if (pluginProfileSelect) pluginProfileSelect.value = state.selectedProfile || DEFAULT_PROFILE;
        updateAutolevelButtonState(!!state.autolevel);
    }

    function applyStoredState() {
        const state = getCurrentState();
        if (!isStemsPluginActive()) ensureAudioContext();
        ensureStemNodes();
        displayStems().forEach((stem) => {
            const level = levelFor(state.levels, stem);
            // Idempotence: skip stems whose level was already pushed. Without
            // this, every UI-update pass re-wrote button classes/aria in the
            // stems plugin (via stems.setVolume), whose DOM mutations re-armed
            // our own MutationObserver — a self-sustaining ~12 Hz loop.
            // appliedLevels is cleared on song load, so new songs re-push.
            if (appliedLevels[stem] === level) return;
            setStemVolume(stem, level, true);
        });
        applyEqToGraph(state.eq);
        setAutolevelEnabled(state.autolevel, true);
        applyStateToUi(state);
    }

    // Look up an element that lives INSIDE the floating panel.
    //
    // Not document.getElementById(): the panel is a detachable pane, so the host may
    // have moved it into a pop-out window's document. Our code still runs here, in
    // the main window, where `document` is the MAIN document — and the panel is no
    // longer in it. Every id lookup would quietly return null, and every update it
    // guards would silently stop happening, exactly while the user is looking at the
    // panel.
    //
    // Searching from the panel itself works in either document. Elements that live in
    // the PLUGIN SCREEN (the `stem-mixer-plugin-*` ids) never move, so they keep
    // using document.getElementById.
    function panelEl(id) {
        return mixerPanel ? mixerPanel.querySelector('#' + id) : null;
    }

    function syncUiForCompatibilityMode() {
        const inCompatMode = isStemsPluginActive();
        const eqSection = panelEl('stem-mixer-eq-section');
        const eqWrap = panelEl('stem-mixer-eq-wrap');
        const eqActions = panelEl('stem-mixer-eq-actions');
        if (eqSection) {
            eqSection.style.display = inCompatMode ? 'none' : '';
        }
        if (eqWrap) {
            eqWrap.style.display = inCompatMode ? 'none' : '';
        }
        if (eqActions) {
            eqActions.style.display = inCompatMode ? 'none' : '';
        }
        const hint = panelEl('stem-mixer-hint');
        if (hint) {
            hint.textContent = inCompatMode
                ? 'Compatibility mode: stems plugin detected. Stem Mixer controls per-stem volume only to avoid audio conflicts.'
                : 'Profiles are global: stem volumes, EQ and autolevel apply to all songs/sloppaks (not per-song).';
        }
        const pluginNote = document.getElementById('stem-mixer-plugin-mode-note');
        if (pluginNote) {
            pluginNote.textContent = inCompatMode
                ? 'EQ/autolevel are disabled while stems plugin audio engine is active.'
                : '';
        }
    }

    function hideDefaultStemButtons() {
        const controls = document.getElementById('player-controls');
        if (!controls) return;

        const stemTokens = ['stem', 'stems', 'guitar', 'bass', 'voice', 'vocals', 'vocal', 'drums', 'drum', 'piano', 'other'];
        const normalize = (txt) => String(txt || '').toLowerCase().replace(/[^a-z]/g, '');
        const looksLikeStemControl = (txt) => {
            const n = normalize(txt);
            if (!n) return false;
            if (stemTokens.includes(n)) return true;
            return stemTokens.some(token => n.includes(token));
        };

        const stemsContainer = controls.querySelector('#stems-mixer');
        if (stemsContainer) {
            stemsContainer.style.display = 'none';
            stemsContainer.dataset.stemMixerHidden = '1';
        }

        controls.querySelectorAll('button, span, div, a').forEach((el) => {
            if (el.id === 'btn-stem-mixer') return;
            const txt = (el.textContent || '').trim();
            if (!txt || txt.length > 18) return;
            if (looksLikeStemControl(txt)) {
                el.style.display = 'none';
                el.dataset.stemMixerHidden = '1';
            }
        });
    }

    function ensureHideStemsUiStyles() {
        if (hideStylesInstalled) return;
        const style = document.createElement('style');
        style.id = 'stem-mixer-hide-stems-ui';
        style.textContent = [
            '#player-controls #stems-mixer { display: none !important; }',
            '#player-controls [data-stems-ui] { display: none !important; }'
        ].join('\n');
        document.head.appendChild(style);
        hideStylesInstalled = true;
    }

    function hideStemsSettingsOptions() {
        const pluginSettings = document.getElementById('plugin-settings');
        if (!pluginSettings) return;

        // Prefer structural hook if stems plugin exposes one.
        const stemsSettingsById = pluginSettings.querySelector('#stems-default-muted, #stems-settings, [data-stems-settings]');
        if (stemsSettingsById) {
            stemsSettingsById.style.display = 'none';
            stemsSettingsById.dataset.stemMixerHidden = '1';
        }

        // Fallback: hide the specific "Default muted stems" block by content.
        const candidates = pluginSettings.querySelectorAll('section, div, fieldset');
        candidates.forEach((el) => {
            if (el.dataset.stemMixerHidden === '1') return;
            const text = String(el.textContent || '').toLowerCase();
            if (!text) return;
            const hasHeader = text.includes('default muted stems');
            const hasHint = text.includes('new songs start with these stems muted');
            const hasStemNames = (
                text.includes('guitar') &&
                text.includes('bass') &&
                text.includes('drums') &&
                (text.includes('vocal') || text.includes('voice')) &&
                text.includes('piano') &&
                text.includes('other')
            );
            if (hasHeader && (hasHint || hasStemNames)) {
                el.style.display = 'none';
                el.dataset.stemMixerHidden = '1';
            }
        });
    }

    // What to print for a stem: the manifest's `name` when a metadata-bearing
    // source reported one, else the built-in label, else the capitalized id.
    // Own-key lookups throughout: a dynamic id like 'constructor' would
    // otherwise pull inherited values off the label/meta objects.
    function stemDisplayName(stem, meta) {
        const m = (meta && Object.prototype.hasOwnProperty.call(meta, stem)) ? meta[stem] : null;
        if (m && typeof m.name === 'string' && m.name) return m.name;
        return Object.prototype.hasOwnProperty.call(STEM_LABELS, stem)
            ? STEM_LABELS[stem]
            : (stem.charAt(0).toUpperCase() + stem.slice(1));
    }

    function makeSliderRow(stem, current, registry) {
        const row = document.createElement('label');
        row.style.cssText = 'display:grid;grid-template-columns:58px 1fr 42px;gap:10px;align-items:center;';

        const meta = Object.prototype.hasOwnProperty.call(stemMeta, stem) ? stemMeta[stem] : null;
        const name = document.createElement('span');
        name.style.cssText = 'display:flex;align-items:center;min-width:0;';

        const label = document.createElement('span');
        label.textContent = stemDisplayName(stem, stemMeta);
        // Manifest names can outgrow the 58px column — clip, don't wrap the
        // row. flex/min-width let the span actually shrink inside the flex
        // container; without them the ellipsis never engages and long names
        // overflow the column.
        label.style.cssText = 'font-size:11px;color:#b5bfd5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;';
        name.appendChild(label);

        if (meta && meta.description) {
            const info = document.createElement('span');
            info.textContent = 'ⓘ';
            info.title = meta.description;
            info.setAttribute('role', 'img');
            info.setAttribute('aria-label', meta.description);
            info.style.cssText = 'margin-left:4px;flex:none;font-size:10px;color:#8b95aa;cursor:help;';
            name.appendChild(info);
        }

        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.value = String(Math.round(current * 100));
        input.style.cssText = 'width:100%;accent-color:#6ea8ff;';

        const pct = document.createElement('span');
        pct.textContent = `${input.value}%`;
        pct.style.cssText = 'font-size:10px;color:#8b95aa;text-align:right;';

        input.addEventListener('input', () => {
            const level = parseInt(input.value, 10) / 100;
            pct.textContent = `${input.value}%`;
            previewStemVolume(stem, level);
        });
        input._pctTag = pct;
        (registry || stemInputs)[stem] = input;

        row.appendChild(name);
        row.appendChild(input);
        row.appendChild(pct);
        return row;
    }

    // (Re)build one slider host from the current song's stem list. Cheap to call
    // from every UI sweep: the rendered list is stashed on the host and an
    // unchanged list is a single string compare, no DOM work.
    function renderStemRowsInto(host, registry) {
        const list = displayStems();
        // Metadata is part of the render key: a name/description arriving for
        // an unchanged id list must still rebuild the rows.
        const key = JSON.stringify([list, list.map(s => (Object.prototype.hasOwnProperty.call(stemMeta, s) ? stemMeta[s] : null))]);
        if (host.dataset.stemMixerRows === key) return;
        host.dataset.stemMixerRows = key;

        Object.keys(registry).forEach((k) => { delete registry[k]; });
        host.innerHTML = '';

        if (list.length === 0) {
            const msg = document.createElement('div');
            msg.textContent = 'No stems available for this song.';
            msg.style.cssText = 'font-size:11px;line-height:1.35;color:#8b95aa;padding:6px 0;';
            host.appendChild(msg);
            return;
        }

        const state = getCurrentState();
        list.forEach((stem) => {
            const current = levelFor(state.levels, stem);
            host.appendChild(makeSliderRow(stem, current, registry));
        });
    }

    function renderStemRows() {
        const panelHost = panelEl('stem-mixer-rows');
        if (panelHost) renderStemRowsInto(panelHost, stemInputs);
        const pluginHost = document.getElementById('stem-mixer-plugin-stem-rows');
        if (pluginHost) renderStemRowsInto(pluginHost, pluginStemInputs);
    }

    function makeEqBand(idx, freq, current) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:5px;width:28px;';

        const input = document.createElement('input');
        input.type = 'range';
        input.min = '-12';
        input.max = '12';
        input.step = '1';
        input.value = String(Math.round(current));
        input.style.cssText = 'width:100px;transform:rotate(-90deg);accent-color:#6ea8ff;';
        input.addEventListener('input', () => {
            const db = parseInt(input.value, 10);
            setEqBand(idx, db);
        });
        eqInputs[idx] = input;

        const label = document.createElement('span');
        label.textContent = freq >= 1000 ? `${Math.round(freq / 1000)}k` : String(freq);
        label.style.cssText = 'font-size:9px;color:#b5bfd5;';

        wrap.appendChild(input);
        wrap.appendChild(label);
        return wrap;
    }

    function ensurePluginScreenControls() {
        const stemRowsHost = document.getElementById('stem-mixer-plugin-stem-rows');
        const rowsHost = document.getElementById('stem-mixer-plugin-eq-rows');
        if (!rowsHost || !stemRowsHost) return;
        const state = getCurrentState();

        // Stem slider rows are per-song and rendered by renderStemRows() from the
        // UI sweep — only the one-shot EQ/controls build lives behind this gate.
        if (rowsHost.dataset.stemMixerBuilt !== '1') {
            EQ_BANDS.forEach((freq, idx) => {
                const band = document.createElement('div');
                band.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;min-width:28px;';

                const top = document.createElement('span');
                top.textContent = '+12';
                top.style.cssText = 'font-size:9px;color:#7f8aa3;line-height:1;';

                const sliderBox = document.createElement('div');
                sliderBox.style.cssText = 'width:18px;height:120px;display:flex;align-items:center;justify-content:center;';

                const input = document.createElement('input');
                input.type = 'range';
                input.min = '-12';
                input.max = '12';
                input.step = '1';
                input.value = String(Math.round(state.eq[idx] || 0));
                input.style.cssText = 'width:120px;height:16px;transform:rotate(-90deg);transform-origin:center;accent-color:#6ea8ff;';
                input.addEventListener('input', () => {
                    const db = parseInt(input.value, 10);
                    setEqBand(idx, db);
                });
                pluginEqInputs[idx] = input;

                const mid = document.createElement('span');
                mid.textContent = '0';
                mid.style.cssText = 'font-size:9px;color:#d1d9ea;line-height:1;';
                input._valueTag = mid;

                const bot = document.createElement('span');
                bot.textContent = '-12';
                bot.style.cssText = 'font-size:9px;color:#7f8aa3;line-height:1;';

                const label = document.createElement('span');
                label.textContent = freq >= 1000 ? `${Math.round(freq / 1000)}k` : String(freq);
                label.style.cssText = 'font-size:9px;color:#b5bfd5;';

                band.appendChild(top);
                sliderBox.appendChild(input);
                band.appendChild(sliderBox);
                band.appendChild(mid);
                band.appendChild(bot);
                band.appendChild(label);
                rowsHost.appendChild(band);
            });

            pluginAutolevelButton = document.getElementById('stem-mixer-plugin-autolevel');
            if (pluginAutolevelButton) {
                pluginAutolevelButton.addEventListener('click', () => {
                    const curr = getCurrentState().autolevel;
                    setAutolevelEnabled(!curr);
                });
            }

            const flatBtn = document.getElementById('stem-mixer-plugin-flat-eq');
            if (flatBtn) {
                flatBtn.addEventListener('click', () => {
                    EQ_BANDS.forEach((_, idx) => setEqBand(idx, 0));
                    applyStoredState();
                });
            }

            pluginProfileSelect = document.getElementById('stem-mixer-plugin-profile-select');
            if (pluginProfileSelect) {
                pluginProfileSelect.addEventListener('change', () => {
                    applyProfile(pluginProfileSelect.value);
                });
            }
            const saveBtn = document.getElementById('stem-mixer-plugin-profile-save');
            if (saveBtn) saveBtn.addEventListener('click', saveCurrentAsProfile);
            const updateBtn = document.getElementById('stem-mixer-plugin-profile-update');
            if (updateBtn) updateBtn.addEventListener('click', updateSelectedProfile);
            const deleteBtn = document.getElementById('stem-mixer-plugin-profile-delete');
            if (deleteBtn) deleteBtn.addEventListener('click', deleteSelectedProfile);

            rowsHost.dataset.stemMixerBuilt = '1';
        }

        refreshProfilesSelect();
        updateAutolevelButtonState(!!state.autolevel);
    }

    function captureCurrentProfileState() {
        const state = getCurrentState();
        return sanitizeState({
            levels: state.levels,
            eq: state.eq,
            autolevel: state.autolevel,
            selectedProfile: state.selectedProfile
        });
    }

    function refreshProfilesSelect() {
        const targets = [profileSelect, pluginProfileSelect].filter(Boolean);
        if (!targets.length) return;
        const profiles = loadProfiles();
        const state = getCurrentState();

        const allNames = [DEFAULT_PROFILE].concat(
            Object.keys(profiles)
                .filter(name => name !== DEFAULT_PROFILE)
                .sort((a, b) => a.localeCompare(b))
        );
        targets.forEach((sel) => {
            sel.innerHTML = '';
            allNames.forEach((name) => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                sel.appendChild(opt);
            });
            sel.value = allNames.includes(state.selectedProfile) ? state.selectedProfile : DEFAULT_PROFILE;
        });
    }

    function saveCurrentAsProfile() {
        const currentName = (
            (pluginProfileSelect && pluginProfileSelect.value) ||
            (profileSelect && profileSelect.value) ||
            DEFAULT_PROFILE
        );
        const name = (window.prompt('Profile name:', currentName) || '').trim();
        if (!name) return;
        const profiles = loadProfiles();
        const snap = captureCurrentProfileState();
        snap.selectedProfile = name;
        profiles[name] = snap;
        saveProfiles(profiles);

        const state = getCurrentState();
        state.selectedProfile = name;
        saveState(state);
        refreshProfilesSelect();
    }

    function applyProfile(name) {
        if (!name) return;
        const profiles = loadProfiles();
        const next = name === DEFAULT_PROFILE
            ? cloneState(DEFAULT_STATE)
            : (profiles[name] ? sanitizeState(profiles[name]) : null);
        if (!next) return;
        next.selectedProfile = name;
        saveState(next);
        applyStoredState();
    }

    function deleteSelectedProfile() {
        const selected = (
            (pluginProfileSelect && pluginProfileSelect.value) ||
            (profileSelect && profileSelect.value) ||
            ''
        );
        if (!selected || selected === DEFAULT_PROFILE) return;
        if (!window.confirm(`Delete profile "${selected}"?`)) return;
        const profiles = loadProfiles();
        delete profiles[selected];
        saveProfiles(profiles);
        const state = getCurrentState();
        state.selectedProfile = DEFAULT_PROFILE;
        saveState(state);
        refreshProfilesSelect();
        applyProfile(DEFAULT_PROFILE);
    }

    function updateSelectedProfile() {
        const selected = (
            (pluginProfileSelect && pluginProfileSelect.value) ||
            (profileSelect && profileSelect.value) ||
            ''
        );
        if (!selected || selected === DEFAULT_PROFILE) return;
        const profiles = loadProfiles();
        const snap = captureCurrentProfileState();
        snap.selectedProfile = selected;
        profiles[selected] = snap;
        saveProfiles(profiles);
    }

    // True when the pane system currently owns our panel — i.e. it has been moved
    // into a pop-out window (or is mid-move). The element is alive and well; it is
    // just not in this document, so `isConnected` lies about it.
    function paneOwnsPanel() {
        const panes = window.feedBack && window.feedBack.panes;
        return !!(panes && typeof panes.isOpen === 'function' && panes.isOpen(PLUGIN_ID));
    }

    function ensureMixerPanel() {
        // A panel carrying our id that ISN'T ours is a zombie — from a previous
        // instance, or a rebuild that left its predecessor behind. It still has a ✕
        // and sliders wired to a closure that owns nothing, so leaving it on screen is
        // worse than useless: the user clicks it and nothing happens.
        document.querySelectorAll('#stem-mixer-panel').forEach((n) => {
            if (n !== mixerPanel) { try { n.remove(); } catch (e) { /* ignore */ } }
        });

        // NEVER REBUILD THE PANEL WHILE THE PANE OWNS IT.
        //
        // `isConnected` is not a safe test once this panel can be a pane. The host
        // takes the element out of this document to move it into a pop-out window —
        // and detaches it the moment the pop-out starts, before the new window has
        // even loaded. In that gap `mixerPanel.isConnected` is false.
        //
        // If a UI sweep lands there, this function used to conclude its panel was
        // gone and build a SECOND one. The host then still holds the original, and
        // docking brings it home alongside the impostor: two panels, the visible one
        // owned by nobody, and a ✕ that closes the other. That is precisely the "the
        // X doesn't work" bug, and it reproduced exactly on pop-out → dock.
        //
        // The pane system knows the truth, so ask it: if the pane is open, the
        // element is fine — it is simply somewhere else.
        if (mixerPanel && (mixerPanel.isConnected || paneOwnsPanel())) return mixerPanel;

        profileSelect = null;

        mixerPanel = document.createElement('div');
        mixerPanel.id = 'stem-mixer-panel';
        mixerPanel.style.cssText = [
            'position:fixed',
            'bottom:76px',
            'right:18px',
            'z-index:220',
            'width:320px',
            'background:linear-gradient(180deg,rgba(12,19,37,0.97),rgba(8,12,24,0.96))',
            'border:1px solid #334155',
            'border-radius:14px',
            'padding:14px',
            'backdrop-filter:blur(6px)',
            'box-shadow:0 12px 38px rgba(0,0,0,0.52)',
            'max-height:70vh',
            'overflow:auto'
        ].join(';');
        // Hide with `hidden`, NOT an inline `display:none`. While the panel is
        // popped out, the pane host neutralises its placement with .fb-paned and
        // forces it visible; when it docks back and that class is removed, an
        // inline display:none would reassert itself and the panel would return
        // invisible. `hidden` composes cleanly instead.
        //
        // (The pane contract lives in the host repo, got-feedback/feedBack:
        // docs/plugin-panes.md — not in this one.)
        mixerPanel.hidden = true;

        // The title row doubles as the pane header: the host's pop-out chip is
        // appended here (it right-aligns itself with margin-left:auto, hence the
        // flex). data-pane-header is the hook attachChip() looks for.
        const title = document.createElement('div');
        title.setAttribute('data-pane-header', '');
        title.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;letter-spacing:0.02em;color:#eaf0ff;margin-bottom:12px;';
        const titleText = document.createElement('span');
        titleText.textContent = 'Stem Mixer';
        // Push the buttons to the right edge, whatever ends up in the row.
        titleText.style.cssText = 'flex:1 1 auto;';
        title.appendChild(titleText);

        // A close button, in the panel itself.
        //
        // The panel used to be closed only by clicking the "Stem Mixer" button in the
        // player controls again — which was liveable when the panel was an anonymous
        // overlay, and is not now that it has a titled header with a pop-out chip in
        // it. It reads as a window, so it needs the thing a window has. Hunting for
        // the button that opened it is not an affordance.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        closeBtn.setAttribute('aria-label', 'Close stem mixer');
        closeBtn.style.cssText = 'flex:0 0 auto;width:22px;height:22px;display:inline-flex;align-items:center;'
            + 'justify-content:center;border:0;border-radius:6px;background:transparent;color:#8b95aa;'
            + 'font-size:12px;line-height:1;cursor:pointer;order:2;';   // order:2 → the chip sits to its left
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#1e293b'; closeBtn.style.color = '#eaf0ff'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = '#8b95aa'; });
        closeBtn.addEventListener('click', () => {
            // If the panel is popped out, this element is inside the pane window.
            // Just hiding it would leave the user staring at an empty window, so bring
            // it home first — then close it, which is what they asked for.
            const panes = window.feedBack && window.feedBack.panes;
            if (panes && typeof panes.isOpen === 'function' && panes.isOpen(PLUGIN_ID)) {
                panes.close(PLUGIN_ID);
            }
            closeMixer();
        });
        title.appendChild(closeBtn);

        mixerPanel.appendChild(title);
        // The chip attaches HERE, so it lands left of the ✕ — the same order the pane
        // dock and every other panel put them in.
        mixerPanelHeader = title;

        const state = getCurrentState();

        // Slider rows are per-song; renderStemRows() (re)fills this container.
        const rowsWrap = document.createElement('div');
        rowsWrap.id = 'stem-mixer-rows';
        rowsWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
        mixerPanel.appendChild(rowsWrap);

        if (SHOW_EQ_UI) {
            const eqTitle = document.createElement('div');
            eqTitle.id = 'stem-mixer-eq-section';
            eqTitle.textContent = 'Graphic EQ';
            eqTitle.style.cssText = 'margin-top:12px;margin-bottom:8px;font-size:11px;color:#b5bfd5;';
            mixerPanel.appendChild(eqTitle);

            const eqWrap = document.createElement('div');
            eqWrap.id = 'stem-mixer-eq-wrap';
            eqWrap.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;gap:4px;margin:0 2px 10px;';
            EQ_BANDS.forEach((freq, idx) => {
                eqWrap.appendChild(makeEqBand(idx, freq, state.eq[idx] || 0));
            });
            mixerPanel.appendChild(eqWrap);

            const actionRow = document.createElement('div');
            actionRow.id = 'stem-mixer-eq-actions';
            actionRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:4px;';

            autolevelButton = document.createElement('button');
            autolevelButton.type = 'button';
            autolevelButton.className = 'px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-300 transition';
            autolevelButton.textContent = 'Output autolevel';
            autolevelButton.addEventListener('click', () => {
                const curr = getCurrentState().autolevel;
                setAutolevelEnabled(!curr);
            });
            actionRow.appendChild(autolevelButton);

            const flatEqBtn = document.createElement('button');
            flatEqBtn.type = 'button';
            flatEqBtn.textContent = 'Flat EQ';
            flatEqBtn.style.cssText = 'padding:5px 9px;background:#334155;border-radius:7px;color:#dbe7ff;font-size:10px;';
            flatEqBtn.addEventListener('click', () => {
                EQ_BANDS.forEach((_, idx) => setEqBand(idx, 0));
                applyStoredState();
            });
            actionRow.appendChild(flatEqBtn);
            mixerPanel.appendChild(actionRow);
        }

        const hint = document.createElement('div');
        hint.id = 'stem-mixer-hint';
        hint.textContent = 'Profiles are global and apply to all songs/sloppaks.';
        hint.style.cssText = 'margin-top:10px;font-size:10px;line-height:1.35;color:#7f8aa3;';
        mixerPanel.appendChild(hint);

        document.body.appendChild(mixerPanel);
        // Fill the rows now: the panel is built lazily on first click, which can
        // land between UI sweeps.
        renderStemRows();
        syncUiForCompatibilityMode();
        applyStateToUi(state);
        setAutolevelEnabled(state.autolevel, true);
        return mixerPanel;
    }

    function ensureMixerButton() {
        // Prefer the v3 host slot for plugin player controls. The v3 player wraps
        // its transport, so #player-controls' "close" button is a NESTED
        // descendant — controls.insertBefore(btn, closeBtn) then throws
        // "node before which ... is not a child of this node" and the button
        // never mounts. Use the slot when present; fall back to the v2 player.
        const slot = (window.slopsmith && window.slopsmith.ui &&
            typeof window.slopsmith.ui.playerControlSlot === 'function')
            ? window.slopsmith.ui.playerControlSlot() : null;
        const controls = slot || document.getElementById('player-controls');
        if (!controls) return;
        if (mixerButton && mixerButton.isConnected) return;

        const btn = document.createElement('button');
        btn.id = 'btn-stem-mixer';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
        btn.textContent = 'Stem Mixer';
        btn.title = 'Open stem mixer';
        btn.addEventListener('click', () => {
            const ctx = ensureAudioContext();
            if (ctx && ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
            }
            const panel = ensureMixerPanel();
            const open = !panel.hidden;
            panel.hidden = open;
            btn.className = open
                ? 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition'
                : 'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-200 transition';
        });

        if (slot) {
            slot.appendChild(btn);
        } else {
            // Legacy v2 player: only insertBefore a genuine DIRECT child, else append.
            const closeBtn = controls.querySelector(':scope > button:last-child');
            if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(btn, closeBtn);
            else controls.appendChild(btn);
        }

        mixerButton = btn;
    }

    function closeMixer() {
        if (!mixerPanel) return;
        mixerPanel.hidden = true;
        if (mixerButton) {
            mixerButton.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
        }
    }

    function onUiUpdate() {
        ensureHideStemsUiStyles();
        ensurePluginScreenControls();
        ensureMixerButton();
        ensureMixerPanel();
        // Both are one-shot and guarded, so riding the existing sweep costs a
        // boolean check per pass and needs no new lifecycle of its own. The chip
        // in particular must wait for the panel to exist before it has anything
        // to attach to.
        registerPane();
        renderStemRows();
        syncUiForCompatibilityMode();
        hideDefaultStemButtons();
        hideStemsSettingsOptions();
        applyStoredState();
        // Discard mutation records produced by our own DOM writes above so the
        // observer callback never re-queues an update we just caused.
        if (obs) obs.takeRecords();
    }

    function queueUiUpdate() {
        if (uiUpdateTimer) return;
        // Trailing-edge with a max cadence: under a continuous mutation stream
        // the old clear+reset debounce fired steadily every ~80 ms. Fire fast
        // when idle, but never more than ~2x/second while the DOM is churning.
        const since = Date.now() - lastUiUpdateAt;
        const delay = Math.max(80, 500 - since);
        uiUpdateTimer = setTimeout(() => {
            uiUpdateTimer = null;
            lastUiUpdateAt = Date.now();
            onUiUpdate();
        }, delay);
    }

    function isRelevantUiMutation(mutations) {
        for (let i = 0; i < mutations.length; i += 1) {
            const m = mutations[i];
            const target = m && m.target;
            if (!target || target.nodeType !== 1) continue;
            const el = target;
            if (
                el.id === 'player' ||
                el.id === 'player-controls' ||
                el.id === 'highway' ||
                el.tagName === 'AUDIO' ||
                el.closest('#player') ||
                el.closest('#player-controls')
            ) {
                return true;
            }
            if (m.addedNodes && m.addedNodes.length) {
                for (let j = 0; j < m.addedNodes.length; j += 1) {
                    const n = m.addedNodes[j];
                    if (!n || n.nodeType !== 1) continue;
                    const nodeEl = n;
                    if (
                        nodeEl.id === 'player' ||
                        nodeEl.id === 'player-controls' ||
                        nodeEl.tagName === 'AUDIO' ||
                        nodeEl.querySelector && (
                            nodeEl.querySelector('#player, #player-controls, audio') ||
                            nodeEl.closest && (nodeEl.closest('#player') || nodeEl.closest('#player-controls'))
                        )
                    ) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function mutationsTouchAudio(mutations) {
        for (let i = 0; i < mutations.length; i += 1) {
            const m = mutations[i];
            const lists = [m.addedNodes, m.removedNodes];
            for (let k = 0; k < 2; k += 1) {
                const nodes = lists[k];
                if (!nodes || !nodes.length) continue;
                for (let j = 0; j < nodes.length; j += 1) {
                    const n = nodes[j];
                    if (!n || n.nodeType !== 1) continue;
                    if (n.tagName === 'AUDIO') return true;
                    if (n.firstElementChild && n.querySelector('audio')) return true;
                }
            }
        }
        return false;
    }

    // True when everything onUiUpdate() would (re)build already exists — the
    // common steady state during playback. Checked BEFORE the per-record
    // relevance walk so the callback is a few property reads on the ~60/s
    // player-DOM churn instead of closest() walks + a queued update pass.
    function uiAlreadyMounted() {
        if (!mixerButton || !mixerButton.isConnected) return false;
        // Same trap as ensureMixerPanel: a popped-out panel is not in this document,
        // and isConnected would call that "unmounted" — driving a full sweep on every
        // player-DOM mutation for as long as the pane is open.
        if (!mixerPanel || !(mixerPanel.isConnected || paneOwnsPanel())) return false;
        const rowsHost = document.getElementById('stem-mixer-plugin-eq-rows');
        if (rowsHost && rowsHost.dataset.stemMixerBuilt !== '1') return false;
        return true;
    }

    // ── Detachable pane ──────────────────────────────────────────────────────
    // The panel is a fixed overlay pinned over the player (z-index 220): in the way
    // when you want to see the highway, gone when you want the faders. Register it
    // as a pane and it becomes a window you can leave open — across song switches,
    // on a second monitor, minimized to the tray.
    //
    // The host MOVES THIS ELEMENT into the pane window. Not a copy of it, not a
    // reimplementation — this node, with its listeners and its closures intact. So
    // the faders in the popped-out window are these faders, calling setStemVolume()
    // exactly as they do now. Nothing about the mixer needs to know it moved.
    //
    // Core owns the chip, the hiding and the "bring it back" stub. Nothing here
    // runs on an older host: no panes API, no chip, and the panel behaves as before.
    function registerPane() {
        const panes = window.feedBack && window.feedBack.panes;
        // Both calls are guarded, not just the first: an older or partial host could
        // expose register() without attachChip(), and an unguarded call there would
        // throw straight through this function and take the rest of the UI sweep
        // (fader sync, compat mode, the observer) with it.
        if (!panes || typeof panes.register !== 'function' || typeof panes.attachChip !== 'function') return;
        if (!mixerPanel || !mixerPanel.isConnected) return;

        // REGISTER ONCE. The spec resolves the element lazily, so it keeps working
        // across rebuilds without re-registering.
        if (!paneRegistered) {
            panes.register({
                id: PLUGIN_ID,
                title: 'Stem Mixer',
                icon: '🎚',
                // Resolved when the pane opens, not now: ensureMixerPanel() rebuilds
                // the panel if it is ever detached, and the host must always get the
                // live one.
                element: () => mixerPanel,
                width: 320,
                height: 340,
            });
            // Latch only AFTER register() succeeds — it throws on a bad spec, and a
            // flag set up front would latch on the failure and skip every retry.
            paneRegistered = true;
        }

        // RE-ATTACH THE CHIP PER PANEL. The registration survives a rebuild; the chip
        // does not — it lives *inside* the panel, so ensureMixerPanel() building a
        // fresh node leaves the chip on the old, discarded one. Guarding both behind
        // a single "registered" flag would mean the pop-out button silently
        // disappears the first time the panel is rebuilt, with the pane still
        // registered and no way for the user to reach it.
        if (chipPanel !== mixerPanel) {
            if (chipDetach) { try { chipDetach(); } catch (e) { /* already gone */ } }
            chipDetach = panes.attachChip(mixerPanel, PLUGIN_ID, { header: mixerPanelHeader || undefined });
            chipPanel = mixerPanel;
        }
    }

    function setupObservers() {
        if (obs) return;
        obs = new MutationObserver((mutations) => {
            if (mutationsTouchAudio(mutations)) {
                // Audio topology changed — every cached mapping AND the
                // applied-levels set are stale (audio elements that mount after
                // a prior applyStoredState() must still receive their volumes,
                // so appliedLevels must be cleared too, not just the maps).
                invalidateAudioCaches();
                // …and then RE-PUSH them. Falling through to the relevance gate
                // below used to drop the levels on the floor: stem <audio>
                // elements do not live under #player, so isRelevantUiMutation()
                // is false for precisely the mutation that just invalidated
                // everything. The caches were cleared and nothing ever refilled
                // them, so a new song played at full volume on every stem.
                queueUiUpdate();
                return;
            }
            if (uiAlreadyMounted()) return;
            if (!isRelevantUiMutation(mutations)) return;
            queueUiUpdate();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // Node-only export hook for tests; browsers fall through to DOM wiring.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            STEM_KEYS, EQ_BANDS, DEFAULT_STATE, STEM_ALIASES,
            sanitizeState, cloneState, canonicalStemId, safeDecodeUrl, stemIdFromUrl,
            loadState, saveState, getCurrentState, loadProfiles, saveProfiles,
            normalizeAvailableStems, levelFor,
            extractStemMeta, stemDisplayName, sameStemSet, STEM_LABELS,
        };
        return;
    }

    // The stems plugin announces each song's stem list the moment it knows it
    // (plugins/stems/src/main.js, emitStemsState): stem-less songs get
    // { event: 'provider-ready', stemCount: 0 }, stemmed songs get stemIds.
    // This is the authoritative, instant availability source; the bootstrap
    // poll below stays as the fallback for hosts without the stems plugin.
    onStemsStateEvent = (e) => {
        const d = e && e.detail;
        if (!d || d.event !== 'provider-ready') return;
        // `stems` rows carry the manifest's optional name/description
        // (feedpak §5.3) alongside ids; `stemIds` is the older plain-id shape.
        if (Array.isArray(d.stems) && d.stems.length) setAvailableStems(d.stems);
        else if (Array.isArray(d.stemIds)) setAvailableStems(d.stemIds);
        else if (Number(d.stemCount) === 0) setAvailableStems([]);
    };
    window.addEventListener('stems:state', onStemsStateEvent);
    // A drag's write-behind save is only ~250 ms behind, but a close/refresh
    // inside that window must not lose the final slider value.
    window.addEventListener('pagehide', flushPending);

    const originalPlaySong = window.playSong;
    if (typeof originalPlaySong === 'function') {
        window.playSong = async function (...args) {
            // Reset BEFORE the await: the stems plugin can announce the new
            // song's stems (provider-ready) while playSong is still in flight,
            // and resetting afterwards would erase that fresh answer. Kill the
            // previous song's bootstrap timers with it — a leftover tick firing
            // during the await would report the OLD song's stems (or its 12s
            // timeout would flip the new song to "no stems").
            clearStemBootstrapTimers();
            availableStems = null;
            stemMeta = Object.create(null);
            const result = await originalPlaySong.apply(this, args);
            // New song: audio elements and stems-plugin gain nodes are
            // recreated, so every cached mapping and pushed level is stale.
            invalidateAudioCaches();
            setTimeout(queueUiUpdate, 50);
            scheduleStemVolumeBootstrapSync();
            return result;
        };
    }

    // Re-apply on the song's own signal, not on a stopwatch.
    //
    // playSong() resolves as soon as the highway WebSocket is opened — the stem
    // audio for the new song does not exist yet. The bootstrap ladder above
    // guesses at when it will (120…1800 ms), and for a sloppak that has to be
    // extracted, or when the stems plugin rebuilds its graph, that guess expires
    // into an empty room: the levels are pushed at stems that aren't there, and
    // the new song plays every stem at full volume.
    //
    // `song:ready` fires when the chart is fully streamed — and, unlike the
    // playSong wrapper, it fires on ARRANGEMENT switches too, which recreate the
    // audio just the same. Invalidating and re-pushing here means the levels land
    // whenever the audio actually shows up, however long that takes. The ladder
    // stays as a belt-and-braces for hosts that predate the event.
    const bus = window.feedBack;
    if (bus && typeof bus.on === 'function') {
        bus.on('song:ready', () => {
            invalidateAudioCaches();
            queueUiUpdate();
            scheduleStemVolumeBootstrapSync();
        });
    }

    const originalShowScreen = window.showScreen;
    if (typeof originalShowScreen === 'function') {
        window.showScreen = function (...args) {
            const result = originalShowScreen.apply(this, args);
            const next = args[0];
            if (next !== 'player') closeMixer();
            // Screen changes are when new mount points (plugin screen hosts,
            // settings panels) appear — sweep once here instead of relying on
            // the mutation observer to catch every screen's DOM.
            setTimeout(queueUiUpdate, 50);
            return result;
        };
    }

    // The handle a re-injection of this script uses to remove THIS instance.
    // Everything that outlives a function call belongs in here.
    window.__stemMixerInstance = {
        destroy() {
            try { if (obs) { obs.disconnect(); obs = null; } } catch (e) { /* ignore */ }
            if (onStemsStateEvent) {
                try { window.removeEventListener('stems:state', onStemsStateEvent); } catch (e) { /* ignore */ }
                onStemsStateEvent = null;
            }
            try { clearStemBootstrapTimers(); } catch (e) { /* ignore */ }
            // Land any staged drag state before this instance dies — the
            // replacement instance reads localStorage on boot.
            try { flushPending(); } catch (e) { /* ignore */ }
            try { window.removeEventListener('pagehide', flushPending); } catch (e) { /* ignore */ }
            clearTimeout(uiUpdateTimer);
            if (autolevelTimer) { clearInterval(autolevelTimer); autolevelTimer = null; }

            // Hand the pane back BEFORE the element it points at disappears. The host
            // resolves `element: () => mixerPanel` lazily, so a registration left
            // behind would hand it a node belonging to a dead instance.
            try { if (chipDetach) chipDetach(); } catch (e) { /* ignore */ }
            chipDetach = null;
            chipPanel = null;
            const panes = window.feedBack && window.feedBack.panes;
            if (panes && typeof panes.unregister === 'function') {
                try { panes.unregister(PLUGIN_ID); } catch (e) { /* ignore */ }
            }

            if (mixerButton) { try { mixerButton.remove(); } catch (e) { /* ignore */ } }
            // Remove EVERY panel with our id, not just our own reference: if an earlier
            // run already leaked one, this is where it finally goes.
            document.querySelectorAll('#stem-mixer-panel').forEach((n) => {
                try { n.remove(); } catch (e) { /* ignore */ }
            });

            mixerPanel = null;
            mixerButton = null;
            mixerPanelHeader = null;
            paneRegistered = false;
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            installStemsGraphBridge();
            setupObservers();
            onUiUpdate();
        }, { once: true });
    } else {
        installStemsGraphBridge();
        setupObservers();
        onUiUpdate();
    }
})();
