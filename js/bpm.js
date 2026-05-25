/**
 * BeatScheduler — drives a beat-level callback at the current BPM.
 *
 * Two ways to set tempo:
 *   - manual:    set the BPM directly (UI input or MIDI clock follower)
 *   - tap tempo: tap() repeatedly; rolling average of inter-tap intervals
 *                becomes the BPM
 *
 * Uses setTimeout (not requestAnimationFrame) so beats keep firing when
 * the tab is backgrounded — Chrome throttles rAF to ~1Hz on hidden
 * tabs, which would silently stop AutoMix mid-set. Browsers do still
 * throttle setTimeout to ~1Hz in hidden tabs (since 2020), so on tab
 * focus we detect the gap and re-align phase rather than firing a
 * burst of catch-up beats.
 */

const MIN_BPM = 40
const MAX_BPM = 300

export class BeatScheduler {
    constructor(initialBpm = 120) {
        this._bpm = initialBpm
        this._beatIndex = 0
        this._lastBeatMs = 0
        this._running = false
        this._timeoutId = null
        this._listeners = []
        this._tapTimes = []
        this._tapResetMs = 2000
    }

    get bpm() { return this._bpm }
    set bpm(v) {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0) return
        this._bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, n))
    }

    /** beats per second */
    get bps() { return this._bpm / 60 }
    get beatIntervalMs() { return 60000 / this._bpm }

    onBeat(cb) { this._listeners.push(cb) }

    start() {
        if (this._running) return
        this._running = true
        this._lastBeatMs = performance.now()
        this._scheduleNext()
        // When the tab returns to foreground after being throttled,
        // re-anchor the phase so we don't emit a flurry of "catch-up"
        // beats. The user perceives this as the beat restarting from
        // the moment they tabbed back, which is the right behaviour.
        if (typeof document !== 'undefined') {
            this._visHandler = () => {
                if (!document.hidden && this._running) {
                    this._lastBeatMs = performance.now()
                    if (this._timeoutId) clearTimeout(this._timeoutId)
                    this._scheduleNext()
                }
            }
            document.addEventListener('visibilitychange', this._visHandler)
        }
    }

    stop() {
        this._running = false
        if (this._timeoutId) clearTimeout(this._timeoutId)
        this._timeoutId = null
        if (this._visHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._visHandler)
            this._visHandler = null
        }
    }

    _scheduleNext() {
        if (!this._running) return
        const now = performance.now()
        const nextBeatMs = this._lastBeatMs + this.beatIntervalMs
        const delay = Math.max(0, nextBeatMs - now)
        this._timeoutId = setTimeout(() => {
            if (!this._running) return
            this._lastBeatMs += this.beatIntervalMs
            this._beatIndex++
            this._emit()
            this._scheduleNext()
        }, delay)
    }

    /** Restart phase from this moment (used after tap or BPM change). */
    resetPhase() {
        this._lastBeatMs = performance.now()
        this._beatIndex = 0
    }

    /** Returns fractional beat position 0..1 within the current beat. */
    get beatPhase() {
        const dt = performance.now() - this._lastBeatMs
        return Math.max(0, Math.min(1, dt / this.beatIntervalMs))
    }

    get beatIndex() { return this._beatIndex }
    get beatInBar() { return this._beatIndex % 4 }
    get barIndex() { return Math.floor(this._beatIndex / 4) }

    /**
     * Record a tap; returns the inferred BPM (0 until enough taps).
     */
    tap() {
        const now = performance.now()
        if (this._tapTimes.length > 0 && now - this._tapTimes[this._tapTimes.length - 1] > this._tapResetMs) {
            this._tapTimes = []
        }
        this._tapTimes.push(now)
        if (this._tapTimes.length > 8) this._tapTimes.shift()
        if (this._tapTimes.length < 2) return 0
        const intervals = []
        for (let i = 1; i < this._tapTimes.length; i++) {
            intervals.push(this._tapTimes[i] - this._tapTimes[i - 1])
        }
        const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length
        const bpm = 60000 / avgMs
        if (bpm > MIN_BPM && bpm < MAX_BPM) {
            this.bpm = bpm
            this.resetPhase()
            // Re-anchor the upcoming beat so the user's tap pattern
            // becomes the new phase (otherwise the next beat could fire
            // arbitrarily late if a long interval was already queued).
            if (this._running && this._timeoutId) {
                clearTimeout(this._timeoutId)
                this._scheduleNext()
            }
        }
        return this._bpm
    }

    _emit() {
        const payload = {
            bpm: this._bpm,
            beatIndex: this._beatIndex,
            beatInBar: this.beatInBar,
            barIndex: this.barIndex,
            isDownbeat: this.beatInBar === 0
        }
        for (const cb of this._listeners) {
            try { cb(payload) } catch (err) { console.error(err) }
        }
    }
}
