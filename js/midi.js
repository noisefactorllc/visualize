/**
 * SharedMidi — Web MIDI integration for VJ controllers.
 *
 * Three jobs:
 *  1. Route MIDI CC values to registered Visualize controls (crossfader,
 *     deck speeds, main FX). Uses a "learn" workflow so the user
 *     touches a control on the controller to bind it.
 *  2. Forward CC + note state into each deck's midiState bag so DSL
 *     programs using midi() automation also react.
 *  3. Decode MIDI System Real-Time messages (clock + transport) into a
 *     live BPM estimate and transport events that the BPM module can
 *     optionally follow. Mirrors polymorphic's MidiClock: a 24-tick
 *     sliding window smoothed with an EMA, plus start/stop/continue
 *     transport handling and a no-clock watchdog so the UI can show
 *     a meaningful status (no-device / no-clock / synced / stopped).
 *
 * Persists learn assignments to localStorage so a controller stays bound
 * between sessions.
 */

const STORAGE_KEY = 'visualize.midi.learn.v1'

// MIDI System Real-Time. Public so unit tests can pin the constants.
export const MIDI_TICKS_PER_BEAT = 24
const WINDOW_TICKS = 24       // sliding window of one beat
const SMOOTHING_ALPHA = 0.2   // EMA factor for incoming BPM samples
const NO_CLOCK_TIMEOUT_MS = 2000

/** Map a status byte → transport event name (or null for non-transport). */
export function parseMidiStatus(byte) {
    switch (byte) {
        case 0xF8: return 'clock'
        case 0xFA: return 'start'
        case 0xFB: return 'continue'
        case 0xFC: return 'stop'
        default: return null
    }
}

/** BPM derived from a sliding window of clock-tick timestamps (ms). */
export function bpmFromTickIntervals(timestamps) {
    if (!Array.isArray(timestamps) || timestamps.length < 2) return null
    let sum = 0
    for (let i = 1; i < timestamps.length; i++) sum += timestamps[i] - timestamps[i - 1]
    const avgInterval = sum / (timestamps.length - 1)
    if (!Number.isFinite(avgInterval) || avgInterval <= 0) return null
    return 60_000 / (avgInterval * MIDI_TICKS_PER_BEAT)
}

export class SharedMidi {
    constructor() {
        this._access = null
        this._inputs = []
        this._enabled = false
        this._decks = new Set()
        this._midiStates = new Map() // deck -> midiState bag

        // Learn / assignments
        // Each assignment: { ch, cc, min, max }. min/max default to 0/127
        // (full 7-bit MIDI range). During learn we observe the actual
        // range the controller emits so endless encoders, fader banks
        // with limited travel, or unusual controllers map correctly.
        this._assignments = this._loadAssignments()
        this._controlHandlers = new Map() // controlId -> { handler(value01), label }
        this._learningControlId = null
        this._learningCapture = null // { ch, cc, min, max } once first CC arrives
        this._learnWindowMs = 2000   // observe range this long after first CC
        this._learnCommitTimer = null

        this._followClock = false
        // Sliding window of recent clock-tick timestamps (one beat's
        // worth = 24 ticks). EMA smoothing on top absorbs USB jitter
        // without lagging real tempo changes.
        this._tickTimes = []
        this._smoothedBpm = null
        this._lastTickAt = 0
        this._noClockTimer = null
        this._clockStatus = 'no-device'   // no-device | no-clock | synced | stopped

        this._onStatus = null
        this._onLearnUpdate = null
        this._onBpm = null
        this._onTransport = null
        this._onClockStatusChange = null
    }

    onStatusChange(cb) { this._onStatus = cb }
    onLearnUpdate(cb) { this._onLearnUpdate = cb }
    onBpm(cb) { this._onBpm = cb }
    /** Subscribe to MIDI transport events: 'start' | 'stop' | 'continue'. */
    onTransport(cb) { this._onTransport = cb }
    /** Subscribe to MIDI clock status changes. */
    onClockStatus(cb) { this._onClockStatusChange = cb }
    /** Last reported clock status (no-device / no-clock / synced / stopped). */
    get clockStatus() { return this._clockStatus }

    get enabled() { return this._enabled }
    get inputCount() { return this._inputs.length }
    get followClock() { return this._followClock }
    set followClock(v) {
        const next = !!v
        if (next === this._followClock) return
        this._followClock = next
        // Reset estimate so a stale BPM doesn't carry across a toggle.
        this._tickTimes = []
        this._smoothedBpm = null
        if (next && this._enabled) {
            this._setClockStatus(this._inputs.length ? 'no-clock' : 'no-device')
            this._armNoClockWatchdog()
        } else if (!next) {
            this._clearNoClockWatchdog()
            this._setClockStatus(this._enabled && this._inputs.length ? 'no-clock' : 'no-device')
        }
    }

    get assignments() {
        return Object.fromEntries(Object.entries(this._assignments))
    }

    addDeck(deck) {
        this._decks.add(deck)
        const state = deck.ensureMidiState()
        if (state) this._midiStates.set(deck, state)
    }

    /**
     * Register a control the user can MIDI-learn.
     *   controlId: stable string used as the storage key
     *   label:     human label for the UI
     *   handler:   called as (value01) when a bound CC fires
     */
    registerControl(controlId, label, handler) {
        this._controlHandlers.set(controlId, { handler, label })
    }

    /** Begin learning the next CC for the given control. */
    startLearn(controlId) {
        this._learningControlId = controlId
        this._learningCapture = null
        if (this._learnCommitTimer) {
            clearTimeout(this._learnCommitTimer)
            this._learnCommitTimer = null
        }
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    cancelLearn() {
        this._learningControlId = null
        this._learningCapture = null
        if (this._learnCommitTimer) {
            clearTimeout(this._learnCommitTimer)
            this._learnCommitTimer = null
        }
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    clearAssignment(controlId) {
        delete this._assignments[controlId]
        this._saveAssignments()
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    clearAllAssignments() {
        this._assignments = {}
        this._saveAssignments()
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    async enable() {
        if (this._enabled) return true
        if (!navigator.requestMIDIAccess) {
            this._notify('Web MIDI unsupported in this browser')
            return false
        }
        try {
            this._access = await navigator.requestMIDIAccess({ sysex: false })
        } catch (err) {
            this._notify(`MIDI access denied: ${err?.message || err}`)
            return false
        }
        this._attachInputs()
        this._access.onstatechange = () => {
            this._attachInputs()
            this._notify(`MIDI: ${this._inputs.length} input(s)`)
        }
        this._enabled = true
        this._notify(`MIDI: ${this._inputs.length} input(s)`)
        if (this._followClock) {
            this._setClockStatus(this._inputs.length ? 'no-clock' : 'no-device')
            this._armNoClockWatchdog()
        }
        return true
    }

    /** Toggle on/off — disable just detaches listeners; access stays. */
    async toggle() {
        if (!this._enabled) return this.enable()
        this._detachInputs()
        this._enabled = false
        this._tickTimes = []
        this._smoothedBpm = null
        this._clearNoClockWatchdog()
        this._setClockStatus('no-device')
        this._notify('MIDI off')
        return false
    }

    /**
     * (Re)attach midimessage listeners to current inputs without leaking
     * subscriptions across hot-plug events. Uses addEventListener so we
     * coexist with anything else listening on the same input (matches
     * polymorphic's defensive attach pattern).
     */
    _attachInputs() {
        if (!this._access) return
        const next = Array.from(this._access.inputs.values())
        const seen = new Set(next)
        // Remove listeners for inputs that disappeared
        this._inputs = this._inputs.filter(({ input, listener }) => {
            if (seen.has(input)) return true
            try { input.removeEventListener('midimessage', listener) } catch { /* ignore */ }
            return false
        })
        // Attach to any new inputs
        const known = new Set(this._inputs.map(e => e.input))
        for (const input of next) {
            if (known.has(input)) continue
            const listener = (event) => this._onMessage(event)
            input.addEventListener('midimessage', listener)
            if (input.connection !== 'open') {
                try { input.open() } catch { /* ignore */ }
            }
            this._inputs.push({ input, listener })
        }
    }

    _detachInputs() {
        for (const { input, listener } of this._inputs) {
            try { input.removeEventListener('midimessage', listener) } catch { /* ignore */ }
        }
        this._inputs = []
    }

    _onMessage(msg) {
        const data = msg.data
        if (!data || data.length < 1) return
        const status = data[0] & 0xF0
        const channel = data[0] & 0x0F

        // System Real-Time (clock + transport)
        const transport = parseMidiStatus(data[0])
        if (transport === 'clock') {
            this._onClockTick()
            return
        }
        if (transport) {
            this._onTransportMsg(transport)
            return
        }

        // CC
        if (status === 0xB0) {
            const cc = data[1]
            const value = data[2]

            // Learn capture — first CC seen locks ch+cc; we then keep
            // tracking min/max for _learnWindowMs so the user can wiggle
            // the control through its full range.
            if (this._learningControlId) {
                if (!this._learningCapture) {
                    this._learningCapture = { ch: channel, cc, min: value, max: value }
                    this._learnCommitTimer = setTimeout(() => this._commitLearn(), this._learnWindowMs)
                } else if (this._learningCapture.ch === channel && this._learningCapture.cc === cc) {
                    if (value < this._learningCapture.min) this._learningCapture.min = value
                    if (value > this._learningCapture.max) this._learningCapture.max = value
                }
                // Don't dispatch while learning to avoid bound controls firing on
                // the same CC we're capturing.
                return
            }

            // Dispatch to bound control(s), normalising into the
            // assigned min/max range. Defaults to 0..127 for assignments
            // saved before range-learn existed.
            for (const [controlId, asg] of Object.entries(this._assignments)) {
                if (asg.ch === channel && asg.cc === cc) {
                    const min = asg.min ?? 0
                    const max = asg.max ?? 127
                    const span = Math.max(1, max - min)
                    const value01 = Math.max(0, Math.min(1, (value - min) / span))
                    const handler = this._controlHandlers.get(controlId)?.handler
                    if (handler) handler(value01)
                }
            }

            // Mirror into each deck's midiState (use raw 0..1 scaling
            // here — the noisemaker midi() automation does its own
            // mapping with min/max args)
            const raw01 = value / 127
            for (const state of this._midiStates.values()) {
                this._writeCcIntoMidiState(state, channel, cc, raw01)
            }
        }

        // Note on/off — mirror into midiState
        if (status === 0x90 || status === 0x80) {
            const note = data[1]
            const velocity = (status === 0x90 ? data[2] : 0) / 127
            for (const state of this._midiStates.values()) {
                this._writeNoteIntoMidiState(state, channel, note, velocity)
            }
        }
    }

    _writeCcIntoMidiState(state, channel, cc, value01) {
        if (!state) return
        const channels = state._channels || state.channels
        if (channels) {
            const ch = channels[channel] || channels[String(channel)]
            if (ch) {
                const ccBag = ch._cc || ch.cc
                if (ccBag) ccBag[cc] = value01
            }
        }
        // Some bundle versions expose setCc()
        if (typeof state.setCc === 'function') {
            state.setCc(channel, cc, value01)
        }
    }

    _writeNoteIntoMidiState(state, channel, note, velocity01) {
        if (!state) return
        if (typeof state.setNote === 'function') {
            state.setNote(channel, note, velocity01)
        }
        const channels = state._channels || state.channels
        if (channels) {
            const ch = channels[channel] || channels[String(channel)]
            if (ch) {
                const notes = ch._notes || ch.notes
                if (notes) notes[note] = velocity01
            }
        }
    }

    _commitLearn() {
        if (!this._learningControlId || !this._learningCapture) return
        const id = this._learningControlId
        const cap = this._learningCapture
        // If the user only nudged a single value (min === max), keep the
        // 0..127 default so the bound control still gets the full range
        // available later.
        const min = cap.min < cap.max ? cap.min : 0
        const max = cap.max > cap.min ? cap.max : 127
        this._assignments[id] = { ch: cap.ch, cc: cap.cc, min, max }
        this._learningControlId = null
        this._learningCapture = null
        if (this._learnCommitTimer) {
            clearTimeout(this._learnCommitTimer)
            this._learnCommitTimer = null
        }
        this._saveAssignments()
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
        this._notify(`learned: ${id} ← CC ${cap.cc} ch ${cap.ch + 1} (${min}-${max})`)
    }

    /**
     * MIDI clock is 24 PPQN. Keep a sliding 24-tick window of
     * timestamps; each tick refines the instant BPM. An EMA on top of
     * that absorbs USB jitter (DAWs are particularly noisy) without
     * adding the latency of a fixed sample buffer.
     */
    _onClockTick() {
        if (!this._followClock) return
        const now = performance.now()
        this._lastTickAt = now
        this._tickTimes.push(now)
        if (this._tickTimes.length > WINDOW_TICKS) this._tickTimes.shift()
        const raw = bpmFromTickIntervals(this._tickTimes)
        if (raw == null || !Number.isFinite(raw) || raw < 20 || raw > 400) return
        this._smoothedBpm = this._smoothedBpm == null
            ? raw
            : this._smoothedBpm + SMOOTHING_ALPHA * (raw - this._smoothedBpm)
        if (this._clockStatus !== 'synced') this._setClockStatus('synced')
        this._armNoClockWatchdog()
        if (this._onBpm) this._onBpm(this._smoothedBpm)
    }

    _onTransportMsg(kind) {
        if (this._onTransport) this._onTransport(kind)
        if (!this._followClock) return
        if (kind === 'stop') {
            this._tickTimes = []
            this._setClockStatus('stopped')
            this._clearNoClockWatchdog()
        } else if (kind === 'start' || kind === 'continue') {
            // Reset the window so post-transport BPM derives from new ticks.
            this._tickTimes = []
            this._smoothedBpm = null
            this._setClockStatus('no-clock')
            this._armNoClockWatchdog()
        }
    }

    _armNoClockWatchdog() {
        this._clearNoClockWatchdog()
        this._noClockTimer = setTimeout(() => {
            this._noClockTimer = null
            if (!this._enabled || !this._followClock) return
            if (this._clockStatus === 'stopped') return  // stop is intentional
            if (performance.now() - this._lastTickAt >= NO_CLOCK_TIMEOUT_MS) {
                this._setClockStatus(this._inputs.length ? 'no-clock' : 'no-device')
            }
        }, NO_CLOCK_TIMEOUT_MS + 50)
    }

    _clearNoClockWatchdog() {
        if (this._noClockTimer) {
            clearTimeout(this._noClockTimer)
            this._noClockTimer = null
        }
    }

    _setClockStatus(status) {
        if (this._clockStatus === status) return
        this._clockStatus = status
        if (this._onClockStatusChange) this._onClockStatusChange(status)
    }

    getLearnView() {
        const rows = []
        for (const [controlId, info] of this._controlHandlers.entries()) {
            const asg = this._assignments[controlId]
            rows.push({
                controlId,
                label: info.label,
                ch: asg?.ch,
                cc: asg?.cc,
                min: asg?.min,
                max: asg?.max,
                learning: this._learningControlId === controlId,
                capturing: this._learningControlId === controlId && !!this._learningCapture
            })
        }
        return rows
    }

    _loadAssignments() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            return raw ? JSON.parse(raw) : {}
        } catch {
            return {}
        }
    }

    _saveAssignments() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._assignments))
        } catch {}
    }

    _notify(msg) {
        if (this._onStatus) this._onStatus(msg, this._enabled)
    }
}
