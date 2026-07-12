/*
 * Stem Mixer — the detachable pane.
 *
 * This file is loaded by the HOST, not by screen.js, and it runs in whichever
 * realm the pane is hosted in. Docked, that is the main window. Popped out, it
 * is a different window entirely — with no AudioContext, no <audio> elements, no
 * GainNodes, no `window.stems`, and no access to anything screen.js built.
 *
 * So it owns no audio. It cannot. Every fader here is a message:
 *
 *     ctx.call('audio-mix', 'set-fader-value', …)
 *          → the host's capability bus, in the main window
 *          → the fader screen.js registered (registerAudioMixFaders)
 *          → setStemVolume()
 *          → the real gain node / <audio> / stems plugin
 *
 * That is the whole design. If a slider here ever needs to *know* something about
 * the audio, the answer is a capability call, never a global — a global would
 * work when docked and silently do nothing when popped out, which is the worst
 * possible failure.
 *
 * See feedBack's docs/plugin-panes.md.
 */
(function () {
    'use strict';

    const PLUGIN_ID = 'stem_mixer';
    // Order matters — it is the order the faders appear in. Kept in step with
    // STEM_KEYS in screen.js.
    const STEM_KEYS = ['guitar', 'bass', 'vocals', 'drums', 'piano', 'other'];

    // screen.js registers its faders as `stem_mixer:<stem>`, which the host turns
    // into the participant `fader.stem_mixer:<stem>`. Matching on that prefix is
    // what keeps the host's song fader (and any other plugin's) out of our pane.
    const isOurs = (f) => typeof f.faderId === 'string' && f.faderId.indexOf(PLUGIN_ID + ':') === 0;
    const stemOf = (f) => f.faderId.slice(PLUGIN_ID.length + 1);

    function row(fader, ctx) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:grid;grid-template-columns:58px 1fr 42px;gap:10px;align-items:center;padding:3px 0;';

        const name = document.createElement('span');
        name.textContent = fader.label || fader.faderId;
        name.style.cssText = 'font-size:11px;color:#b5bfd5;';

        let current = Number(fader.currentValue);
        if (!Number.isFinite(current)) current = Number(fader.defaultValue) || 0;

        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(fader.min);
        input.max = String(fader.max);
        input.step = String(fader.step);
        input.value = String(Math.round(current));
        input.style.cssText = 'width:100%;accent-color:#6ea8ff;';
        input.setAttribute('aria-label', name.textContent + ' level');

        const pct = document.createElement('span');
        pct.textContent = `${input.value}%`;
        pct.style.cssText = 'font-size:10px;color:#8b95aa;text-align:right;';

        // A drag fires `input` far faster than the round-trip resolves, and when
        // the pane is a separate window that trip crosses a BroadcastChannel — so
        // replies can land out of order. Only the newest write is allowed to
        // paint, or a stale reply would yank the slider backwards mid-drag.
        let seq = 0;
        input.addEventListener('input', () => {
            const mine = ++seq;
            const value = Number(input.value);
            pct.textContent = `${input.value}%`;   // optimistic: the drag must feel instant
            ctx.call('audio-mix', 'set-fader-value', {
                participantId: fader.participantId,
                faderId: fader.faderId,
                value: value,
            }).then((result) => {
                if (mine !== seq) return;
                const committed = Number(result && result.payload && result.payload.committedValue);
                if (Number.isFinite(committed) && Math.round(committed) !== Math.round(value)) {
                    // The host clamped or refused us. Show what actually happened
                    // rather than the value we asked for.
                    input.value = String(Math.round(committed));
                    pct.textContent = `${input.value}%`;
                }
            }).catch((err) => {
                if (mine !== seq) return;
                console.error('[stem_mixer] pane: set-fader-value failed', err);
                pct.textContent = '—';
            });
        });

        wrap.appendChild(name);
        wrap.appendChild(input);
        wrap.appendChild(pct);
        return wrap;
    }

    function message(root, text) {
        const p = document.createElement('div');
        p.textContent = text;
        p.style.cssText = 'font-size:11px;color:#8b95aa;padding:6px 0;';
        root.appendChild(p);
    }

    window.feedBackPane_stem_mixer = {
        mount(root, ctx) {
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
            root.appendChild(list);

            let renderSeq = 0;
            function render() {
                const mine = ++renderSeq;
                ctx.call('audio-mix', 'list-faders', {}).then((result) => {
                    if (mine !== renderSeq) return;   // a newer render superseded us
                    const all = (result && result.payload && Array.isArray(result.payload.faders))
                        ? result.payload.faders : [];
                    const ours = all.filter(isOurs)
                        .sort((a, b) => STEM_KEYS.indexOf(stemOf(a)) - STEM_KEYS.indexOf(stemOf(b)));

                    list.replaceChildren();
                    if (!ours.length) {
                        // The faders are registered by screen.js in the MAIN window.
                        // If they aren't there, the plugin is disabled or hasn't
                        // finished loading — say so, rather than showing an empty
                        // box the user has to guess about.
                        message(list, 'Stem Mixer is not running in the main window.');
                        return;
                    }
                    ours.forEach((f) => list.appendChild(row(f, ctx)));
                }).catch((err) => {
                    if (mine !== renderSeq) return;
                    console.error('[stem_mixer] pane: list-faders failed', err);
                    list.replaceChildren();
                    message(list, 'The mixer is unavailable.');
                });
            }

            render();
            // A new song rebuilds the stem audio, and a song with no stems has no
            // faders at all — so the list has to be re-read, not assumed.
            ctx.on('song:ready', render);
        },

        unmount(root) {
            // ctx tears down the subscriptions it handed us; we only own our DOM.
            root.replaceChildren();
        },
    };
})();
