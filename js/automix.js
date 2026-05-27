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

const FADE_CURVES = {
    linear: (x) => x,
    dipped: (x) => 0.5 - 0.5 * Math.cos(x * Math.PI),
    sharp: (x) => x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x),
    cut: (x) => x < 1 ? 0 : 1
}

export class AutoMix {
    constructor({ library, decks, compositor, scheduler, getXfade, setXfade, onStatus, onLoad, rebind }) {
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
        // a fresh rebindEq() on the just-loaded deck so each scene swap
        // also shuffles which params are audio-driven.
        this.rebind = rebind || null

        this._enabled = false
        this._barsPerScene = 8
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

        this.scheduler.onBeat((b) => this._onBeat(b))
    }

    setEnabled(v) {
        this._enabled = !!v
        if (this._enabled) {
            this._lastSwitchBeat = this.scheduler.beatIndex
            this.onStatus('auto-VJ ON', true)
        } else {
            this._fadeStartMs = null
            this.onStatus('auto-VJ off', false)
        }
    }

    toggle() {
        this.setEnabled(!this._enabled)
        return this._enabled
    }

    get enabled() { return this._enabled }

    setBarsPerScene(n) { this._barsPerScene = Math.max(1, Number(n) || 8) }
    setFadeDurationSec(s) { this._fadeDurSec = Math.max(0, Number(s) || 0) }
    setCurve(name) { if (FADE_CURVES[name]) this._curve = name }
    setAutoRebindEq(v) { this._autoRebindEq = !!v }
    get autoRebindEq() { return this._autoRebindEq }

    /**
     * Called by the UI whenever the user touches the crossfader.
     * Halts the auto-mix animation but doesn't disable the feature.
     */
    noteUserOverride() {
        this._fadeStartMs = null
        this._userOverride = true
        this._userOverrideUntil = performance.now() + 1500
    }

    _onBeat(b) {
        if (!this._enabled) return
        if (!b.isDownbeat) return
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
        if (t >= 1) this._fadeStartMs = null
    }

    _isUserOverriding() {
        return this._userOverride && performance.now() < this._userOverrideUntil
    }

    async _triggerSceneSwap(b) {
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

        try {
            const res = await deck.load(program.dsl, program.title)
            if (!res.success) {
                console.warn('[AutoMix] failed to load', program.title, res.error)
                return
            }
            this.onStatus(`auto: ${incomingDeckId} ← ${program.title}`, true)
            this.onLoad(incomingDeckId, program)
            // Auto-rebind on the freshly-loaded deck so the audio
            // mapping shuffles every scene change, not just the
            // program. Failures are non-fatal — keep the swap going.
            // Skip for util programs (camera, media, solid, scope,
            // spectrum, roll) — they're for direct operator control.
            const isUtil = program?.tags?.includes('util')
            if (this._autoRebindEq && this.rebind && !isUtil) {
                try {
                    this.rebind.rebindEq(deck, program)
                } catch (err) {
                    console.warn('[AutoMix] auto-rebind failed', err)
                }
            }
        } catch (err) {
            console.error('[AutoMix] load error', err)
            return
        }

        // Cut-mode: snap immediately
        if (this._curve === 'cut' || this._fadeDurSec <= 0) {
            this.setXfade(target)
            return
        }

        // Otherwise animate over the configured fade duration in
        // seconds; tickFrame() reads wall-clock elapsed and applies
        // the easing curve.
        this._fadeStartMs = performance.now()
        this._fadeStartXfade = current
        this._fadeTargetXfade = target
    }
}
