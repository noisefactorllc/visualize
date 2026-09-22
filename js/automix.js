/**
 * AutoMix — automated VJ mode.
 *
 * Listens for downbeats on the BeatScheduler. Every `barsPerScene` bars
 * (a "bar" = 4 beats) it:
 *   1. picks a fresh random program from the library
 *   2. loads it into the deck that is currently NOT live (so the
 *      crossfader can move toward it without a visible jump)
 *   3. animates the crossfader from the current value to the opposite
 *      side over `fadeBars` bars
 *
 * The user can still grab the crossfader at any time — auto-mix only
 * animates while no manual interaction is in progress.
 */

export const MIN_BARS_PER_SCENE = 1
export const MAX_BARS_PER_SCENE = 128
export const DEFAULT_BARS_PER_SCENE = 8

/**
 * Validates and clamps an Auto-VJ bar count input.
 * - Rejects non-finite, null, undefined, empty, or boolean values (falling back to fallback or DEFAULT_BARS_PER_SCENE: 8)
 * - Rejects zero and negative values, clamping strictly to a safe minimum of MIN_BARS_PER_SCENE (1 bar)
 * - Clamps upper bound to MAX_BARS_PER_SCENE (128 bars)
 * - Quantizes to integer (Math.round)
 *
 * @param {any} val - Input bar count (number, string, etc.)
 * @param {number} [fallback=DEFAULT_BARS_PER_SCENE] - Fallback value if input is invalid
 * @returns {number} Integer bar count in [1, 128]
 */
export function clampBarsPerScene(val, fallback = DEFAULT_BARS_PER_SCENE) {
    if (
        val == null ||
        typeof val === 'boolean' ||
        (typeof val === 'string' && val.trim() === '') ||
        (typeof val !== 'number' && typeof val !== 'string')
    ) {
        const fb = Number(fallback)
        return Number.isFinite(fb) ? clampBarsPerScene(fb, DEFAULT_BARS_PER_SCENE) : DEFAULT_BARS_PER_SCENE
    }
    const num = Number(val)
    if (!Number.isFinite(num)) {
        const fb = Number(fallback)
        return Number.isFinite(fb) ? clampBarsPerScene(fb, DEFAULT_BARS_PER_SCENE) : DEFAULT_BARS_PER_SCENE
    }
    const rounded = Math.round(num)
    return Math.max(MIN_BARS_PER_SCENE, Math.min(MAX_BARS_PER_SCENE, rounded))
}

const FADE_CURVES = {
    linear: (x) => x,
    dipped: (x) => 0.5 - 0.5 * Math.cos(x * Math.PI),
    sharp: (x) => x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x),
    cut: (x) => x < 1 ? 0 : 1
}

export class AutoMix {
    constructor({ library, decks, compositor, scheduler, getXfade, setXfade, onStatus, onLoad, rebind, audio, midi }) {
        this.library = library
        this.decks = decks
        this.compositor = compositor
        this.scheduler = scheduler
        this.getXfade = getXfade
        this.setXfade = setXfade
        this.onStatus = onStatus || (() => {})
        // Invoked after a successful swap so the UI can refresh deck
        // labels / tagline / audio routing. AutoMix only knows about
        // decks, not DOM.
        this.onLoad = onLoad || (() => {})
        // Optional rebind module. When present, _triggerSceneSwap fires
        // a fresh rebind on the just-loaded deck so each scene swap
        // also shuffles param bindings.
        this.rebind = rebind || null
        // Optional audio + midi singletons. AutoMix reads `.enabled` to
        // pick which rebind path to run (rebindEq when audio is live,
        // rebindMidi when MIDI is live, oscillator-only fallback when
        // neither is — so the deck always animates).
        this.audio = audio || null
        this.midi = midi || null

        this._enabled = false
        this._barsPerScene = DEFAULT_BARS_PER_SCENE
        this._fadeDurSec = 3        // wall-clock seconds (shared with the manual auto-fade button)
        this._curve = 'dipped'
        // Default on — auto-VJ exists to keep the visual moving, and
        // a fresh rebind on each load is the simplest way to keep it
        // really moving. Operator can flip it off via setAutoRebindEq.
        this._autoRebindEq = true

        this._lastSwitchBeat = 0
        this._fadeStartMs = null
        this._fadeStartXfade = 0
        this._fadeTargetXfade = 0
        this._userOverride = false
        this._userOverrideUntil = 0
        this._swapGeneration = 0
        this._incomingDeck = null
        this._incomingDeckId = null

        this.scheduler.onBeat((b) => this._onBeat(b))
    }

    /**
     * Cancels any in-flight scene swap or pending deck compilation.
     * Called when initiating a fast crossfade (user override, cut,
     * auto-fade, disabling auto-VJ, or triggering a new swap).
     */
    cancelInFlightSwap() {
        this._swapGeneration = (this._swapGeneration || 0) + 1
        this._fadeStartMs = null
        if (this._incomingDeck && typeof this._incomingDeck.cancelPending === 'function') {
            this._incomingDeck.cancelPending()
        }
        this._incomingDeck = null
        this._incomingDeckId = null
    }

    setEnabled(v) {
        this._enabled = !!v
        if (this._enabled) {
            this._lastSwitchBeat = this.scheduler.beatIndex
            this.onStatus('auto-VJ ON', true)
        } else {
            this.cancelInFlightSwap()
            this.onStatus('auto-VJ off', false)
        }
    }

    toggle() {
        this.setEnabled(!this._enabled)
        return this._enabled
    }

    get enabled() { return this._enabled }

    setBarsPerScene(n) {
        this._barsPerScene = clampBarsPerScene(n, this._barsPerScene || DEFAULT_BARS_PER_SCENE)
    }
    get barsPerScene() { return this._barsPerScene }
    setFadeDurationSec(s) { this._fadeDurSec = Math.max(0, Number(s) || 0) }
    get fadeDurationSec() { return this._fadeDurSec }
    setCurve(name) { if (FADE_CURVES[name]) this._curve = name }
    get curve() { return this._curve }
    setAutoRebindEq(v) { this._autoRebindEq = !!v }
    get autoRebindEq() { return this._autoRebindEq }

    /**
     * Called by the UI whenever the user touches the crossfader
     * or initiates a manual cut or auto-fade.
     * Cancels any in-flight auto-mix swap/compilation and halts
     * the auto-mix animation without disabling the feature.
     */
    noteUserOverride() {
        this.cancelInFlightSwap()
        this._userOverride = true
        this._userOverrideUntil = performance.now() + 1500
    }

    _onBeat(b) {
        if (!this._enabled) return
        if (!b.isDownbeat) return
        // The beat counter can reset to ~0 mid-set — tap tempo, a BPM change,
        // a phase nudge, and MIDI-clock START all call BeatScheduler
        // resetPhase()/setPhaseOffset(). Without this, beatsSinceSwitch would
        // go negative and auto-VJ would freeze on the current scene until
        // beatIndex climbed back past the now-stale _lastSwitchBeat. Treat a
        // reset as the start of a fresh interval.
        if (b.beatIndex < this._lastSwitchBeat) this._lastSwitchBeat = b.beatIndex
        const beatsSinceSwitch = b.beatIndex - this._lastSwitchBeat
        const barsSinceSwitch = beatsSinceSwitch / 4
        if (barsSinceSwitch >= this._barsPerScene) {
            this._triggerSceneSwap(b)
            this._lastSwitchBeat = b.beatIndex
        }
    }

    /**
     * Called from the compositor's per-frame callback. Wall-clock
     * timed (the fade duration is in seconds, set by the user via
     * the fade-duration slider in the mixer-controls panel) rather
     * than beat-locked.
     */
    tickFrame() {
        if (this._fadeStartMs === null) return
        if (this._isUserOverriding()) return
        const elapsed = (performance.now() - this._fadeStartMs) / 1000
        const t = Math.max(0, Math.min(1, elapsed / Math.max(0.0001, this._fadeDurSec)))
        const eased = FADE_CURVES[this._curve](t)
        const value = this._fadeStartXfade + (this._fadeTargetXfade - this._fadeStartXfade) * eased
        this.setXfade(value)
        if (t >= 1) {
            this._fadeStartMs = null
            this._incomingDeck = null
            this._incomingDeckId = null
        }
    }

    _isUserOverriding() {
        return this._userOverride && performance.now() < this._userOverrideUntil
    }

    async _triggerSceneSwap(b) {
        // If a swap or compilation is already in flight, cancel it before
        // initiating a new one (crucial for fast Auto-Mix cadences).
        this.cancelInFlightSwap()
        const generation = this._swapGeneration

        const current = this.getXfade()
        // Target the opposite side of the crossfader
        const target = current < 0.5 ? 1 : 0
        // Load a fresh program into the INCOMING deck (the side the
        // fade is moving TOWARD) so we hear the change as we cross over.
        // The currently-live deck keeps playing untouched. Exclude BOTH
        // decks' current programs so A and B never end up identical (a
        // crossfade between two identical visuals is a non-event).
        const incomingDeckId = target > 0.5 ? 'B' : 'A'
        const otherDeckId = incomingDeckId === 'A' ? 'B' : 'A'
        const deck = this.decks[incomingDeckId]
        const exclude = [deck?.currentName, this.decks[otherDeckId]?.currentName]
        const program = this.library.randomExcept(exclude)
        if (!program) return

        this._incomingDeck = deck
        this._incomingDeckId = incomingDeckId

        const clearIncoming = () => {
            if (generation === this._swapGeneration) {
                this._incomingDeck = null
                this._incomingDeckId = null
            }
        }

        try {
            const res = await deck.load(program.dsl, program.title)
            if (res.superseded || generation !== this._swapGeneration) {
                clearIncoming()
                return
            }
            if (!res.success) {
                console.warn('[AutoMix] failed to load', program.title, res.error)
                clearIncoming()
                return
            }

            // State can change during the async load: the operator may have
            // switched auto-VJ off or grabbed the crossfader or initiated a fast crossfade.
            if (!this._enabled || this._isUserOverriding() || generation !== this._swapGeneration) {
                clearIncoming()
                return
            }

            this.onStatus(`auto: ${incomingDeckId} ← ${program.title}`, true)
            this.onLoad(incomingDeckId, program)
            // Auto-rebind on the freshly-loaded deck so the binding
            // mapping shuffles every scene change, not just the
            // program. Failures are non-fatal — keep the swap going.
            // Skip for util programs (camera, media, solid, scope,
            // spectrum, roll) — they're for direct operator control.
            // Pick the same rebind path the operator would click:
            //   audio enabled       → rebindEq (audio bands + osc mix)
            //   midi enabled        → rebindMidi (channels + osc mix)
            //   neither             → rebindEq forced all-osc so the
            //                          deck animates instead of being
            //                          left with silent audio bindings
            const isUtil = program?.tags?.includes('util')
            if (this._autoRebindEq && this.rebind && !isUtil) {
                try {
                    const audioOn = !!this.audio?.enabled
                    const midiOn = !!this.midi?.enabled
                    if (audioOn) {
                        this.rebind.rebindEq(deck, program)
                    } else if (midiOn) {
                        this.rebind.rebindMidi(deck)
                    } else {
                        this.rebind.rebindEq(deck, program, { oscillatorCount: 4 })
                    }
                } catch (err) {
                    console.warn('[AutoMix] auto-rebind failed', err)
                }
            }
        } catch (err) {
            console.error('[AutoMix] load error', err)
            clearIncoming()
            return
        }

        // Final check before moving the crossfader
        if (!this._enabled || this._isUserOverriding() || generation !== this._swapGeneration) {
            clearIncoming()
            return
        }

        // Cut-mode: snap immediately
        if (this._curve === 'cut' || this._fadeDurSec <= 0) {
            this.setXfade(target)
            clearIncoming()
            return
        }

        // Otherwise animate over the configured fade duration in
        // seconds; tickFrame() reads wall-clock elapsed and applies
        // the easing curve.
        this._fadeStartMs = performance.now()
        this._fadeStartXfade = this.getXfade()
        this._fadeTargetXfade = target
    }
}
