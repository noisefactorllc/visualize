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
const PICKUP_EPS = 0.02   // soft-takeover catch tolerance (0..1)

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

/**
 * Normalize a raw 0..127 controller value into 0..1 across [min,max],
 * with optional inversion. min===max is guarded (span >= 1) so a
 * degenerate range never divides by zero. Result is clamped to 0..1.
 */
export function normalizeCcValue(raw, min = 0, max = 127, invert = false) {
    const lo = Math.min(min, max)
    const hi = Math.max(min, max)
    const span = Math.max(1, hi - lo)
    let v = (raw - lo) / span
    v = Math.max(0, Math.min(1, v))
    return invert ? 1 - v : v
}

/**
 * Rising-edge detector for latch/momentary controls. `fire` is true only
 * on the off→on transition, so a fader held above threshold (or jittering)
 * toggles exactly once; crossing back below re-arms it.
 */
export function computeEdgeToggle(prevOn, on) {
    return { fire: !!on && !prevOn, nextOn: !!on }
}

/**
 * Soft-takeover (pickup). Decides whether an incoming continuous value
 * may drive the control yet, so a physical fader whose position diverged
 * from software (after a scene recall, auto-xfade, cut or nudge) does not
 * jump. The control "catches" when the incoming value passes through (or
 * lands within eps of) the current software value.
 *   engaged  - already driving
 *   armSide  - side of `current` recorded when armed (-1 | 1 | null)
 *   incoming - normalized 0..1 from hardware
 *   current  - control's current software value 0..1
 *   eps      - catch tolerance
 */
export function computePickup({ engaged, armSide, incoming, current, eps = 0.02 }) {
    if (engaged) return { engaged: true, apply: true, value: incoming, armSide: null }
    if (Math.abs(incoming - current) <= eps) {
        return { engaged: true, apply: true, value: incoming, armSide: null }
    }
    const side = incoming > current ? 1 : -1
    if (armSide == null) return { engaged: false, apply: false, value: null, armSide: side }
    if (side !== armSide) return { engaged: true, apply: true, value: incoming, armSide: null }
    return { engaged: false, apply: false, value: null, armSide }
}

/**
 * Detect CC/note collisions. Returns an object keyed by controlId for
 * every control that shares its (kind, channel, cc|note) with at least
 * one other control: { key, others: [controlId, ...] }. Dispatch still
 * fires all matches; the UI uses this only to badge the rows.
 */
export function findConflicts(assignments) {
    const byKey = new Map()
    for (const [id, a] of Object.entries(assignments || {})) {
        if (!a || a.ch == null) continue
        const kind = a.kind || 'cc'
        const num = kind === 'note' ? a.note : a.cc
        if (num == null) continue
        const key = `${kind}:${a.ch}:${num}`
        if (!byKey.has(key)) byKey.set(key, [])
        byKey.get(key).push(id)
    }
    const out = {}
    for (const [key, ids] of byKey) {
        if (ids.length < 2) continue
        for (const id of ids) out[id] = { key, others: ids.filter(x => x !== id) }
    }
    return out
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
        // controlId -> { prevOn, engaged, armSide, lastWritten } runtime
        // state for edge detection (latch/momentary) and pickup (continuous).
        this._controlRuntime = new Map()
        this._onControlActivity = null
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

        // Track the most recent CC value (0..1) per MIDI channel. Used
        // by Auto-Mix's MIDI source picker — "whichever knob the user
        // just touched on this channel" drives the fader.
        this._lastCcByChannel = new Map()
        this._lastCcListeners = []
    }

    /** Subscribe to every CC arrival. Callback fires (channel, value01). */
    onLastCcChange(cb) { this._lastCcListeners.push(cb) }

    /** Synchronous: most recent CC value on a channel, or null if none. */
    lastCcOnChannel(channel) {
        return this._lastCcByChannel.has(channel)
            ? this._lastCcByChannel.get(channel)
            : null
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
     * Register a learnable control.
     *   controlId: stable storage key
     *   opts: { label, kind, handler, getValue }
     *     kind 'continuous' → handler(value01); getValue()→0..1 enables takeover
     *     kind 'latch'      → handler() once per rising edge (caller toggles)
     *     kind 'momentary'  → handler() once per press
     * Legacy (controlId, label, handler) is still accepted (continuous).
     */
    registerControl(controlId, opts, legacyHandler) {
        let info
        if (typeof opts === 'string') {
            info = { label: opts, kind: 'continuous', handler: legacyHandler, getValue: null }
        } else {
            info = {
                label: opts.label,
                kind: opts.kind || 'continuous',
                handler: opts.handler,
                getValue: typeof opts.getValue === 'function' ? opts.getValue : null,
            }
        }
        this._controlHandlers.set(controlId, info)
        this._controlRuntime.set(controlId, { prevOn: false, engaged: false, armSide: null, lastWritten: null })
    }

    /** Subscribe to per-control activity: cb(controlId, { value01, engaged, pickup }). */
    onControlActivity(cb) { this._onControlActivity = cb }

    _fireActivity(controlId, payload) {
        if (this._onControlActivity) this._onControlActivity(controlId, payload)
    }

    _resetRuntime(controlId) {
        this._controlRuntime.set(controlId, { prevOn: false, engaged: false, armSide: null, lastWritten: null })
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
            // Ignore hot-plug churn while disabled — toggle()'s disable path
            // leaves this handler installed (access stays open), and
            // re-attaching here would resurrect MIDI processing behind a UI
            // that still reads "off".
            if (!this._enabled) return
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
        // Abort any in-flight MIDI-learn so its pending commit timer can't
        // fire a phantom assignment (and persist it) after MIDI is off.
        if (this._learningControlId) this.cancelLearn()
        for (const id of this._controlRuntime.keys()) this._resetRuntime(id)
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
        // Disabled means disabled. A device hot-plug can re-fire
        // onstatechange and re-attach listeners after toggle() detached
        // them, so guard at the single chokepoint every MIDI message flows
        // through rather than relying on listeners being perfectly removed.
        if (!this._enabled) return
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
            if (this._learningControlId) { this._captureCc(channel, cc, value); return }

            this._dispatch('cc', channel, cc, value, false)

            // Mirror raw 0..1 into deck midiState (noisemaker midi() does
            // its own min/max), and feed the Auto-Mix last-CC tracker.
            const raw01 = value / 127
            for (const state of this._midiStates.values()) {
                this._writeCcIntoMidiState(state, channel, cc, raw01)
            }
            this._lastCcByChannel.set(channel, raw01)
            for (const cb of this._lastCcListeners) cb(channel, raw01)
            return
        }

        // Note on/off
        if (status === 0x90 || status === 0x80) {
            const note = data[1]
            const noteOn = status === 0x90 && data[2] > 0
            const velocity = noteOn ? data[2] : 0
            if (this._learningControlId && noteOn) { this._captureNote(channel, note); return }

            this._dispatch('note', channel, note, velocity, noteOn)

            for (const state of this._midiStates.values()) {
                this._writeNoteIntoMidiState(state, channel, note, velocity / 127)
            }
        }
    }

    /**
     * Route one input event to every bound control. inputKind is 'cc' or
     * 'note'; `num` is the cc or note number; `raw` is 0..127 (velocity for
     * notes); `noteOn` matters only for note-driven latch/momentary edges.
     */
    _dispatch(inputKind, ch, num, raw, noteOn) {
        for (const [controlId, asg] of Object.entries(this._assignments)) {
            if ((asg.kind || 'cc') !== inputKind) continue
            if (asg.ch !== ch) continue
            const aNum = (asg.kind === 'note') ? asg.note : asg.cc
            if (aNum !== num) continue

            const info = this._controlHandlers.get(controlId)
            if (!info) continue
            const rt = this._controlRuntime.get(controlId)
                || { prevOn: false, engaged: false, armSide: null, lastWritten: null }

            const norm = normalizeCcValue(raw, asg.min ?? 0, asg.max ?? 127, !!asg.invert)

            if (info.kind === 'continuous') {
                let current
                if (info.getValue) {
                    try {
                        current = Math.max(0, Math.min(1, info.getValue()))
                    } catch {
                        current = rt.lastWritten ?? norm
                    }
                } else {
                    current = rt.lastWritten ?? norm
                }
                // Re-arm if software moved from a non-MIDI source since our last write.
                if (rt.engaged && rt.lastWritten != null && Math.abs(current - rt.lastWritten) > PICKUP_EPS) {
                    rt.engaged = false
                    rt.armSide = null
                }
                const res = computePickup({
                    engaged: rt.engaged, armSide: rt.armSide,
                    incoming: norm, current, eps: PICKUP_EPS,
                })
                rt.engaged = res.engaged
                rt.armSide = res.armSide
                if (res.apply) {
                    info.handler(res.value)
                    rt.lastWritten = res.value
                }
                this._fireActivity(controlId, { value01: norm, engaged: rt.engaged, pickup: !rt.engaged, armSide: rt.armSide })
            } else {
                const on = (inputKind === 'note') ? !!noteOn : (norm >= 0.5)
                const edge = computeEdgeToggle(rt.prevOn, on)
                rt.prevOn = edge.nextOn
                if (edge.fire) info.handler()
                this._fireActivity(controlId, {
                    value01: (inputKind === 'note') ? (noteOn ? 1 : 0) : norm,
                    engaged: true, pickup: false,
                })
            }
            this._controlRuntime.set(controlId, rt)
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

    _captureCc(channel, cc, value) {
        if (!this._learningCapture) {
            this._learningCapture = { ch: channel, cc, min: value, max: value }
            this._learnCommitTimer = setTimeout(() => this._commitLearn(), this._learnWindowMs)
        } else if (this._learningCapture.ch === channel && this._learningCapture.cc === cc) {
            if (value < this._learningCapture.min) this._learningCapture.min = value
            if (value > this._learningCapture.max) this._learningCapture.max = value
        }
    }

    _captureNote(channel, note) {
        const id = this._learningControlId
        if (!id) return
        this._assignments[id] = { kind: 'note', ch: channel, note, min: 0, max: 127, invert: false }
        this._learningControlId = null
        this._learningCapture = null
        if (this._learnCommitTimer) { clearTimeout(this._learnCommitTimer); this._learnCommitTimer = null }
        this._saveAssignments()
        this._resetRuntime(id)
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
        this._notify(`learned: ${id} ← note ${note} ch ${channel + 1}`)
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
        this._assignments[id] = { kind: 'cc', ch: cap.ch, cc: cap.cc, min, max, invert: false }
        this._learningControlId = null
        this._learningCapture = null
        if (this._learnCommitTimer) {
            clearTimeout(this._learnCommitTimer)
            this._learnCommitTimer = null
        }
        this._resetRuntime(id)
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

    setRange(controlId, min, max) {
        const a = this._assignments[controlId]
        if (!a) return
        const lo = Number(min), hi = Number(max)
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
        a.min = Math.max(0, Math.min(127, Math.round(lo)))
        a.max = Math.max(0, Math.min(127, Math.round(hi)))
        this._saveAssignments()
        this._resetRuntime(controlId)
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    setInvert(controlId, on) {
        const a = this._assignments[controlId]
        if (!a) return
        a.invert = !!on
        this._saveAssignments()
        this._resetRuntime(controlId)
        if (this._onLearnUpdate) this._onLearnUpdate(this.getLearnView())
    }

    getLearnView() {
        const conflicts = findConflicts(this._assignments)
        const rows = []
        for (const [controlId, info] of this._controlHandlers.entries()) {
            const asg = this._assignments[controlId]
            const conflict = conflicts[controlId] || null
            rows.push({
                controlId,
                label: info.label,
                controlKind: info.kind,
                kind: asg ? (asg.kind || 'cc') : undefined,
                ch: asg?.ch,
                cc: asg?.cc,
                note: asg?.note,
                min: asg?.min,
                max: asg?.max,
                invert: !!asg?.invert,
                conflict,
                learning: this._learningControlId === controlId,
                capturing: this._learningControlId === controlId && !!this._learningCapture,
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
