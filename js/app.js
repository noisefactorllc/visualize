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
import { mountThemePicker } from './handfish-theme.js'
// Pulls handfish's <code-editor> custom element (auto-registers on import)
// plus the DSL syntax tokenizer.
import { dslTokenizer } from 'handfish'
// Injects the polymorphic/noisedeck editor styles (transparent overlay
// with per-segment darkening + syntax colors) and exports the
// enhanceCodeEditor helper for the Cmd/Ctrl+Shift+Enter binding.
import { enhanceCodeEditor } from './ui/codeEditor.js'

const $ = (id) => document.getElementById(id)

const state = {
    decks: { A: null, B: null },
    deckDsl: { A: '', B: '' },        // last loaded DSL (for the editor)
    mainRes: { width: 1280, height: 720 },
    loopDuration: 10,
    preferWebGPU: false,
    crossfade: 0,
    // Per-deck pixel density. `mode='auto'` lets loadProgram choose
    // (drops to 0.5 for compute-heavy DSLs); `mode='manual'` pins to
    // the user's chosen value across loads. `value` is whichever is
    // currently applied to the underlying renderer.
    deckDensity: {
        A: { mode: 'auto', value: 1.0 },
        B: { mode: 'auto', value: 1.0 }
    }
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

async function boot() {
    // Boot overlay stays up while everything below initializes and starts
    // rendering — the user sees the app's first two decks playing
    // (blurred + dimmed by the overlay's backdrop-filter) before they
    // click START SET. The click handler is wired by an inline script in
    // index.html that runs before any module imports; we await its
    // promise at the very end of boot() so a fast click doesn't race the
    // deferred module graph.

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

    // Library
    const library = new Library()
    try {
        await library.load()
    } catch (err) {
        console.error('Library load failed', err)
        toast('failed to load programs.json')
        return
    }

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
    window.__visualize = { audio, midi, decks: state.decks }

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
    const bpmDividerEl = $('bpm-divider')
    const bpmLabelEl = $('bpm-label')
    const mainLoopDerivedEl = $('main-loop-derived')
    const bpmBlockEl = document.querySelector('.bpm-block')
    if (bpmDividerEl) bpmDividerEl.value = String(scheduler.divider)

    function applyLoopFromBpm() {
        const sec = scheduler.barSeconds()
        state.loopDuration = sec
        state.decks.A.setBaseLoopDuration(sec)
        state.decks.B.setBaseLoopDuration(sec)
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
        library, decks: state.decks, compositor, scheduler,
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
        }
    })
    // Drive the AutoMix fade per-frame for smooth interpolation
    // (per-beat would only give ~4 visible steps across a 1-bar fade).
    compositor.onFrame(() => autoMix.tickFrame())

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
        $('record-toggle').title = 'MediaRecorder not supported'
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
        animateXfade(target, 1.5)
    })

    function animateXfade(target, durSec = 1) {
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
            const heavy = isHeavyDsl(program.dsl, deck._renderer.manifest)
            density.value = heavy ? 0.5 : 1.0
        }
        deck.setPixelDensity(density.value)
        updateDensityButton(deckId)

        const res = await deck.load(program.dsl, program.title)
        if (!res.success) {
            toast(`${deckId}: ${res.error.slice(0, 60)}`)
            return
        }
        state.deckDsl[deckId] = program.dsl
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
                if (next.mode === 'auto') {
                    const dsl = state.deckDsl[deckId]
                    const heavy = dsl && isHeavyDsl(dsl, state.decks[deckId]._renderer.manifest)
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

    /**
     * Populate + wire the mixer-effect dropdown (+ per-effect "mode"
     * sub-dropdown for blendMode-style effects). Called from the
     * mixer.init() chain above, after the mixer has compiled its
     * default pipeline.
     */
    function wireMixerPicker(mixer) {
        const sel = $('mixer-effect')
        const modeSel = $('mixer-mode')
        if (!sel || !modeSel) return

        // Populate effect dropdown from the registry
        sel.innerHTML = ''
        for (const m of MIXERS) {
            const opt = document.createElement('option')
            opt.value = m.id
            opt.textContent = m.label
            sel.appendChild(opt)
        }
        sel.value = mixer.currentMixer.id

        function refreshModeDropdown() {
            const m = mixer.currentMixer
            if (!m.modes) {
                modeSel.hidden = true
                modeSel.innerHTML = ''
                return
            }
            modeSel.hidden = false
            modeSel.innerHTML = ''
            for (const mode of m.modes) {
                const opt = document.createElement('option')
                opt.value = mode
                opt.textContent = mode
                modeSel.appendChild(opt)
            }
            modeSel.value = mixer._currentOverrides.mode || m.defaults.mode || m.modes[0]
        }
        refreshModeDropdown()

        function persist() {
            const m = mixer.currentMixer
            const payload = { id: m.id, overrides: { ...mixer._currentOverrides } }
            try { localStorage.setItem('visualize.mixer.v1', JSON.stringify(payload)) } catch {}
        }

        sel.addEventListener('change', async () => {
            await mixer.setMixerEffect(sel.value)
            refreshModeDropdown()
            mixerControlsPanel?.show(mixer.currentMixer.id)
            persist()
        })

        modeSel.addEventListener('change', async () => {
            await mixer.setMixerEffect(mixer.currentMixer.id, { ...mixer._currentOverrides, mode: modeSel.value })
            mixerControlsPanel?.show(mixer.currentMixer.id)
            persist()
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
        mixerControlsPanel = new MixerControls(root, mixer)
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
                    editor.value = state.deckDsl[deckId] || ''
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
                    state.deckDsl[deckId] = dsl
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

    /** Keep an open editor in sync with the deck's currently loaded DSL. */
    function syncDeckEditor(deckId) {
        const deckEl = document.querySelector(`.deck[data-deck="${deckId}"]`)
        const panel = deckEl.querySelector('.deck-editor')
        if (panel.hidden) return
        const editor = deckEl.querySelector('code-editor')
        editor.value = state.deckDsl[deckId] || ''
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

    // Auto-mix toggle
    $('automix-toggle').addEventListener('click', () => {
        const on = autoMix.toggle()
        $('automix-toggle').dataset.state = on ? 'on' : 'off'
    })
    $('automix-bars').addEventListener('change', (e) => {
        autoMix.setBarsPerScene(parseInt(e.target.value, 10))
    })
    $('automix-curve').addEventListener('change', (e) => {
        state.curve = e.target.value
        autoMix.setCurve(e.target.value)
        compositor.setCurve(e.target.value)
    })

    // Record
    $('record-toggle').addEventListener('click', () => recorder.toggle())
    $('output-window').addEventListener('click', () => outputWin.toggle())

    // Fullscreen
    $('fullscreen-toggle').addEventListener('click', () => toggleFullscreen())
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
    function openSettings() {
        drawer.setAttribute('aria-hidden', 'false')
        refreshAudioDevices()
    }
    function closeSettings() { drawer.setAttribute('aria-hidden', 'true') }
    $('settings-toggle').addEventListener('click', () => {
        const open = drawer.getAttribute('aria-hidden') !== 'false'
        if (open) openSettings(); else closeSettings()
    })
    $('settings-close').addEventListener('click', closeSettings)

    async function refreshAudioDevices() {
        const sel = $('audio-device')
        const cur = sel.value
        const devices = await audio.listDevices()
        sel.innerHTML = '<option value="">— pick to enable —</option>'

        // Before mic permission has been granted, Chrome returns devices
        // with empty deviceId + empty label per entry. Rendering those
        // as <option value=""> makes every entry collide with the
        // placeholder above, so the browser silently drops the change
        // event when the user picks one — that's the "selecting a
        // device does nothing" bug. Safari returns an empty list before
        // permission. Either way: fall back to a single sentinel entry
        // that maps to getUserMedia({audio:true}); once permission is
        // granted the next refresh shows real labelled devices.
        const labelled = devices.filter(d => d.label && d.deviceId)
        if (labelled.length > 0) {
            for (const d of labelled) {
                const opt = document.createElement('option')
                opt.value = d.deviceId
                opt.textContent = d.label
                sel.appendChild(opt)
            }
        } else {
            const opt = document.createElement('option')
            opt.value = '__default__'
            opt.textContent = 'Enable audio (default device)'
            sel.appendChild(opt)
        }

        if (audio.enabled && audio.currentDeviceId) {
            sel.value = audio.currentDeviceId
        } else if (cur && [...sel.options].some(o => o.value === cur)) {
            sel.value = cur
        }
    }

    $('audio-device').addEventListener('change', async (e) => {
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
    })
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

    // MIDI learn rows
    registerMidiControls(midi, {
        crossfader: (v01) => {
            state.crossfade = v01
            compositor.setCrossfade(v01)
            xfaderEl.value = String(v01)
        },
        speedA: (v01) => {
            const s = 0.1 + v01 * 3.9
            state.decks.A.setSpeed(s)
            $('speed-a').value = String(s)
            $('speed-a-val').textContent = `${s.toFixed(1)}×`
        },
        speedB: (v01) => {
            const s = 0.1 + v01 * 3.9
            state.decks.B.setSpeed(s)
            $('speed-b').value = String(s)
            $('speed-b-val').textContent = `${s.toFixed(1)}×`
        },
        fxStrobe: (v01) => { if (v01 > 0.5) toggleFx('strobe') },
        fxInvert: (v01) => { if (v01 > 0.5) toggleFx('invert') },
        fxFlash: (v01) => { if (v01 > 0.5) compositor.flash() },
        fxFreeze: (v01) => { if (v01 > 0.5) toggleFx('freeze') }
    })
    midi.onLearnUpdate((rows) => renderLearnRows(rows, midi))
    renderLearnRows(midi.getLearnView(), midi)
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
            })
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
            refreshAudio: () => audio.refreshDeckStates()
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
            del.title = 'delete'
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
    // compositor compositing). Wait for the user to click START SET.
    await window.__visualizeBootGesture

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

    toast('ready — open settings to enable audio/MIDI')
}

/** Register each Visualize control as a MIDI-learnable target. */
function registerMidiControls(midi, controls) {
    midi.registerControl('crossfader', 'crossfader',     controls.crossfader)
    midi.registerControl('speedA',     'speed A',         controls.speedA)
    midi.registerControl('speedB',     'speed B',         controls.speedB)
    midi.registerControl('fxStrobe',   'fx · strobe',     controls.fxStrobe)
    midi.registerControl('fxInvert',   'fx · invert',     controls.fxInvert)
    midi.registerControl('fxFlash',    'fx · flash',      controls.fxFlash)
    midi.registerControl('fxFreeze',   'fx · freeze',     controls.fxFreeze)
}

function renderLearnRows(rows, midi) {
    const container = $('midi-learn-rows')
    if (!container) return
    container.innerHTML = ''
    for (const row of rows) {
        const div = document.createElement('div')
        div.className = 'midi-learn-row'
        if (row.learning) div.classList.add('learning')
        let ccLabel
        if (row.capturing) {
            ccLabel = `<span class="ml-cc">CC ${row.cc} · ch ${row.ch + 1} <span style="opacity:0.7">— wiggle through range…</span></span>`
        } else if (row.cc != null) {
            const rangeText = (row.min != null && row.max != null && (row.min !== 0 || row.max !== 127))
                ? ` (${row.min}-${row.max})`
                : ''
            ccLabel = `<span class="ml-cc">CC ${row.cc} · ch ${row.ch + 1}${rangeText}</span>`
        } else {
            ccLabel = `<span class="ml-cc" style="opacity:0.5">${row.learning ? 'move a knob…' : 'unassigned'}</span>`
        }
        div.innerHTML = `
            <span class="ml-target">${row.label}</span>
            ${ccLabel}
            <span></span>
        `
        const actions = document.createElement('span')
        actions.style.cssText = 'display:flex; gap:4px;'
        if (row.learning) {
            const cancel = document.createElement('button')
            cancel.textContent = '✕'
            cancel.title = 'cancel learn'
            cancel.addEventListener('click', () => midi.cancelLearn())
            actions.appendChild(cancel)
        } else {
            const learn = document.createElement('button')
            learn.textContent = row.cc != null ? '↻' : '◉'
            learn.title = row.cc != null ? 'relearn' : 'learn'
            learn.addEventListener('click', () => midi.startLearn(row.controlId))
            actions.appendChild(learn)
            if (row.cc != null) {
                const clear = document.createElement('button')
                clear.textContent = '✕'
                clear.title = 'clear'
                clear.addEventListener('click', () => midi.clearAssignment(row.controlId))
                actions.appendChild(clear)
            }
        }
        div.appendChild(actions)
        container.appendChild(div)
    }
}

boot().catch((err) => {
    console.error('boot failed', err)
    toast('boot failed — see console')
})
