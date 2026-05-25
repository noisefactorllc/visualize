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
    constructor({ library, decks, compositor, scheduler, getXfade, setXfade, onStatus }) {
        this.library = library
        this.decks = decks
        this.compositor = compositor
        this.scheduler = scheduler
        this.getXfade = getXfade
        this.setXfade = setXfade
        this.onStatus = onStatus || (() => {})

        this._enabled = false
        this._barsPerScene = 8
        this._fadeBars = 4
        this._curve = 'dipped'

        this._lastSwitchBeat = 0
        this._fadeStart = null
        this._fadeStartXfade = 0
        this._fadeTargetXfade = 0
        this._fadeBeats = 0
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
            this._fadeStart = null
            this.onStatus('auto-VJ off', false)
        }
    }

    toggle() {
        this.setEnabled(!this._enabled)
        return this._enabled
    }

    get enabled() { return this._enabled }

    setBarsPerScene(n) { this._barsPerScene = Math.max(1, Number(n) || 8) }
    setFadeBars(n) { this._fadeBars = Math.max(0, Number(n) || 4) }
    setCurve(name) { if (FADE_CURVES[name]) this._curve = name }

    /**
     * Called by the UI whenever the user touches the crossfader.
     * Halts the auto-mix animation but doesn't disable the feature.
     */
    noteUserOverride() {
        this._fadeStart = null
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
     * Called from the compositor's per-frame callback. Uses the
     * scheduler's fractional beat position so the crossfade is smooth
     * instead of stepping once per beat (the old behaviour gave a
     * jerky 4-step fade across a 1-bar transition).
     */
    tickFrame() {
        if (this._fadeStart === null) return
        if (this._isUserOverriding()) return
        const beatsElapsed = (this.scheduler.beatIndex + this.scheduler.beatPhase) - this._fadeStart
        const t = Math.max(0, Math.min(1, beatsElapsed / Math.max(0.0001, this._fadeBeats)))
        const eased = FADE_CURVES[this._curve](t)
        const value = this._fadeStartXfade + (this._fadeTargetXfade - this._fadeStartXfade) * eased
        this.setXfade(value)
        if (t >= 1) this._fadeStart = null
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
        // The currently-live deck keeps playing untouched.
        const incomingDeckId = target > 0.5 ? 'B' : 'A'
        const deck = this.decks[incomingDeckId]
        const exclude = deck?.currentName || ''
        const program = this.library.randomExcept(exclude)
        if (!program) return

        try {
            const res = await deck.load(program.dsl, program.title)
            if (!res.success) {
                console.warn('[AutoMix] failed to load', program.title, res.error)
                return
            }
            this.onStatus(`auto: ${incomingDeckId} ← ${program.title}`, true)
        } catch (err) {
            console.error('[AutoMix] load error', err)
            return
        }

        // Cut-mode: snap immediately
        if (this._curve === 'cut' || this._fadeBars <= 0) {
            this.setXfade(target)
            return
        }

        // Otherwise animate over fadeBars worth of beats. We store the
        // fractional beat position so the per-frame tick can interpolate
        // smoothly even between beat events.
        this._fadeStart = this.scheduler.beatIndex + this.scheduler.beatPhase
        this._fadeStartXfade = current
        this._fadeTargetXfade = target
        this._fadeBeats = Math.max(1, this._fadeBars * 4)
    }
}
