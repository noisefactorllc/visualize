/**
 * Visualize — main entry point.
 *
 * Wires together: two Decks, the SharedAudio analyzer, SharedMidi router,
 * BeatScheduler, MainCompositor (with FX), Library, AutoMix, Recorder,
 * and OutputWindow. Also owns keyboard shortcuts and the settings drawer.
 *
 * Boot flow:
 *   1. Render boot overlay; wait for user gesture (required for audio).
 *   2. Initialize both decks (loads shader manifest from CDN).
 *   3. Load library and pre-fill A/B with two random programs.
 *   4. Start compositor + scheduler. Audio/MIDI stay opt-in (settings).
 */

import { Deck, isHeavyDsl } from './noisemaker/deck.js'
import { SharedAudio } from './audio.js'
import { SharedMidi } from './midi.js'
import { BeatScheduler } from './bpm.js'
import { MainCompositor } from './compositor.js'
import { MixerRenderer, MIXERS, DEFAULT_MIXER_ID } from './mixer.js'
import { MixerControls } from './ui/mixerControls.js'
import { Library } from './library.js'
import { AutoMix } from './automix.js'
import { Recorder, formatRecTime } from './recorder.js'
import { OutputWindow } from './output.js'
import { Scenes } from './scenes.js'
import * as rebind from './rebind.js'
import { AutoXfade } from './autoxfade.js'
import { DeckMedia } from './deckMedia.js'
import { mountThemePicker } from './handfish-theme.js'
import { aboutDialog } from './about-dialog.js'
import { setupTooltips, setTooltip, migrateBelow } from './tooltips.js'
import { clearCodeFromUrl } from './sharingLoader.js'
import { getUserEffectsManager } from './userEffects.js'
// Pulls handfish's <code-editor> custom element (auto-registers on import)
// plus the DSL syntax tokenizer.
import { dslTokenizer } from 'handfish'
// Injects the polymorphic/noisedeck editor styles (transparent overlay
// with per-segment darkening + syntax colors) and exports the
// enhanceCodeEditor helper for the Cmd/Ctrl+Shift+Enter binding.
import { enhanceCodeEditor } from './ui/codeEditor.js'

const $ = (id) => document.getElementById(id)

const RENDERER_STORAGE_KEY = 'visualize.renderer.v1'

function loadRendererPrefs() {
    try {
        const raw = localStorage.getItem(RENDERER_STORAGE_KEY)
        const parsed = raw ? JSON.parse(raw) : {}
        return { preferWebGPU: parsed?.preferWebGPU === true }
    } catch {
        return { preferWebGPU: false }
    }
}

function persistRendererPrefs() {
    try {
        localStorage.setItem(RENDERER_STORAGE_KEY, JSON.stringify({
            preferWebGPU: state.preferWebGPU === true
        }))
    } catch {}
}

const state = {
    decks: { A: null, B: null },
    mainRes: { width: 1280, height: 720 },
    loopDuration: 10,
    preferWebGPU: loadRendererPrefs().preferWebGPU,
    crossfade: 0,
    // Per-deck pixel density. `mode='auto'` lets loadProgram choose
    // (drops to 0.5 for compute-heavy DSLs); `mode='manual'` pins to
    // the user's chosen value across loads. `value` is whichever is
    // currently applied to the underlying renderer. Default is a
    // manual 50% pin — playable on modest GPUs out of the box; the
    // operator cycles up via the deck zoom button when they want
    // more pixels.
    deckDensity: {
        A: { mode: 'manual', value: 0.5 },
        B: { mode: 'manual', value: 0.5 }
    },
    // Seconds for the manual auto-fade (X key) AND auto-VJ scene
    // transitions. Read by the auto-fade button and pushed into
    // AutoMix; UI source of truth is #fade-duration in the mixer
    // controls panel.
    fadeDurSec: 3,
    curve: 'dipped'
}

// Cycle order for the deck-density button. AUTO → 100 → 75 → 50 → 25 → AUTO.
const DENSITY_CYCLE = ['auto', 1.0, 0.75, 0.5, 0.25]
function nextDensity(curMode, curValue) {
    if (curMode === 'auto') return { mode: 'manual', value: 1.0 }
    const idx = DENSITY_CYCLE.indexOf(curValue)
    const next = idx === -1 || idx >= DENSITY_CYCLE.length - 1 ? 'auto' : DENSITY_CYCLE[idx + 1]
    return next === 'auto' ? { mode: 'auto', value: 1.0 } : { mode: 'manual', value: next }
}

function toast(msg, timeoutMs = 2200) {
    const el = $('toast')
    if (!el) return
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toast._t)
    toast._t = setTimeout(() => el.classList.remove('show'), timeoutMs)
}

function setStatusPill(id, text, state) {
    const el = $(id)
    if (!el) return
    el.dataset.state = state
    el.querySelector('.status-text').textContent = text
}

/**
 * Resolve the share-loader UI as soon as the composition title arrives.
 *
 * The inline boot script in index.html (a) detects `?code=`, (b) flips
 * the boot card from default → share variant, (c) kicks off the fetch
 * to sharing.noisedeck.app and stashes the promise on window. This
 * function runs in parallel with deck init: it awaits that fetch and
 * either populates the prompt + enables the A/B buttons, or surfaces
 * the failure inline so the user can still click "start set" via a
 * graceful fallback.
 *
 * Returns the composition payload (or null) so post-gesture code can
 * load it into the chosen deck without re-fetching.
 */
async function prepareShareDialog() {
    const code = window.__visualizeShareCode
    const promise = window.__visualizeSharePromise
    if (!code || !promise) return null

    const prompt = $('boot-share-prompt')
    const hint = $('boot-share-hint')
    const btnA = $('boot-share-a')
    const btnB = $('boot-share-b')

    let composition
    try {
        composition = await promise
    } catch (err) {
        if (prompt) prompt.textContent = `couldn't load shared program (${code})`
        if (hint) hint.textContent = String(err.message || err)
        return null
    }

    const title = composition?.title || `code ${code}`

    if (prompt) {
        prompt.innerHTML = ''
        prompt.appendChild(document.createTextNode('Load program '))
        const em = document.createElement('strong')
        em.textContent = `"${title}"`
        prompt.appendChild(em)
        prompt.appendChild(document.createTextNode(' from sharing into which deck?'))
    }
    if (hint) {
        // hasEffects=true means the composition bundles portable custom
        // shaders. Visualize now accepts these via the user-effects
        // manager — call out the install behavior so the operator knows
        // the effects are being persisted, not just transiently loaded.
        if (composition?.hasEffects) {
            const n = composition.effects?.length || 0
            hint.textContent = `bundles ${n} custom effect${n === 1 ? '' : 's'} — they'll be installed into your library`
        } else {
            hint.textContent = 'pick a deck to load it; the other deck gets a random program'
        }
    }
    if (btnA) btnA.disabled = false
    if (btnB) btnB.disabled = false
    return composition
}

async function boot() {
    // Boot overlay stays up while everything below initializes and starts
    // rendering — the user sees the app's first two decks playing
    // (blurred + dimmed by the overlay's backdrop-filter) before they
    // click START SET. The click handler is wired by an inline script in
    // index.html that runs before any module imports; we await its
    // promise at the very end of boot() so a fast click doesn't race the
    // deferred module graph.

    // If the URL carries ?code=, prepareShareDialog races the sharing
    // API fetch in parallel with deck init and populates the boot
    // card's share-loader UI as soon as the title lands. The promise
    // is held so post-gesture code can load the composition without
    // re-fetching.
    const sharePromise = prepareShareDialog()

    // Construct decks
    state.decks.A = new Deck($('deck-a-canvas'), {
        id: 'deckA', width: state.mainRes.width, height: state.mainRes.height,
        loopDuration: state.loopDuration, preferWebGPU: state.preferWebGPU,
        onError: (err) => console.error('[deckA]', err)
    })
    state.decks.B = new Deck($('deck-b-canvas'), {
        id: 'deckB', width: state.mainRes.width, height: state.mainRes.height,
        loopDuration: state.loopDuration, preferWebGPU: state.preferWebGPU,
        onError: (err) => console.error('[deckB]', err)
    })

    toast('initializing shaders…')
    try {
        await Promise.all([state.decks.A.init(), state.decks.B.init()])
    } catch (err) {
        console.error('Deck init failed', err)
        toast('shader engine failed to load — check console')
        return
    }

    // User effects — hydrate from IndexedDB and register with deck A's
    // renderer BEFORE library.load(). The engine's effect registry is a
    // module-level singleton, so registering against one renderer
    // (deck A's) lights up the effects globally for the compiler. We
    // do this before library.load() so user effects participate in the
    // defaultPrograms scan and show up in the library's "user" section.
    const userEffects = getUserEffectsManager()
    try {
        await userEffects.initialize(state.decks.A.inner)
    } catch (err) {
        console.error('User effects init failed', err)
    }

    // Library
    const library = new Library()
    try {
        // Pass deck A's renderer so the library can synthesize the
        // user section from user-namespace effects via getAllEffects().
        await library.load('data/programs.json', { renderer: state.decks.A.inner })
    } catch (err) {
        console.error('Library load failed', err)
        toast('failed to load programs.json')
        return
    }

    // Re-render the library whenever the user installs or deletes an
    // effect, so the "user" section reflects the new state immediately
    // without a reload. We rebuild defaults from the renderer's current
    // effect set, then re-render the grid.
    userEffects.onChange(async () => {
        try {
            await library.reloadDefaults(state.decks.A.inner)
            library.render()
        } catch (err) {
            console.error('library reloadDefaults failed:', err)
        }
    })

    // Mixer (third pipeline) — blends deck A + deck B through any of
    // the noisemaker mixer/* effects. Created here, initialized
    // asynchronously (loads manifest + media effect + default mixer);
    // the compositor falls back to the 2D equal-power crossfade while
    // we wait for compile.
    const mixer = new MixerRenderer({
        width: state.mainRes.width,
        height: state.mainRes.height,
    })
    mixer.bindDecks(state.decks.A.canvas, state.decks.B.canvas)

    // Compositor (main)
    const compositor = new MainCompositor(
        $('main-canvas'),
        state.decks.A,
        state.decks.B,
        { width: state.mainRes.width, height: state.mainRes.height }
    )
    compositor.start()

    // Mirror the crossfader value into a CSS variable that drives the
    // topbar logotype gradient — 0 (deck A live) reads as blue,
    // 1 (deck B live) as red, with the middle landing on yellow when
    // the mixer is dominant. Wrapping setCrossfade rather than hooking
    // each call site means every path (slider input, MIDI, MIDI clock
    // automation, AutoMix, AutoXfade, scenes, keyboard shortcuts)
    // updates the gradient with no further plumbing.
    const _originalSetCrossfade = compositor.setCrossfade.bind(compositor)
    compositor.setCrossfade = (v01) => {
        _originalSetCrossfade(v01)
        const clamped = Math.max(0, Math.min(1, Number(v01) || 0))
        document.documentElement.style.setProperty('--brand-mix', `${clamped * 100}%`)
    }
    // Set the initial position so the gradient doesn't snap on first
    // change — defaults to deck A live (xfade=0) at boot.
    compositor.setCrossfade(state.crossfade)

    // Bring the mixer online in the background — manifest fetch +
    // shader compile takes a beat, and we don't want to block the
    // boot path on it. Once it's up, swap the compositor onto the
    // mixer's output canvas.
    mixer.init()
        .then(() => {
            // Restore last-picked mixer (and overrides) from localStorage
            let stored = null
            try { stored = JSON.parse(localStorage.getItem('visualize.mixer.v1') || 'null') } catch {}
            const id = stored?.id && MIXERS.some(m => m.id === stored.id) ? stored.id : DEFAULT_MIXER_ID
            return mixer.setMixerEffect(id, stored?.overrides || {})
        })
        .then(() => {
            mixer.start()
            compositor.setMixer(mixer)
            wireMixerPicker(mixer)
            wireMixerControls(mixer)
        })
        .catch(err => {
            console.warn('[mixer] init failed; staying on 2D crossfade:', err?.message || err)
        })

    // Audio
    const audio = new SharedAudio()
    audio.addDeck(state.decks.A)
    audio.addDeck(state.decks.B)
    audio.onStatusChange((msg, enabled) => {
        setStatusPill('audio-status', enabled ? `audio: ${audio.currentDeviceLabel.slice(0, 14)}` : 'audio off', enabled ? 'on' : 'off')
        if (msg) toast(msg)
    })
    audio.onMeters((m) => {
        $('meter-low').firstElementChild.style.width = `${m.low * 100}%`
        $('meter-mid').firstElementChild.style.width = `${m.mid * 100}%`
        $('meter-high').firstElementChild.style.width = `${m.high * 100}%`
    })

    // MIDI
    const midi = new SharedMidi()
    midi.addDeck(state.decks.A)
    midi.addDeck(state.decks.B)
    midi.onStatusChange((msg, enabled) => {
        setStatusPill('midi-status', enabled ? `midi: ${midi.inputCount} in` : 'midi off', enabled ? 'on' : 'off')
        $('midi-info').textContent = enabled ? `${midi.inputCount} input(s)` : 'not connected'
        if (msg) toast(msg)
    })

    // Test / debug hook — lets Playwright drive audio + MIDI flows
    // without scraping the DOM. Set as soon as the inputs exist so
    // boot races (initial deck compile, etc.) can't strand the test
    // waiting for a handle. Other entries (scheduler, autoMix, ...)
    // are attached below once they're constructed.
    window.__visualize = { audio, midi, compositor, decks: state.decks, rebind, state, mixer, get autoXfade() { return autoXfade }, get autoMix() { return autoMix } }

    // Cached DOM refs — declared before any callbacks that capture them
    // so we don't risk TDZ if a callback fires between declaration and
    // first use (e.g. compositor frame hook firing during boot).
    const deckEls = {
        A: document.querySelector('.deck.deck-a'),
        B: document.querySelector('.deck.deck-b')
    }
    const xfaderEl = $('crossfader')
    const fpsEl = $('fps-value')
    const bpmInputEl = $('bpm-input')
    const flashOverlayEl = $('main-fx-overlay')

    function updateLiveIndicator() {
        const aLive = state.crossfade < 0.5
        deckEls.A.classList.toggle('live', aLive)
        deckEls.B.classList.toggle('live', !aLive)
    }

    // BPM / scheduler. Divider × BPM drives both decks' base loop
    // duration so animations stay sized to the music without users
    // hand-tuning a "loop duration" number (mirrors polymorphic).
    const scheduler = new BeatScheduler(120)
    scheduler.start()
    // Attach to the test hook now that it exists (built above at boot).
    // Tests drive deterministic tap-tempo via scheduler.tap(timestamp).
    window.__visualize.scheduler = scheduler
    const bpmDividerEl = $('bpm-divider')
    const bpmLabelEl = $('bpm-label')
    const mainLoopDerivedEl = $('main-loop-derived')
    const bpmBlockEl = document.querySelector('.topbar-center')
    if (bpmDividerEl) bpmDividerEl.value = String(scheduler.divider)

    function applyLoopFromBpm() {
        const sec = scheduler.barSeconds()
        state.loopDuration = sec
        state.decks.A.setBaseLoopDuration(sec)
        state.decks.B.setBaseLoopDuration(sec)
        state.decks.A.syncTimeOrigin(scheduler._lastBeatMs)
        state.decks.B.syncTimeOrigin(scheduler._lastBeatMs)
        if (mainLoopDerivedEl) {
            mainLoopDerivedEl.textContent =
                `${sec.toFixed(2)}s — ${scheduler.bpm.toFixed(1)} BPM ÷ ${scheduler.divider} (one bar = ${(60 / scheduler.bpm).toFixed(2)}s)`
        }
    }
    applyLoopFromBpm()
    scheduler.onChange(() => applyLoopFromBpm())
    scheduler.onDividerChange((d) => {
        if (bpmDividerEl && bpmDividerEl.value !== String(d)) bpmDividerEl.value = String(d)
        applyLoopFromBpm()
    })

    midi.onBpm((bpm) => {
        if (!midi.followClock) return
        scheduler.bpm = bpm
        bpmInputEl.value = bpm.toFixed(1)
    })
    // MIDI transport: start/continue resume the scheduler; stop pauses
    // it so beat-driven FX freeze instead of free-running.
    midi.onTransport((kind) => {
        if (!midi.followClock) return
        if (kind === 'start' || kind === 'continue') {
            scheduler.resetPhase()
            if (!scheduler.running) scheduler.start()
        } else if (kind === 'stop') {
            scheduler.stop()
        }
    })
    midi.onClockStatus((status) => {
        // Reflect MIDI-clock status in the bpm label so users can see
        // why the BPM stopped updating without opening DevTools.
        const showStatus = midi.followClock && status !== 'synced'
        if (bpmLabelEl) bpmLabelEl.textContent = showStatus ? `midi: ${status}` : 'BPM'
        if (bpmBlockEl) bpmBlockEl.classList.toggle('midi-sync', midi.followClock && status === 'synced')
    })

    // Auto-mix
    const autoMix = new AutoMix({
        library, decks: state.decks, compositor, scheduler, rebind, audio, midi,
        getXfade: () => state.crossfade,
        setXfade: (v) => {
            state.crossfade = v
            compositor.setCrossfade(v)
            xfaderEl.value = String(v)
            updateLiveIndicator()
        },
        onStatus: (msg) => toast(msg),
        // Refresh deck name/tagline + audio routing whenever AutoMix
        // swaps a program in. Otherwise the topbar label stays stuck on
        // whatever was loaded manually before AutoMix took over.
        onLoad: (deckId, program) => {
            audio.refreshDeckStates()
            const labels = deckLabels[deckId]
            if (labels) {
                labels.name.textContent = program.title
                labels.tag.textContent = program.tagline || ''
            }
            refreshDeckMediaUi(deckId)
        }
    })
    // Drive the AutoMix fade per-frame for smooth interpolation
    // (per-beat would only give ~4 visible steps across a 1-bar fade).
    compositor.onFrame(() => autoMix.tickFrame())

    // ── Auto-Mix (crossfader automation) ─────────────────────────────
    // Mutually exclusive with Auto-VJ — each side calls setEnabled(false)
    // on the other when it turns on.
    const AUTOXFADE_STORAGE_KEY = 'visualize.autoxfade.v1'
    const autoXfade = new AutoXfade({
        scheduler, audio, midi,
        setXfade: (v) => {
            state.crossfade = v
            compositor.setCrossfade(v)
            xfaderEl.value = String(v)
            updateLiveIndicator()
        },
        // Share Auto-VJ's cycle length so the operator picks one
        // "musical cycle" knob (the cycle dropdown) that drives
        // either automation mode.
        getBarsPerCycle: () => autoMix.barsPerScene
    })
    autoXfade.onEnableChange(on => { if (on) autoMix.setEnabled(false) })

    function persistAutoXfade() {
        try {
            localStorage.setItem(
                AUTOXFADE_STORAGE_KEY,
                JSON.stringify(autoXfade.snapshot())
            )
        } catch {}
    }
    function loadAutoXfade() {
        try {
            const raw = localStorage.getItem(AUTOXFADE_STORAGE_KEY)
            if (raw) autoXfade.restore(JSON.parse(raw))
        } catch {}
    }
    loadAutoXfade()

    // Drive autoXfade every frame; honours its own enabled flag.
    compositor.onFrame(() => autoXfade.tick(performance.now()))

    // Recorder
    const recorder = new Recorder($('main-canvas'), {
        onTick: (ms) => { $('record-time').textContent = formatRecTime(ms) },
        onStateChange: (recording) => {
            const btn = $('record-toggle')
            btn.dataset.state = recording ? 'on' : 'off'
            if (!recording) $('record-time').textContent = '0:00'
            toast(recording ? 'recording…' : 'recording saved')
        },
        onWarning: (msg) => toast(msg, 6000)
    })
    if (!Recorder.isSupported()) {
        $('record-toggle').disabled = true
        setTooltip($('record-toggle'), 'MediaRecorder not supported')
    }

    // Output window
    const outputWin = new OutputWindow($('main-canvas'))

    // ── Wire UI ───────────────────────────────────────────────────────────

    // Crossfader
    xfaderEl.addEventListener('input', (e) => {
        state.crossfade = parseFloat(e.target.value)
        compositor.setCrossfade(state.crossfade)
        updateLiveIndicator()
        autoMix.noteUserOverride()
    })
    $('cut-a').addEventListener('click', () => {
        state.crossfade = 0
        compositor.setCrossfade(0)
        xfaderEl.value = '0'
        updateLiveIndicator()
        autoMix.noteUserOverride()
    })
    $('cut-b').addEventListener('click', () => {
        state.crossfade = 1
        compositor.setCrossfade(1)
        xfaderEl.value = '1'
        updateLiveIndicator()
        autoMix.noteUserOverride()
    })
    $('auto-fade').addEventListener('click', () => {
        const target = state.crossfade < 0.5 ? 1 : 0
        animateXfade(target, state.fadeDurSec)
    })

    function animateXfade(target, durSec = state.fadeDurSec) {
        autoMix.noteUserOverride()
        const start = state.crossfade
        const startMs = performance.now()
        const durMs = durSec * 1000
        const step = () => {
            const t = Math.min(1, (performance.now() - startMs) / durMs)
            const eased = 0.5 - 0.5 * Math.cos(t * Math.PI)
            state.crossfade = start + (target - start) * eased
            compositor.setCrossfade(state.crossfade)
            xfaderEl.value = String(state.crossfade)
            updateLiveIndicator()
            if (t < 1) requestAnimationFrame(step)
        }
        step()
    }

    // Speed sliders
    function bindSpeed(deckId, sliderId, valId) {
        const slider = $(sliderId)
        const val = $(valId)
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value)
            state.decks[deckId].setSpeed(v)
            val.textContent = `${v.toFixed(1)}×`
        })
    }
    bindSpeed('A', 'speed-a', 'speed-a-val')
    bindSpeed('B', 'speed-b', 'speed-b-val')

    // Random load per deck
    document.querySelectorAll('.deck-load-random').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.deck
            const exclude = state.decks[id].currentName
            const p = library.randomExcept(exclude)
            if (!p) return
            await loadProgram(id, p)
        })
    })

    // Library mount
    library.mount({
        rootEl: $('library-panel'),
        gridEl: $('library-grid'),
        countEl: $('library-count'),
        searchEl: $('library-search'),
        onLoadToDeck: async (deckId, program) => {
            if (deckId === 'auto') {
                // Load into the deck that's currently "less visible"
                deckId = state.crossfade < 0.5 ? 'B' : 'A'
            }
            await loadProgram(deckId, program)
        },
        onRandomBoth: async () => {
            const a = library.random()
            const b = library.randomExcept(a?.title)
            await Promise.all([loadProgram('A', a), loadProgram('B', b)])
        }
    })
    library.setRandomBothButton($('library-random'))

    // Cache deck label refs — these are touched on every program load
    // and on every Auto-VJ scene swap. Looking them up by id each time
    // shows up in the profiler under heavy auto-VJ use.
    const deckLabels = {
        A: { name: $('deck-a-name'), tag: $('deck-a-tagline') },
        B: { name: $('deck-b-name'), tag: $('deck-b-tagline') }
    }

    async function loadProgram(deckId, program) {
        if (!program) return
        const deck = state.decks[deckId]

        // Pixel density auto-step-down: any DSL that invokes points/* or
        // sim-tagged effects (cellular automata, reaction-diffusion,
        // MNCA, etc.) gets a half-res render buffer so it stays playable
        // alongside the other deck. Honored only in 'auto' mode; manual
        // density choices stick across loads.
        const density = state.deckDensity[deckId]
        if (density.mode === 'auto') {
            const heavy = isHeavyDsl(program.dsl, deck.inner.manifest)
            density.value = heavy ? 0.5 : 1.0
        }
        deck.setPixelDensity(density.value)
        updateDensityButton(deckId)

        const res = await deck.load(program.dsl, program.title)
        if (!res.success) {
            toast(`${deckId}: ${res.error.slice(0, 60)}`)
            return
        }
        // Refresh audio routing in case renderer recreated audioState
        audio.refreshDeckStates()
        const labels = deckLabels[deckId]
        if (labels) {
            labels.name.textContent = program.title
            labels.tag.textContent = program.tagline || ''
        }
        // If the editor is open for this deck, sync its content to the
        // newly loaded program — otherwise the editor would still show
        // the previous program's DSL.
        syncDeckEditor(deckId)
        // Toggle the per-deck media picker row (Camera Input / Media
        // Input show their picker here; other programs hide it).
        refreshDeckMediaUi(deckId)
    }

    function updateDensityButton(deckId) {
        const btn = $(`deck-${deckId.toLowerCase()}-density`)
        if (!btn) return
        const d = state.deckDensity[deckId]
        const label = btn.querySelector('.density-value')
        const pct = `${Math.round(d.value * 100)}%`
        if (d.mode === 'auto') {
            label.textContent = `auto ${pct}`
            btn.dataset.mode = 'auto'
        } else {
            label.textContent = pct
            btn.dataset.mode = 'manual'
        }
    }

    function wireDensityButtons() {
        for (const deckId of ['A', 'B']) {
            const btn = $(`deck-${deckId.toLowerCase()}-density`)
            if (!btn) continue
            btn.addEventListener('click', () => {
                const cur = state.deckDensity[deckId]
                const next = nextDensity(cur.mode, cur.value)
                state.deckDensity[deckId] = next

                // For auto mode, re-classify against the currently
                // loaded DSL; for manual, just apply the chosen value.
                // Use the rebind's pristine original DSL so a
                // mid-roll re-classify doesn't get fooled by the
                // override map (the effect set is the same either way).
                if (next.mode === 'auto') {
                    const dsl = state.decks[deckId].rebind.originalDsl
                        || state.decks[deckId]._currentDsl
                    const heavy = dsl && isHeavyDsl(dsl, state.decks[deckId].inner.manifest)
                    next.value = heavy ? 0.5 : 1.0
                }
                state.decks[deckId].setPixelDensity(next.value)
                updateDensityButton(deckId)
                toast(`Deck ${deckId} pixel density: ${next.mode === 'auto' ? 'auto ' : ''}${Math.round(next.value * 100)}%`, 1400)
            })
            updateDensityButton(deckId)
        }
    }
    wireDensityButtons()

    // ── Rebind (EQ + MIDI) ───────────────────────────────────────────
    // Per-deck operator-triggered reshuffle of audio/MIDI parameter
    // bindings. The rebind module rewrites the deck's currently
    // running DSL via compile()/unparse(), substituting fresh Audio
    // or Midi automations on 2-4 random numeric params. Bandpass on
    // (default) keeps EQ rebind inside the program's tagged bands;
    // off picks any band.
    const REBIND_STORAGE_KEY = 'visualize.rebind.v1'

    function loadRebindUiState() {
        try {
            const raw = localStorage.getItem(REBIND_STORAGE_KEY)
            const parsed = raw ? JSON.parse(raw) : {}
            const pick = (side) => {
                // Forward-compat with older shape: { A: bool, B: bool }
                const e = (parsed[side] && typeof parsed[side] === 'object')
                    ? parsed[side] : { bandpass: parsed[side] }
                return {
                    bandpass: e.bandpass !== false,
                    oscillatorCount: Math.max(0, Math.min(4, e.oscillatorCount | 0))
                }
            }
            return { A: pick('A'), B: pick('B') }
        } catch {
            return {
                A: { bandpass: true, oscillatorCount: 0 },
                B: { bandpass: true, oscillatorCount: 0 }
            }
        }
    }
    function persistRebindUiState() {
        try {
            localStorage.setItem(REBIND_STORAGE_KEY, JSON.stringify({
                A: {
                    bandpass: state.decks.A.rebind.bandpass,
                    oscillatorCount: state.decks.A.rebind.oscillatorCount
                },
                B: {
                    bandpass: state.decks.B.rebind.bandpass,
                    oscillatorCount: state.decks.B.rebind.oscillatorCount
                }
            }))
        } catch {}
    }
    function programForDeck(deckId) {
        const title = state.decks[deckId].currentName
        return library.byTitle(title) || { tags: [] }
    }
    function flashRebindBtn(btn) {
        if (!btn) return
        btn.classList.add('flash')
        setTimeout(() => btn.classList.remove('flash'), 250)
    }
    function updateBandpassBtn(deckId) {
        const btn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
        if (!btn) return
        const on = state.decks[deckId].rebind.bandpass
        btn.classList.toggle('lit', on)
        setTooltip(btn, on
            ? "Bandpass on: EQ rebind stays in this program's bands"
            : 'Bandpass off: EQ rebind picks any band')
    }

    function updateOscCountBtn(deckId) {
        const btn = document.querySelector(`.deck-osc-count[data-deck="${deckId}"]`)
        if (!btn) return
        const n = state.decks[deckId].rebind.oscillatorCount || 0
        const label = btn.querySelector('.osc-value')
        if (label) label.textContent = `×${n}`
        btn.dataset.active = n > 0 ? '1' : '0'
        setTooltip(btn, n === 0
            ? 'Oscillator count for rebind (click to cycle 0–4)'
            : `Rebind uses ${n} oscillator${n === 1 ? '' : 's'} (click to cycle 0–4)`)
    }

    function wireRebindButtons() {
        const persisted = loadRebindUiState()
        for (const deckId of ['A', 'B']) {
            state.decks[deckId].rebind.bandpass = persisted[deckId].bandpass
            state.decks[deckId].rebind.oscillatorCount = persisted[deckId].oscillatorCount
            const eqBtn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
            const midiBtn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
            const bpBtn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
            const oscBtn = document.querySelector(`.deck-osc-count[data-deck="${deckId}"]`)
            if (eqBtn) eqBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindEq(state.decks[deckId], programForDeck(deckId))
                if (ok) {
                    flashRebindBtn(eqBtn)
                    audio.refreshDeckStates()
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (midiBtn) midiBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindMidi(state.decks[deckId])
                if (ok) {
                    flashRebindBtn(midiBtn)
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (bpBtn) bpBtn.addEventListener('click', () => {
                state.decks[deckId].rebind.bandpass = !state.decks[deckId].rebind.bandpass
                updateBandpassBtn(deckId)
                persistRebindUiState()
            })
            if (oscBtn) oscBtn.addEventListener('click', () => {
                const r = state.decks[deckId].rebind
                r.oscillatorCount = ((r.oscillatorCount || 0) + 1) % 5
                updateOscCountBtn(deckId)
                persistRebindUiState()
            })
            updateBandpassBtn(deckId)
            updateOscCountBtn(deckId)
        }
    }
    wireRebindButtons()

    // ── Per-deck media (Camera Input / Media Input util programs) ─────
    // One DeckMedia per deck. The picker UI is shown only when the
    // currently-loaded program contains a synth/media call; the
    // operator selects a camera device or a local file from the deck's
    // own row, and we push it into the renderer's imageTex each frame.
    const deckMedia = {
        A: new DeckMedia({ deck: state.decks.A }),
        B: new DeckMedia({ deck: state.decks.B })
    }
    compositor.onFrame(() => {
        deckMedia.A.tick()
        deckMedia.B.tick()
    })

    function getProgramForDeck(deckId) {
        const title = state.decks[deckId].currentName
        return library.byTitle(title)
    }

    async function refreshDeckMediaUi(deckId) {
        const dm = deckMedia[deckId]
        const wrap = $(`deck-${deckId.toLowerCase()}-media`)
        const cameraSel = $(`deck-${deckId.toLowerCase()}-media-camera`)
        const fileBtn = $(`deck-${deckId.toLowerCase()}-media-file-btn`)
        const labelEl = $(`deck-${deckId.toLowerCase()}-media-label`)
        if (!wrap) return
        const program = getProgramForDeck(deckId)
        const isMedia = dm.isMediaProgram()
        wrap.hidden = !isMedia
        if (!isMedia) {
            dm.stop()
            if (cameraSel) cameraSel.hidden = true
            if (fileBtn) fileBtn.hidden = true
            if (labelEl) labelEl.textContent = ''
            return
        }
        const kind = program?.mediaSource || 'file'
        if (kind === 'camera') {
            if (fileBtn) fileBtn.hidden = true
            if (cameraSel) {
                cameraSel.hidden = false
                const devices = await dm.listCameras()
                // Build the option list. Rules:
                //   1. Placeholder always at index 0 (value="").
                //   2. Every labelled enumerated device gets its own
                //      option keyed by deviceId.
                //   3. If no labelled devices AND no camera is live,
                //      render a "Enable camera" sentinel that prompts
                //      for permission.
                //   4. If a camera IS live, ALWAYS include its label
                //      (under either its real deviceId or an
                //      __active__ pseudo-id when the browser doesn't
                //      report one), so the trigger can stay on the
                //      operator's picked device across refreshes.
                const labelled = devices.filter(d => d.label && d.deviceId)
                const opts = [{ value: '', text: '— pick camera —' }]
                const seen = new Set([''])
                for (const d of labelled) {
                    if (seen.has(d.deviceId)) continue
                    opts.push({ value: d.deviceId, text: d.label })
                    seen.add(d.deviceId)
                }
                if (dm.active === 'camera' && dm.currentLabel) {
                    const liveId = dm.currentCameraDeviceId || '__active__'
                    if (!seen.has(liveId)) {
                        opts.push({ value: liveId, text: dm.currentLabel })
                        seen.add(liveId)
                    }
                } else if (labelled.length === 0) {
                    opts.push({ value: '__default__', text: 'Enable camera (default device)' })
                }
                cameraSel.setOptions(opts)
                const liveSel = dm.active === 'camera'
                    ? (dm.currentCameraDeviceId || '__active__')
                    : ''
                cameraSel.setAttribute('value', liveSel)
            }
        } else {
            if (cameraSel) cameraSel.hidden = true
            if (fileBtn) fileBtn.hidden = false
        }
        if (labelEl) labelEl.textContent = dm.currentLabel || ''
    }

    function wireDeckMediaControls() {
        for (const deckId of ['A', 'B']) {
            const cameraSel = $(`deck-${deckId.toLowerCase()}-media-camera`)
            const fileBtn = $(`deck-${deckId.toLowerCase()}-media-file-btn`)
            const fileInput = $(`deck-${deckId.toLowerCase()}-media-file-input`)
            const labelEl = $(`deck-${deckId.toLowerCase()}-media-label`)
            if (cameraSel) cameraSel.addEventListener('change', async () => {
                const v = cameraSel.value
                // Placeholder (empty) or __active__ (already-running
                // camera) are no-ops.
                if (!v || v === '__active__') return
                // '__default__' = no labelled devices yet; pass empty
                // deviceId to getUserMedia so it prompts for permission
                // on whatever default camera the browser picks.
                const deviceId = v === '__default__' ? '' : v
                try {
                    await deckMedia[deckId].setCamera(deviceId)
                    if (labelEl) labelEl.textContent = deckMedia[deckId].currentLabel
                    // Re-render so post-permission enumerated labels
                    // appear AND so the trigger picks up the live
                    // camera's __active__ option if the browser
                    // didn't report a deviceId.
                    await refreshDeckMediaUi(deckId)
                } catch (err) {
                    toast(`${deckId}: ${err.message || err}`)
                }
            })
            if (fileBtn && fileInput) {
                fileBtn.addEventListener('click', () => fileInput.click())
                fileInput.addEventListener('change', async () => {
                    const f = fileInput.files?.[0]
                    if (!f) return
                    try {
                        await deckMedia[deckId].setFile(f)
                        if (labelEl) labelEl.textContent = deckMedia[deckId].currentLabel
                    } catch (err) {
                        toast(`${deckId}: ${err.message || err}`)
                    }
                })
            }
        }
    }
    wireDeckMediaControls()

    // Persist the active mixer effect + its overrides so a reload (and the
    // boot-time restore near the top of boot()) reproduces the operator's
    // tweaks. Both the dropdown AND the controls panel feed this; before the
    // panel fed it, panel-set overrides were never written and the restore
    // only ever saw an empty override map.
    function persistMixer() {
        const m = mixer.currentMixer
        const payload = { id: m.id, overrides: { ...mixer._currentOverrides } }
        try { localStorage.setItem('visualize.mixer.v1', JSON.stringify(payload)) } catch {}
    }
    // The controls panel fires on every slider `input` tick — debounce so a
    // drag doesn't hammer synchronous localStorage writes.
    let _mixerPersistTimer = null
    function persistMixerDebounced() {
        if (_mixerPersistTimer) clearTimeout(_mixerPersistTimer)
        _mixerPersistTimer = setTimeout(persistMixer, 250)
    }

    /**
     * Populate + wire the mixer-effect dropdown. Per-effect mode
     * (e.g. blend's blendMode param) is now exposed by the
     * MixerControls panel like any other parameter, so the old
     * sibling #mixer-mode dropdown was retired.
     */
    function wireMixerPicker(mixer) {
        const sel = $('mixer-effect')
        if (!sel) return

        // <select-dropdown> parses <option> children only on
        // connectedCallback, so post-connect population goes through
        // its programmatic setOptions API instead.
        sel.setOptions(MIXERS.map(m => ({ value: m.id, text: m.label })))
        sel.setAttribute('value', mixer.currentMixer.id)

        sel.addEventListener('change', async () => {
            await mixer.setMixerEffect(sel.value)
            mixerControlsPanel?.show(mixer.currentMixer.id)
            persistMixer()
        })
    }

    let mixerControlsPanel = null

    /**
     * Mount the per-mixer-effect control panel below the main canvas.
     * Reads the noisemaker effect definition + builds a noisedeck-
     * style row per non-driver parameter. Refreshes whenever the
     * mixer-effect dropdown changes via wireMixerPicker().
     */
    function wireMixerControls(mixer) {
        const root = $('mixer-controls')
        if (!root) return
        // Pass a persist hook so panel-set overrides survive a reload (the
        // dropdown's own persist only fires on effect switch).
        mixerControlsPanel = new MixerControls(root, mixer, persistMixerDebounced)
        mixerControlsPanel.show(mixer.currentMixer.id)
    }

    /** Wire the per-deck DSL editor toggle, hot reload, and Cmd+Enter. */
    function wireDeckEditors() {
        for (const deckId of ['A', 'B']) {
            const deckEl = document.querySelector(`.deck[data-deck="${deckId}"]`)
            const panel = deckEl.querySelector('.deck-editor')
            const editor = deckEl.querySelector('code-editor')
            const errorEl = deckEl.querySelector('.deck-editor-error')
            const toggleBtn = deckEl.querySelector('.deck-edit-toggle')

            editor.setTokenizer?.(dslTokenizer)
            enhanceCodeEditor(editor)

            function showError(msg) {
                errorEl.innerHTML = ''
                const span = document.createElement('span')
                span.textContent = msg
                errorEl.appendChild(span)
                errorEl.hidden = false
            }
            function clearError() {
                errorEl.hidden = true
                errorEl.innerHTML = ''
            }

            toggleBtn.addEventListener('click', () => {
                const opening = panel.hidden
                panel.hidden = !opening
                toggleBtn.classList.toggle('active', opening)
                if (opening) {
                    editor.value = state.decks[deckId]._currentDsl || ''
                    clearError()
                    requestAnimationFrame(() => editor.focus?.())
                }
            })

            let inFlight = false
            let hotReloadTimer = null
            async function compileFromEditor() {
                if (inFlight) return
                const dsl = editor.value
                if (!dsl.trim()) return
                inFlight = true
                try {
                    const res = await state.decks[deckId].load(dsl, '(custom)')
                    if (!res.success) {
                        showError(res.error || 'compile failed')
                        return
                    }
                    clearError()
                    audio.refreshDeckStates()
                    const labels = deckLabels[deckId]
                    if (labels) {
                        labels.name.textContent = '(custom)'
                        labels.tag.textContent = ''
                    }
                } finally {
                    inFlight = false
                }
            }

            // Hot reload — recompile 500ms after the user stops typing.
            // Mirrors polymorphic's behavior; no compile button needed.
            editor.addEventListener('input', () => {
                if (hotReloadTimer) clearTimeout(hotReloadTimer)
                hotReloadTimer = setTimeout(() => {
                    hotReloadTimer = null
                    compileFromEditor()
                }, 500)
            })
            // Cmd/Ctrl+Enter forces an immediate recompile.
            editor.addEventListener('forcerecompile', () => {
                if (hotReloadTimer) {
                    clearTimeout(hotReloadTimer)
                    hotReloadTimer = null
                }
                compileFromEditor()
            })
        }
    }

    /** Keep an open editor in sync with the deck's currently loaded DSL.
     *  Reads directly from the deck — the renderer is the single source
     *  of truth (this covers post-load, post-rebind, and post-scene-
     *  recall all in one path). */
    function syncDeckEditor(deckId) {
        const deckEl = document.querySelector(`.deck[data-deck="${deckId}"]`)
        const panel = deckEl.querySelector('.deck-editor')
        if (panel.hidden) return
        const editor = deckEl.querySelector('code-editor')
        editor.value = state.decks[deckId]._currentDsl || ''
    }

    wireDeckEditors()

    // Drag-drop on deck panel. Bound to the .deck root rather than
    // the canvas-wrap (which is now absolute-positioned + z-index:0
    // behind the head/content/meta strips, so it never receives
    // dragover/drop on its own).
    document.querySelectorAll('.deck').forEach(deck => {
        const deckId = deck.dataset.deck
        deck.addEventListener('dragover', (e) => { e.preventDefault(); deck.classList.add('drag-over') })
        deck.addEventListener('dragleave', () => deck.classList.remove('drag-over'))
        deck.addEventListener('drop', async (e) => {
            e.preventDefault()
            deck.classList.remove('drag-over')
            const title = e.dataTransfer.getData('text/program-title')
            const p = library.byTitle(title)
            if (p) await loadProgram(deckId, p)
        })
    })

    // BPM controls
    bpmInputEl.addEventListener('change', (e) => {
        scheduler.bpm = parseFloat(e.target.value)
        scheduler.resetPhase()
    })
    if (bpmDividerEl) {
        bpmDividerEl.addEventListener('change', (e) => {
            scheduler.divider = parseInt(e.target.value, 10)
        })
    }
    // Mirror bpm changes (e.g. tap, MIDI) back into the input.
    scheduler.onChange((bpm) => {
        if (document.activeElement !== bpmInputEl) {
            bpmInputEl.value = bpm.toFixed(1)
        }
    })
    const tapBtn = $('tap-tempo')
    function doTap() {
        const bpm = scheduler.tap()
        if (bpm) bpmInputEl.value = bpm.toFixed(1)
        tapBtn.classList.add('flash')
        setTimeout(() => tapBtn.classList.remove('flash'), 100)
    }
    tapBtn.addEventListener('click', doTap)

    // Phase controls — scheduler is single source of truth for time;
    // deck renderers derive their origin from it.
    const phaseResetBtn = $('phase-reset')
    const phaseSlider = $('phase-slider')
    function syncDecksToScheduler() {
        state.decks.A.syncTimeOrigin(scheduler._lastBeatMs)
        state.decks.B.syncTimeOrigin(scheduler._lastBeatMs)
    }
    phaseResetBtn.addEventListener('mousedown', () => {
        scheduler.resetPhase()
        syncDecksToScheduler()
        if (phaseSlider) phaseSlider.value = 0
    })
    if (phaseSlider) {
        phaseSlider.addEventListener('input', () => {
            scheduler.setPhaseOffset(Number(phaseSlider.value))
            syncDecksToScheduler()
        })
    }

    // Beat dots
    const beatDots = [...document.querySelectorAll('.beat-dot')]
    beatDots.forEach((d, i) => d.classList.toggle('downbeat', i === 0))
    // Cache deck elements for the per-beat pulse glow.
    const deckPanelA = document.querySelector('.deck.deck-a')
    const deckPanelB = document.querySelector('.deck.deck-b')
    scheduler.onBeat((b) => {
        beatDots.forEach((d, i) => {
            d.classList.toggle('active', i === b.beatInBar)
        })
        // Beat-driven strobe
        if (compositor.strobe) compositor.strobeBlink()
        // Pulse the live deck's glow on each quarter note. The pulse
        // class re-adds via rAF so a brief class-removal + re-add
        // restarts the CSS transition every beat (otherwise the
        // browser elides the no-op toggle).
        for (const deckEl of [deckPanelA, deckPanelB]) {
            if (!deckEl || !deckEl.classList.contains('live')) continue
            deckEl.classList.remove('beat-pulse')
            // Force a reflow so the class re-add triggers the keyframe
            // animation cleanly from t=0 each beat.
            void deckEl.offsetWidth
            deckEl.classList.add('beat-pulse')
        }
    })

    // Main FX buttons
    document.querySelectorAll('.fx-button').forEach(btn => {
        const fx = btn.dataset.fx
        btn.addEventListener('click', () => toggleFx(fx, btn))
    })

    function toggleFx(fx, btnEl) {
        const btn = btnEl || document.querySelector(`.fx-button[data-fx="${fx}"]`)
        const active = !btn.classList.contains('active')
        if (fx === 'strobe') compositor.setStrobe(active)
        else if (fx === 'invert') compositor.setInvert(active)
        else if (fx === 'bw') compositor.setBW(active)
        else if (fx === 'zoom') compositor.setZoom(active)
        else if (fx === 'freeze') compositor.setFreeze(active)
        else if (fx === 'flash') {
            compositor.flash()
            // Also pulse the CSS overlay for a soft "screen flash" feel
            // on top of the canvas-level white frame
            if (flashOverlayEl) {
                flashOverlayEl.classList.add('flash')
                setTimeout(() => flashOverlayEl.classList.remove('flash'), 300)
            }
            return
        }
        if (btn) btn.classList.toggle('active', active)
    }

    // Auto-VJ toggle (with mutual exclusion against Auto-Mix below)
    $('automix-toggle').addEventListener('click', () => {
        const on = autoMix.toggle()
        $('automix-toggle').dataset.state = on ? 'on' : 'off'
        if (on && autoXfade.enabled) {
            autoXfade.setEnabled(false)
            updateAutoXfadeToggleUi()
            persistAutoXfade()
        }
    })

    // ── Auto-Mix UI wiring ───────────────────────────────────────────
    const autoXfadeToggleEl = $('automixer-toggle')
    const autoXfadeSourceEl = $('automixer-source')

    function updateAutoXfadeToggleUi() {
        autoXfadeToggleEl.dataset.state = autoXfade.enabled ? 'on' : 'off'
    }
    function syncAutoXfadeSourceUi() {
        const s = autoXfade.source
        let key = 'osc:0'
        if (s.kind === 'osc') key = `osc:${s.oscType}`
        else if (s.kind === 'audio') key = `audio:${s.band}`
        else if (s.kind === 'midi') key = `midi:${s.channel}`
        if (autoXfadeSourceEl) autoXfadeSourceEl.value = key
    }
    syncAutoXfadeSourceUi()
    updateAutoXfadeToggleUi()

    autoXfadeToggleEl.addEventListener('click', () => {
        autoXfade.setEnabled(!autoXfade.enabled)
        updateAutoXfadeToggleUi()
        // The onEnableChange wiring above already disables autoMix when
        // autoXfade goes on; mirror its pill state here.
        $('automix-toggle').dataset.state = autoMix.enabled ? 'on' : 'off'
        persistAutoXfade()
    })

    autoXfadeSourceEl.addEventListener('change', () => {
        const v = autoXfadeSourceEl.value
        const [kind, rest] = v.split(':')
        if (kind === 'osc') autoXfade.setSource({ kind: 'osc', oscType: parseInt(rest, 10) })
        else if (kind === 'audio') autoXfade.setSource({ kind: 'audio', band: rest })
        else if (kind === 'midi') autoXfade.setSource({ kind: 'midi', channel: parseInt(rest, 10) })
        persistAutoXfade()
    })
    $('automix-bars').addEventListener('change', (e) => {
        autoMix.setBarsPerScene(parseInt(e.target.value, 10))
    })
    $('automix-curve').addEventListener('change', (e) => {
        state.curve = e.target.value
        autoMix.setCurve(e.target.value)
        compositor.setCurve(e.target.value)
    })

    // Fade duration — single source of truth for both the manual
    // auto-fade button and auto-VJ scene transitions. Stored on
    // state and pushed into AutoMix so its tickFrame uses the
    // user-set number of seconds instead of a bars-derived value.
    const fadeDurEl = $('fade-duration')
    if (fadeDurEl) {
        fadeDurEl.value = state.fadeDurSec
        fadeDurEl.addEventListener('input', () => {
            const v = Number(fadeDurEl.value)
            if (!Number.isFinite(v) || v <= 0) return
            state.fadeDurSec = v
            autoMix.setFadeDurationSec(v)
        })
        autoMix.setFadeDurationSec(state.fadeDurSec)
    }

    // Record
    $('record-toggle').addEventListener('click', () => recorder.toggle())
    $('output-window').addEventListener('click', () => outputWin.toggle())

    // Fullscreen
    $('fullscreen-toggle').addEventListener('click', () => toggleFullscreen())
    $('about-btn').addEventListener('click', () => aboutDialog.show())
    document.addEventListener('fullscreenchange', () => {
        document.getElementById('app').classList.toggle('fullscreen-main', !!document.fullscreenElement)
    })

    function toggleFullscreen() {
        const app = document.getElementById('app')
        if (!document.fullscreenElement) {
            app.classList.add('fullscreen-main')
            app.requestFullscreen?.().catch(() => app.classList.remove('fullscreen-main'))
        } else {
            document.exitFullscreen?.()
            app.classList.remove('fullscreen-main')
        }
    }

    // Theme picker (Handfish themes; the inline <script> in index.html
    // already applied the saved theme before paint, so this just wires the
    // dropdown UI).
    const themeHost = $('theme-picker-host')
    if (themeHost) mountThemePicker({ container: themeHost, storageKey: 'visualize.theme.v1' })

    // Settings drawer
    const drawer = $('settings-drawer')
    // Reflect the renderer ACTUALLY running (read from the deck's live
    // pipeline via activeBackend), not just the saved preference: a
    // WebGPU preference silently falls back to WebGL2 on browsers/GPUs
    // without support, and the operator deserves to see that rather than
    // a switch that looks honored when it wasn't.
    function refreshActiveRenderer() {
        const el = $('active-renderer')
        if (!el) return
        const deck = state.decks.A   // both decks share one preference
        const active = deck.activeBackend
        const label = active === 'webgpu' ? 'WebGPU' : 'WebGL2'
        // `deck.preferWebGPU` is the preference applied at boot — the live
        // toggle/`state` may have changed since, but that only takes
        // effect on reload. Flag a genuine fallback only: asked for WebGPU
        // this session yet WebGL2 is what's running.
        const fellBack = deck.preferWebGPU && active !== 'webgpu'
        el.textContent = fellBack ? `active: ${label} (WebGPU unavailable)` : `active: ${label}`
    }
    function openSettings() {
        drawer.setAttribute('aria-hidden', 'false')
        refreshAudioDevices()
        refreshActiveRenderer()
    }
    function closeSettings() { drawer.setAttribute('aria-hidden', 'true') }
    $('settings-toggle').addEventListener('click', () => {
        const open = drawer.getAttribute('aria-hidden') !== 'false'
        if (open) openSettings(); else closeSettings()
    })
    $('settings-close').addEventListener('click', closeSettings)

    // User effects panel — import + delete affordances. The list
    // re-renders from IndexedDB on each onChange so the operator's
    // view stays in sync with whatever the share-loader path or other
    // tabs of the same app are doing.
    setupUserEffectsPanel(userEffects, state.decks.A.inner)

    async function refreshAudioDevices() {
        // <select-dropdown> exposes setOptions() for programmatic
        // population. We use that rather than appending <option>
        // children because the component's children-parser remaps
        // empty-value options to their textContent (so our
        // <option value=""> placeholder would lose its sentinel).
        const sel = $('audio-device')
        const cur = sel.value
        const devices = await audio.listDevices()
        const opts = [{ value: '', text: '— pick to enable —' }]
        // Pre-permission browsers return entries with empty deviceId
        // + empty label. Safari returns an empty list. Either way:
        // fall back to a single sentinel entry that maps to
        // getUserMedia({audio:true}); the next refresh shows labels.
        const labelled = devices.filter(d => d.label && d.deviceId)
        if (labelled.length > 0) {
            for (const d of labelled) {
                opts.push({ value: d.deviceId, text: d.label })
            }
        } else {
            opts.push({ value: '__default__', text: 'Enable audio (default device)' })
        }
        sel.setOptions(opts)
        // Pick initial value: live device preferred, else what was
        // selected before the refresh, else the placeholder.
        let initialValue = ''
        const validValues = new Set(opts.map(o => o.value))
        if (audio.enabled && audio.currentDeviceId && validValues.has(audio.currentDeviceId)) {
            initialValue = audio.currentDeviceId
        } else if (cur && validValues.has(cur)) {
            initialValue = cur
        }
        sel.setAttribute('value', initialValue)
    }

    async function handleAudioDeviceChange(e) {
        const sel = e.target
        const value = sel.value
        if (!value) {
            await audio.disable()
            return
        }
        // '__default__' is the sentinel we render when no device labels
        // are visible (pre-permission). enable('') falls through to the
        // browser's default audioinput, which prompts for permission and
        // gives us labels on the next refresh.
        const deviceId = value === '__default__' ? '' : value
        const ok = await audio.enable(deviceId)
        if (ok) {
            await refreshAudioDevices()
        } else {
            // enable() failed (likely permission denied). Reset to the
            // placeholder so re-selecting the same option dispatches
            // 'change' again — otherwise the user is stuck.
            sel.value = ''
        }
    }
    $('audio-device').addEventListener('change', handleAudioDeviceChange)
    $('audio-sensitivity').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value)
        audio.setSensitivity(v)
        $('audio-sensitivity-val').textContent = `${v.toFixed(1)}×`
    })

    // MIDI
    $('midi-enable').addEventListener('click', async () => {
        const on = await midi.toggle()
        $('midi-enable').textContent = on ? 'disable MIDI' : 'enable MIDI'
    })

    // Quick-toggle audio/MIDI from the topbar pills. Audio enable falls
    // back to the OS default mic — once permission is granted, the device
    // dropdown in settings repopulates with labelled devices so users can
    // pick a specific input.
    $('audio-status').addEventListener('click', async () => {
        if (audio.enabled) {
            await audio.disable()
        } else {
            const ok = await audio.enable('')
            if (!ok) toast('audio: enable failed (check mic permission)')
            else await refreshAudioDevices()
        }
    })
    $('midi-status').addEventListener('click', async () => {
        const on = await midi.toggle()
        $('midi-enable').textContent = on ? 'disable MIDI' : 'enable MIDI'
    })
    $('midi-clock-enable').addEventListener('change', (e) => {
        midi.followClock = e.target.checked
        toast(midi.followClock ? 'following MIDI clock for BPM' : 'BPM is manual / tap')
    })
    // <label>-for-input association doesn't work with custom elements,
    // so forward clicks on the row's text span to the inner toggle.
    for (const row of document.querySelectorAll('.checkbox-row')) {
        row.addEventListener('click', (e) => {
            const toggle = row.querySelector('toggle-switch')
            if (!toggle || toggle.disabled) return
            if (e.target === toggle || toggle.contains(e.target)) return
            toggle.checked = !toggle.checked
            toggle.dispatchEvent(new Event('change', { bubbles: true }))
        })
    }

    // MIDI learn rows
    registerMidiControls(midi, {
        crossfader: (v01) => {
            state.crossfade = v01
            compositor.setCrossfade(v01)
            xfaderEl.value = String(v01)
        },
        crossfaderValue: () => state.crossfade,
        speedA: (v01) => {
            const s = 0.1 + v01 * 3.9
            state.decks.A.setSpeed(s)
            $('speed-a').value = String(s)
            $('speed-a-val').textContent = `${s.toFixed(1)}×`
        },
        speedAValue: () => (state.decks.A.speed - 0.1) / 3.9,
        speedB: (v01) => {
            const s = 0.1 + v01 * 3.9
            state.decks.B.setSpeed(s)
            $('speed-b').value = String(s)
            $('speed-b-val').textContent = `${s.toFixed(1)}×`
        },
        speedBValue: () => (state.decks.B.speed - 0.1) / 3.9,
        fxToggle: (name) => toggleFx(name),
        fxFlash: () => compositor.flash(),
    })
    midi.onLearnUpdate((rows) => renderLearnRows(rows, midi))
    renderLearnRows(midi.getLearnView(), midi)

    // Live value bars — engine fires per message; coalesce to one DOM
    // update per frame to avoid thrash.
    let _activityPending = null
    midi.onControlActivity((controlId, payload) => {
        if (!renderLearnRows._bars) return
        const entry = renderLearnRows._bars.get(controlId)
        if (!entry) return
        _activityPending = _activityPending || new Map()
        _activityPending.set(controlId, payload)
        if (_activityPending._scheduled) return
        _activityPending._scheduled = true
        requestAnimationFrame(() => {
            const batch = _activityPending; _activityPending = null
            if (!batch || !renderLearnRows._bars) return
            for (const [id, p] of batch) {
                const e = renderLearnRows._bars.get(id)
                if (!e) continue
                e.fill.style.width = `${Math.round((p.value01 || 0) * 100)}%`
                e.row.classList.toggle('pickup', !!p.pickup)
                // Pickup direction arrow
                if (p.pickup && p.armSide != null) {
                    if (e.dir) e.dir.textContent = p.armSide > 0 ? '◂' : '▸'
                } else {
                    if (e.dir) e.dir.textContent = ''
                }
                // Engage pulse: transition from pickup→engaged
                if (e.prevPickup && !p.pickup) {
                    clearTimeout(e._flashTimer)
                    e.row.classList.remove('ml-engaged-flash')
                    // Force reflow so re-adding the class restarts the animation
                    void e.row.offsetWidth
                    e.row.classList.add('ml-engaged-flash')
                    e._flashTimer = setTimeout(() => e.row.classList.remove('ml-engaged-flash'), 300)
                }
                e.prevPickup = !!p.pickup
            }
        })
    })

    $('midi-learn-clear').addEventListener('click', () => midi.clearAllAssignments())

    // Main resolution / loop / WebGPU
    $('main-resolution').addEventListener('change', (e) => {
        const [w, h] = e.target.value.split('x').map(Number)
        state.mainRes = { width: w, height: h }
        state.decks.A.resize(w, h)
        state.decks.B.resize(w, h)
        compositor.resize(w, h)
        $('main-res').textContent = `${w}×${h}`
        toast(`main: ${w}×${h}`)
    })
    const webgpuToggle = $('prefer-webgpu')
    webgpuToggle.checked = state.preferWebGPU
    webgpuToggle.addEventListener('change', (e) => {
        state.preferWebGPU = e.target.checked === true
        persistRendererPrefs()
        toast(state.preferWebGPU
            ? 'WebGPU preferred on next reload'
            : 'WebGL2 preferred on next reload')
        // The change only lands on reload, so the active backend is
        // unchanged for now — repaint anyway so the indicator stays
        // truthful if the operator toggles with the drawer open.
        refreshActiveRenderer()
    })
    // FPS readout
    setInterval(() => {
        fpsEl.textContent = String(compositor.fps)
    }, 500)

    // ── Scenes ───────────────────────────────────────────────────────────
    const scenes = new Scenes()
    const scenesDrawer = $('scenes-drawer')
    const scenesList = $('scenes-list')
    const sceneNameInput = $('scene-name-input')

    /** Snapshot accessor — passed to Scenes.snapshot(). */
    function snapshotAccessors() {
        return {
            decks: state.decks,
            getXfade: () => state.crossfade,
            getCurve: () => state.curve,
            scheduler,
            getFxState: () => ({
                strobe: compositor.strobe,
                invert: compositor.invert,
                bw: compositor.bw,
                zoom: compositor.zoom,
                freeze: compositor.freeze
            }),
            getAutoMixConfig: () => ({
                enabled: autoMix.enabled,
                barsPerScene: parseInt($('automix-bars').value, 10),
                curve: $('automix-curve').value
            }),
            // Mixer effect + per-effect overrides have major visual
            // impact (different blend modes look wildly different).
            // Captured so a scene round-trip reproduces what the
            // operator was looking at.
            getMixerState: () => mixerControlsPanel ? {
                id: mixer.currentMixer.id,
                overrides: { ...mixer._currentOverrides }
            } : null,
            // Per-deck pixel density — manual choice affects sharpness
            // and the visual feel.
            getDeckDensity: () => ({
                A: { ...state.deckDensity.A },
                B: { ...state.deckDensity.B }
            }),
            getAutoXfadeConfig: () => autoXfade.snapshot()
        }
    }

    /** Applicator — passed to Scenes.apply(). */
    function applyAccessors() {
        return {
            decks: state.decks,
            setXfade: (v) => {
                state.crossfade = v
                compositor.setCrossfade(v)
                xfaderEl.value = String(v)
                updateLiveIndicator()
            },
            setCurve: (c) => {
                state.curve = c
                compositor.setCurve(c)
                autoMix.setCurve(c)
                const sel = $('automix-curve')
                if (sel) sel.value = c
            },
            scheduler,
            setFx: (fx) => {
                // Match each toggle to the saved state; call toggleFx
                // only when the active state differs.
                for (const name of ['strobe', 'invert', 'bw', 'zoom', 'freeze']) {
                    const want = !!fx[name]
                    const have = compositor[name]
                    if (want !== have) {
                        const btn = document.querySelector(`.fx-button[data-fx="${name}"]`)
                        toggleFx(name, btn)
                    }
                }
            },
            setAutoMixConfig: (cfg) => {
                if (typeof cfg.barsPerScene === 'number') {
                    autoMix.setBarsPerScene(cfg.barsPerScene)
                    const sel = $('automix-bars')
                    if (sel) sel.value = String(cfg.barsPerScene)
                }
                if (cfg.curve) {
                    autoMix.setCurve(cfg.curve)
                    state.curve = cfg.curve
                    compositor.setCurve(cfg.curve)
                }
                // Sync the auto-VJ button without toggling (only flip if
                // saved state differs from current)
                if (autoMix.enabled !== !!cfg.enabled) {
                    autoMix.setEnabled(!!cfg.enabled)
                    $('automix-toggle').dataset.state = cfg.enabled ? 'on' : 'off'
                }
            },
            setMixerState: async (m) => {
                if (!m || !m.id || !mixerControlsPanel) return
                await mixer.setMixerEffect(m.id, m.overrides || {})
                mixerControlsPanel.show(mixer.currentMixer.id)
                const sel = $('mixer-effect')
                if (sel) sel.value = mixer.currentMixer.id
            },
            setDeckDensity: (d) => {
                if (!d) return
                for (const id of ['A', 'B']) {
                    const saved = d[id]
                    if (!saved) continue
                    state.deckDensity[id] = { mode: saved.mode, value: saved.value }
                    state.decks[id].setPixelDensity(saved.value)
                }
            },
            setAutoXfadeConfig: (cfg) => {
                autoXfade.restore(cfg)
                syncAutoXfadeSourceUi()
                updateAutoXfadeToggleUi()
                persistAutoXfade()
            },
            refreshAudio: () => audio.refreshDeckStates(),
            refreshRebind: () => {
                // After a scene recall the deck's _currentDsl is the
                // regenerated rebind DSL — push it back into any open
                // editor and refresh the per-deck UI chrome too.
                updateBandpassBtn('A')
                updateBandpassBtn('B')
                updateOscCountBtn('A')
                updateOscCountBtn('B')
                updateDensityButton('A')
                updateDensityButton('B')
                syncDeckEditor('A')
                syncDeckEditor('B')
                refreshDeckMediaUi('A')
                refreshDeckMediaUi('B')
            }
        }
    }

    function renderScenes() {
        const list = scenes.scenes
        scenesList.innerHTML = ''
        if (list.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'scenes-empty'
            empty.textContent = 'no scenes saved yet — set up your decks and save a snapshot above'
            scenesList.appendChild(empty)
            return
        }
        list.forEach((s, i) => {
            const row = document.createElement('div')
            row.className = 'scene-row'
            const hot = i < 9 ? `⇧${i + 1}` : ''
            const fxBadges = Object.entries(s.fx || {})
                .filter(([, v]) => v)
                .map(([k]) => k.toUpperCase())
                .join('·') || '—'
            row.innerHTML = `
                <span class="sr-key">${hot}</span>
                <span>
                    <div class="sr-name">${escapeHtml(s.name)}</div>
                    <div class="sr-meta">${Math.round(s.bpm || 0)} BPM · ${fxBadges}</div>
                </span>
            `
            const actions = document.createElement('span')
            actions.className = 'sr-actions'
            const load = document.createElement('button')
            load.textContent = 'recall'
            load.addEventListener('click', (e) => {
                e.stopPropagation()
                recallScene(s)
            })
            const del = document.createElement('button')
            del.className = 'sr-delete'
            del.textContent = '✕'
            setTooltip(del, 'delete')
            del.addEventListener('click', (e) => {
                e.stopPropagation()
                if (confirm(`Delete scene "${s.name}"?`)) {
                    scenes.delete(s.name)
                }
            })
            actions.appendChild(load)
            actions.appendChild(del)
            row.appendChild(actions)
            row.addEventListener('click', () => recallScene(s))
            scenesList.appendChild(row)
        })
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]))
    }

    async function recallScene(scene) {
        toast(`recall: ${scene.name}`)
        const errors = await Scenes.apply(scene, applyAccessors())
        if (errors.length) toast(`recall had errors: ${errors[0].slice(0, 60)}`, 4000)
    }

    state.curve = 'dipped' // track current curve so snapshots can read it

    // Expose scene plumbing to the test hook so specs can drive
    // save / recall without scraping the UI.
    if (window.__visualize) {
        window.__visualize.scenes = scenes
        window.__visualize.takeSnapshot = () => Scenes.snapshot(snapshotAccessors())
        window.__visualize.applySnapshot = (snap) => Scenes.apply(snap, applyAccessors())
    }

    scenes.onChange(() => renderScenes())
    renderScenes()

    $('scenes-open').addEventListener('click', () => {
        scenesDrawer.setAttribute('aria-hidden', scenesDrawer.getAttribute('aria-hidden') === 'false' ? 'true' : 'false')
    })
    $('scenes-close').addEventListener('click', () => {
        scenesDrawer.setAttribute('aria-hidden', 'true')
    })
    $('scene-save').addEventListener('click', () => {
        const name = sceneNameInput.value
        if (!name.trim()) {
            toast('name your scene first')
            sceneNameInput.focus()
            return
        }
        const snap = Scenes.snapshot(snapshotAccessors())
        scenes.save(name, snap)
        sceneNameInput.value = ''
        toast(`saved: ${name.trim()}`)
    })
    sceneNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('scene-save').click()
    })

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
        // ignore when typing in inputs
        const tag = e.target.tagName
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
        const key = e.key.toLowerCase()

        // Shift+S toggles scenes drawer; Shift+1..9 recalls scene.
        // Check e.code (layout-independent) for digits because Shift+1
        // on a US keyboard produces e.key = '!', not '1'.
        const digitMatch = e.shiftKey && /^Digit[1-9]$/.test(e.code)
        if (e.shiftKey && (key === 's' || digitMatch)) {
            e.preventDefault()
            if (key === 's') {
                scenesDrawer.setAttribute('aria-hidden',
                    scenesDrawer.getAttribute('aria-hidden') === 'false' ? 'true' : 'false')
                return
            }
            const idx = parseInt(e.code.replace('Digit', ''), 10) - 1
            const s = scenes.byIndex(idx)
            if (s) recallScene(s)
            else toast(`no scene at slot ${idx + 1}`)
            return
        }

        switch (key) {
            case ' ':
                e.preventDefault()
                $('automix-toggle').click()
                break
            case 't':
                doTap(); break
            case 'f':
                toggleFullscreen(); break
            case 's':
                if (drawer.getAttribute('aria-hidden') === 'false') closeSettings(); else openSettings()
                break
            case 'r':
                recorder.toggle(); break
            case 'z':
                $('cut-a').click(); break
            case 'x':
                $('auto-fade').click(); break
            case 'c':
                $('cut-b').click(); break
            case 'q': {
                const p = library.randomExcept(state.decks.A.currentName)
                loadProgram('A', p)
                break
            }
            case 'w': {
                const p = library.randomExcept(state.decks.B.currentName)
                loadProgram('B', p)
                break
            }
            case 'arrowleft': {
                state.crossfade = Math.max(0, state.crossfade - 0.05)
                compositor.setCrossfade(state.crossfade)
                xfaderEl.value = String(state.crossfade)
                updateLiveIndicator()
                autoMix.noteUserOverride()
                break
            }
            case 'arrowright': {
                state.crossfade = Math.min(1, state.crossfade + 0.05)
                compositor.setCrossfade(state.crossfade)
                xfaderEl.value = String(state.crossfade)
                updateLiveIndicator()
                autoMix.noteUserOverride()
                break
            }
            case '1': toggleFx('strobe'); break
            case '2': toggleFx('invert'); break
            case '3': toggleFx('bw'); break
            case '4': toggleFx('zoom'); break
            case '5': toggleFx('freeze'); break
            case '6': toggleFx('flash'); break
            case 'e': {
                const deckId = e.shiftKey ? 'B' : 'A'
                const btn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
                btn?.click()
                break
            }
            case 'm': {
                const deckId = e.shiftKey ? 'B' : 'A'
                const btn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
                btn?.click()
                break
            }
            case 'escape':
                if (drawer.getAttribute('aria-hidden') === 'false') {
                    closeSettings()
                } else if (scenesDrawer.getAttribute('aria-hidden') === 'false') {
                    scenesDrawer.setAttribute('aria-hidden', 'true')
                } else if (document.fullscreenElement) {
                    document.exitFullscreen?.()
                }
                break
        }
    })

    // Initial load: random into both decks. Serialize (not Promise.all) —
    // the shader bundle's loadEffects() shares manifest state and parallel
    // first-time loads sometimes race into ERR_COMPILATION_FAILED.
    const startA = library.random()
    const startB = library.randomExcept(startA?.title)
    await loadProgram('A', startA)
    await loadProgram('B', startB)
    updateLiveIndicator()
    setStatusPill('audio-status', 'audio off', 'off')
    setStatusPill('midi-status', 'midi off', 'off')

    // App is now fully running behind the boot overlay (decks rendering,
    // compositor compositing). Wait for the user to click START SET (or,
    // on the share-loader path, A Deck / B Deck).
    const gesture = await window.__visualizeBootGesture

    // Share-loader path: gesture payload tells us which deck the user
    // wants to drop the incoming composition onto. The fetch was kicked
    // off by the inline boot script and prepared during boot, so the
    // composition is usually already in hand — just swap the random
    // start program for the shared one on the chosen deck.
    if (gesture?.deckId) {
        const composition = await sharePromise
        if (composition?.dsl) {
            // If the composition shipped portable effects, install them
            // BEFORE compiling the DSL — the compiler would otherwise
            // bail with "unknown function user.foo" mid-load. Each
            // install also persists to IndexedDB so a future reload of
            // the same composition (or any other DSL that references
            // these effects) compiles cleanly without re-fetching.
            const bundled = Array.isArray(composition.effects) ? composition.effects : []
            if (bundled.length > 0) {
                for (const payload of bundled) {
                    try {
                        await userEffects.uploadFromPayload(payload, state.decks.A.inner)
                    } catch (err) {
                        console.error('[share-loader] effect install failed:', payload?.name, err)
                    }
                }
                // Wait for the library to absorb the newly-registered
                // effects so the "user" section reflects them before
                // we render the toast.
                await library.reloadDefaults(state.decks.A.inner)
                library.render()
            }

            await loadProgram(gesture.deckId, {
                title: composition.title || `code ${composition.code || ''}`,
                tagline: composition.description || 'shared from sharing.noisedeck.app',
                dsl: composition.dsl,
            })
            updateLiveIndicator()
            const bundledNote = bundled.length > 0
                ? ` (+${bundled.length} custom effect${bundled.length === 1 ? '' : 's'} installed)`
                : ''
            toast(`loaded "${composition.title || 'shared program'}" into deck ${gesture.deckId}${bundledNote}`)
        }
        // Strip ?code= so a reload doesn't re-prompt with the same
        // share dialog — the operator already made their choice.
        clearCodeFromUrl()
    }

    // Live decks are up and stable; defer library thumbnails to an idle
    // window so the offscreen renderer doesn't compete for GPU during
    // the user's first few seconds of interaction. Falls back to a
    // short timeout on browsers without requestIdleCallback.
    //
    // Skipped under automation (Playwright): the smoke + audio-midi
    // specs run a tight script of interactions and GPU contention from
    // the thumbnail-render queue pushes them past their 60s budget; the
    // tests don't exercise library thumbnails so opting out is correct.
    if (!navigator.webdriver) {
        const enableThumbs = () => library.enableThumbnails()
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(enableThumbs, { timeout: 4000 })
        } else {
            setTimeout(enableThumbs, 2500)
        }
    }

    // Boot complete — wire handfish tooltips (registers hover/focus
    // handlers + migrates any `title=` in static markup over to the
    // [data-title].tooltip convention).
    setupTooltips()

    toast('ready — open settings to enable audio/MIDI')
}

/** Register each Visualize control as a MIDI-learnable target. */
/**
 * Wire the settings drawer's "user effects" section: file-picker
 * import + list-with-per-row-delete. Re-renders the list on every
 * change (whether triggered here, by the share-loader path, or by
 * another tab of the same app via IndexedDB).
 *
 * The manager is also re-bound to the renderer on import so a
 * freshly uploaded effect is callable from DSL immediately, without a
 * reload.
 */
function setupUserEffectsPanel(userEffects, renderer) {
    const importBtn = $('user-effect-import')
    const fileInput = $('user-effect-file')
    const statusEl = $('user-effect-status')
    const listEl = $('user-effect-list')
    if (!importBtn || !fileInput || !listEl) return

    const setStatus = (msg, kind = 'info') => {
        if (!statusEl) return
        statusEl.textContent = msg
        statusEl.dataset.kind = kind
    }

    importBtn.addEventListener('click', () => fileInput.click())

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]
        fileInput.value = ''   // allow re-importing the same file
        if (!file) return
        setStatus(`installing ${file.name}…`, 'busy')
        try {
            const { name } = await userEffects.uploadFromZip(file, renderer)
            setStatus(`installed user/${name}`, 'ok')
        } catch (err) {
            const msg = err?.message || String(err)
            setStatus(`import failed: ${msg}`, 'error')
            console.error('[userEffects] upload error:', err)
        }
    })

    const renderList = async () => {
        const installed = await userEffects.listInstalled()
        listEl.innerHTML = ''
        if (installed.length === 0) {
            const empty = document.createElement('p')
            empty.className = 'settings-hint user-effect-empty'
            empty.textContent = 'no user effects installed yet'
            listEl.appendChild(empty)
            return
        }
        for (const eff of installed) {
            const row = document.createElement('div')
            row.className = 'user-effect-row'
            row.dataset.id = eff.id

            const label = document.createElement('span')
            label.className = 'user-effect-name'
            label.textContent = eff.id
            row.appendChild(label)

            const stamp = document.createElement('span')
            stamp.className = 'user-effect-date'
            const d = new Date(eff.uploadedAt)
            stamp.textContent = d.toLocaleDateString()
            row.appendChild(stamp)

            const del = document.createElement('button')
            del.className = 'ghost-button user-effect-delete'
            del.textContent = 'delete'
            del.addEventListener('click', async () => {
                if (!confirm(`Delete ${eff.id}? Programs that reference it will fail to compile until reinstall.`)) return
                try {
                    await userEffects.deleteEffect(eff.id)
                    setStatus(`deleted ${eff.id} — reload to fully purge from this session`, 'ok')
                } catch (err) {
                    setStatus(`delete failed: ${err?.message || err}`, 'error')
                }
            })
            row.appendChild(del)
            listEl.appendChild(row)
        }
    }

    userEffects.onChange(renderList)
    renderList().catch(err => console.error('[userEffects] initial list:', err))
}

function registerMidiControls(midi, controls) {
    midi.registerControl('crossfader', { label: 'crossfader', kind: 'continuous', handler: controls.crossfader, getValue: controls.crossfaderValue })
    midi.registerControl('speedA',     { label: 'speed A',    kind: 'continuous', handler: controls.speedA, getValue: controls.speedAValue })
    midi.registerControl('speedB',     { label: 'speed B',    kind: 'continuous', handler: controls.speedB, getValue: controls.speedBValue })
    midi.registerControl('fxStrobe',   { label: 'fx · strobe', kind: 'latch', handler: () => controls.fxToggle('strobe') })
    midi.registerControl('fxInvert',   { label: 'fx · invert', kind: 'latch', handler: () => controls.fxToggle('invert') })
    midi.registerControl('fxBW',       { label: 'fx · b&w',    kind: 'latch', handler: () => controls.fxToggle('bw') })
    midi.registerControl('fxZoom',     { label: 'fx · zoom',   kind: 'latch', handler: () => controls.fxToggle('zoom') })
    midi.registerControl('fxFreeze',   { label: 'fx · freeze', kind: 'latch', handler: () => controls.fxToggle('freeze') })
    midi.registerControl('fxFlash',    { label: 'fx · flash',  kind: 'momentary', handler: () => controls.fxFlash() })
}

function renderLearnRows(rows, midi) {
    const container = $('midi-learn-rows')
    if (!container) return
    container.innerHTML = ''
    renderLearnRows._bars = new Map()   // controlId -> { fill, row }

    for (const row of rows) {
        const div = document.createElement('div')
        div.className = 'midi-learn-row'
        if (row.learning) div.classList.add('learning')
        if (row.conflict) div.classList.add('conflict')

        // Binding text
        let bindingText
        if (row.capturing) {
            bindingText = `CC ${row.cc} · ch ${row.ch + 1} — wiggle through range…`
        } else if (row.kind === 'note' && row.note != null) {
            bindingText = `note ${row.note} · ch ${row.ch + 1}`
        } else if (row.kind === 'cc' && row.cc != null) {
            const rangeText = (row.min != null && row.max != null && (row.min !== 0 || row.max !== 127))
                ? ` (${row.min}-${row.max})` : ''
            bindingText = `CC ${row.cc} · ch ${row.ch + 1}${rangeText}${row.invert ? ' ⇄' : ''}`
        } else {
            bindingText = row.learning ? 'move a knob or pad…' : 'unassigned'
        }

        const target = document.createElement('span')
        target.className = 'ml-target'
        target.textContent = row.label

        const binding = document.createElement('span')
        binding.className = 'ml-cc'
        binding.textContent = bindingText
        if (row.cc == null && row.note == null) binding.style.opacity = '0.5'

        // Live value bar
        const barCell = document.createElement('span')
        barCell.className = 'ml-bar-cell'
        const bar = document.createElement('span')
        bar.className = 'ml-bar'
        const fill = document.createElement('span')
        fill.className = 'ml-bar-fill'
        const dir = document.createElement('span')
        dir.className = 'ml-bar-dir'
        bar.appendChild(fill)
        barCell.appendChild(bar)
        barCell.appendChild(dir)
        renderLearnRows._bars.set(row.controlId, { fill, dir, row: div, prevPickup: false })

        // Conflict badge
        const badge = document.createElement('span')
        badge.className = 'ml-conflict'
        if (row.conflict) {
            badge.textContent = '⚠'
            setTooltip(badge, `shares ${row.conflict.key.replace('cc:', 'CC ').replace('note:', 'note ')} with ${row.conflict.others.join(', ')}`)
        }

        // Actions
        const actions = document.createElement('span')
        actions.className = 'ml-actions'
        if (row.learning) {
            const cancel = document.createElement('button')
            cancel.textContent = '✕'
            setTooltip(cancel, 'cancel learn')
            cancel.addEventListener('click', () => midi.cancelLearn())
            actions.appendChild(cancel)
        } else {
            const learn = document.createElement('button')
            learn.textContent = (row.cc != null || row.note != null) ? '↻' : '◉'
            setTooltip(learn, (row.cc != null || row.note != null) ? 'relearn' : 'learn')
            learn.addEventListener('click', () => midi.startLearn(row.controlId))
            actions.appendChild(learn)
            if (row.cc != null || row.note != null) {
                // Edit (range/invert) — only meaningful for CC bindings
                if (row.kind === 'cc') {
                    const edit = document.createElement('button')
                    edit.textContent = '⋯'
                    setTooltip(edit, 'edit range / invert')
                    edit.addEventListener('click', () => div.classList.toggle('editing'))
                    actions.appendChild(edit)
                }
                const clear = document.createElement('button')
                clear.textContent = '✕'
                setTooltip(clear, 'clear')
                clear.addEventListener('click', () => midi.clearAssignment(row.controlId))
                actions.appendChild(clear)
            }
        }

        div.append(target, binding, barCell, badge, actions)

        // Edit panel (range + invert), hidden until .editing
        if (row.kind === 'cc' && (row.cc != null)) {
            const panel = document.createElement('div')
            panel.className = 'ml-edit-panel'
            const mkNum = (label, val, on) => {
                const wrap = document.createElement('label')
                wrap.className = 'ml-edit-field'
                const span = document.createElement('span')
                span.textContent = label
                const input = document.createElement('input')
                input.type = 'number'; input.min = '0'; input.max = '127'
                input.value = String(val ?? (label === 'min' ? 0 : 127))
                input.addEventListener('change', on)
                wrap.append(span, input)
                return { wrap, input }
            }
            let minVal = row.min ?? 0, maxVal = row.max ?? 127
            const minF = mkNum('min', minVal, () => { minVal = Number(minF.input.value); midi.setRange(row.controlId, minVal, maxVal) })
            const maxF = mkNum('max', maxVal, () => { maxVal = Number(maxF.input.value); midi.setRange(row.controlId, minVal, maxVal) })
            const inv = document.createElement('label')
            inv.className = 'ml-edit-field'
            const invSpan = document.createElement('span'); invSpan.textContent = 'invert'
            const invBox = document.createElement('input'); invBox.type = 'checkbox'; invBox.checked = !!row.invert
            invBox.addEventListener('change', () => midi.setInvert(row.controlId, invBox.checked))
            inv.append(invSpan, invBox)
            panel.append(minF.wrap, maxF.wrap, inv)
            div.appendChild(panel)
        }

        container.appendChild(div)
    }
}

boot().catch((err) => {
    console.error('boot failed', err)
    toast('boot failed — see console')
})
