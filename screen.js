(function () {
    'use strict';

    const PLUGIN_ID = 'stem_mixer';
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
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify(sanitizeState(state)));
        } catch (_) {
            // Ignore storage errors (private mode, quota, etc).
        }
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
        return sanitizeState(loadState());
    }

    function isStemsPluginActive() {
        if (window.stems) return true;
        if (document.getElementById('stems-mixer')) return true;
        const audios = document.querySelectorAll('#player audio, #player-controls audio, audio');
        for (let i = 0; i < audios.length; i += 1) {
            const audio = audios[i];
            const src = safeDecodeUrl(String(audio.currentSrc || audio.src || '')).toLowerCase();
            if (src.includes('/stems/')) return true;
        }
        return false;
    }

    function canonicalStemId(stemId) {
        return STEM_ALIASES[String(stemId || '').toLowerCase()] || String(stemId || '').toLowerCase();
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
        const map = Object.create(null);
        const audios = document.querySelectorAll('#player audio, #player-controls audio, audio');
        const hasToken = (text, token) => {
            if (!text || !token) return false;
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
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

        STEM_KEYS.forEach((stem) => {
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
        const map = getStemAudioMap();
        if (map[canonical]) {
            map[canonical].volume = clamped;
            map[canonical].muted = false;
        }
        ensureStemNodes();
        if (stemNodes[canonical]) {
            stemNodes[canonical].gain.value = clamped;
        }
        setStemVolumeViaStemsApi(canonical, clamped);

        if (!skipSave) {
            const state = getCurrentState();
            state.levels[canonical] = clamped;
            saveState(state);
        }
    }

    function clearStemBootstrapTimers() {
        stemBootstrapTimers.forEach((t) => clearTimeout(t));
        stemBootstrapTimers = [];
    }

    function scheduleStemVolumeBootstrapSync() {
        clearStemBootstrapTimers();
        const delays = [120, 320, 650, 1100, 1800];
        delays.forEach((delay) => {
            const timer = setTimeout(() => {
                const state = getCurrentState();
                STEM_KEYS.forEach((stem) => {
                    setStemVolume(stem, state.levels[stem], true);
                });
            }, delay);
            stemBootstrapTimers.push(timer);
        });
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
        saveState(state);
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
        STEM_KEYS.forEach((stem) => {
            if (stemInputs[stem]) {
                const val = Math.round((state.levels[stem] || 0) * 100);
                stemInputs[stem].value = String(val);
                if (stemInputs[stem]._pctTag) stemInputs[stem]._pctTag.textContent = `${val}%`;
            }
            if (pluginStemInputs[stem]) {
                const val = Math.round((state.levels[stem] || 0) * 100);
                pluginStemInputs[stem].value = String(val);
                if (pluginStemInputs[stem]._pctTag) pluginStemInputs[stem]._pctTag.textContent = `${val}%`;
            }
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
        STEM_KEYS.forEach((stem) => {
            setStemVolume(stem, state.levels[stem], true);
        });
        applyEqToGraph(state.eq);
        setAutolevelEnabled(state.autolevel, true);
        applyStateToUi(state);
    }

    function syncUiForCompatibilityMode() {
        const inCompatMode = isStemsPluginActive();
        const eqSection = document.getElementById('stem-mixer-eq-section');
        const eqWrap = document.getElementById('stem-mixer-eq-wrap');
        const eqActions = document.getElementById('stem-mixer-eq-actions');
        if (eqSection) {
            eqSection.style.display = inCompatMode ? 'none' : '';
        }
        if (eqWrap) {
            eqWrap.style.display = inCompatMode ? 'none' : '';
        }
        if (eqActions) {
            eqActions.style.display = inCompatMode ? 'none' : '';
        }
        const hint = document.getElementById('stem-mixer-hint');
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

    function makeSliderRow(stem, current) {
        const row = document.createElement('label');
        row.style.cssText = 'display:grid;grid-template-columns:58px 1fr 42px;gap:10px;align-items:center;';

        const name = document.createElement('span');
        name.textContent = STEM_LABELS[stem];
        name.style.cssText = 'font-size:11px;color:#b5bfd5;';

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
            setStemVolume(stem, level);
        });
        input._pctTag = pct;
        stemInputs[stem] = input;

        row.appendChild(name);
        row.appendChild(input);
        row.appendChild(pct);
        return row;
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

        if (rowsHost.dataset.stemMixerBuilt !== '1') {
            STEM_KEYS.forEach((stem) => {
                const row = document.createElement('label');
                row.style.cssText = 'display:grid;grid-template-columns:58px 1fr 42px;gap:10px;align-items:center;';

                const name = document.createElement('span');
                name.textContent = STEM_LABELS[stem];
                name.style.cssText = 'font-size:11px;color:#b5bfd5;';

                const input = document.createElement('input');
                input.type = 'range';
                input.min = '0';
                input.max = '100';
                input.step = '1';
                input.value = String(Math.round((state.levels[stem] || 0) * 100));
                input.style.cssText = 'width:100%;accent-color:#6ea8ff;';
                input.addEventListener('input', () => {
                    const level = parseInt(input.value, 10) / 100;
                    value.textContent = `${input.value}%`;
                    setStemVolume(stem, level);
                });
                pluginStemInputs[stem] = input;

                const value = document.createElement('span');
                value.textContent = `${input.value}%`;
                value.style.cssText = 'font-size:10px;color:#8b95aa;text-align:right;';
                input._valueTag = value;

                row.appendChild(name);
                row.appendChild(input);
                row.appendChild(value);
                stemRowsHost.appendChild(row);
            });

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

    function ensureMixerPanel() {
        if (mixerPanel && document.body.contains(mixerPanel)) return mixerPanel;
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
            'overflow:auto',
            'display:none'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'Stem Mixer';
        title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.02em;color:#eaf0ff;margin-bottom:12px;';
        mixerPanel.appendChild(title);

        const state = getCurrentState();

        STEM_KEYS.forEach((stem) => {
            const current = state.levels[stem] !== undefined ? Number(state.levels[stem]) : 1;
            mixerPanel.appendChild(makeSliderRow(stem, current));
        });

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
        if (mixerButton && document.body.contains(mixerButton)) return;

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
            const open = panel.style.display !== 'none';
            panel.style.display = open ? 'none' : '';
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
        mixerPanel.style.display = 'none';
        if (mixerButton) {
            mixerButton.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
        }
    }

    function onUiUpdate() {
        ensureHideStemsUiStyles();
        ensurePluginScreenControls();
        ensureMixerButton();
        ensureMixerPanel();
        syncUiForCompatibilityMode();
        hideDefaultStemButtons();
        hideStemsSettingsOptions();
        applyStoredState();
    }

    function queueUiUpdate() {
        if (uiUpdateTimer) clearTimeout(uiUpdateTimer);
        uiUpdateTimer = setTimeout(() => {
            uiUpdateTimer = null;
            onUiUpdate();
        }, 80);
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

    function setupObservers() {
        if (obs) return;
        obs = new MutationObserver((mutations) => {
            if (!isRelevantUiMutation(mutations)) return;
            queueUiUpdate();
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    const originalPlaySong = window.playSong;
    if (typeof originalPlaySong === 'function') {
        window.playSong = async function (...args) {
            const result = await originalPlaySong.apply(this, args);
            setTimeout(queueUiUpdate, 50);
            scheduleStemVolumeBootstrapSync();
            return result;
        };
    }

    const originalShowScreen = window.showScreen;
    if (typeof originalShowScreen === 'function') {
        window.showScreen = function (...args) {
            const result = originalShowScreen.apply(this, args);
            const next = args[0];
            if (next !== 'player') closeMixer();
            return result;
        };
    }

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
