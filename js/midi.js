/**
 * SharedMidi — Web MIDI integration for VJ controllers.
 *
 * Three jobs:
 *  1. Route MIDI CC values to registered Visualize controls (crossfader,
 *     deck speeds, master FX). Uses a "learn" workflow so the user
 *     touches a control on the controller to bind it.
 *  2. Forward CC + note state into each deck's midiState bag so DSL
 *     programs using midi() automation also react.
 *  3. Decode MIDI clock (0xF8 ticks) into a live BPM estimate that the
 *     BPM module can optionally follow.
 *
 * Persists learn assignments to localStorage so a controller stays bound
 * between sessions.
 */

const STORAGE_KEY = 'visualize.midi.learn.v1'

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
        this._clockTickCount = 0
        this._clockStartMs = 0
        this._lastBpm = 0
        // Rolling-average BPM samples (one sample per quarter note).
        // 4 samples ≈ 1 bar of smoothing — long enough to absorb USB
        // jitter, short enough to follow real tempo changes within a
        // bar or two.
        this._bpmSamples = []
        this._bpmSampleSize = 4

        this._onStatus = null
        this._onLearnUpdate = null
        this._onBpm = null
    }

    onStatusChange(cb) { this._onStatus = cb }
    onLearnUpdate(cb) { this._onLearnUpdate = cb }
    onBpm(cb) { this._onBpm = cb }

    get enabled() { return this._enabled }
    get inputCount() { return this._inputs.length }
    get followClock() { return this._followClock }
    set followClock(v) {
        this._followClock = !!v
        this._clockTickCount = 0
        this._clockStartMs = 0
        this._bpmSamples = []
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
        this._inputs = Array.from(this._access.inputs.values())
        for (const input of this._inputs) {
            input.onmidimessage = (msg) => this._onMessage(msg)
        }
        this._access.onstatechange = () => {
            this._inputs = Array.from(this._access.inputs.values())
            for (const input of this._inputs) {
                if (!input.onmidimessage) input.onmidimessage = (m) => this._onMessage(m)
            }
            this._notify(`MIDI: ${this._inputs.length} input(s)`)
        }
        this._enabled = true
        this._notify(`MIDI: ${this._inputs.length} input(s)`)
        return true
    }

    /** Toggle on/off — disable just detaches listeners; access stays. */
    async toggle() {
        if (!this._enabled) return this.enable()
        // Re-read inputs from the access object before detaching — any
        // device hot-plugged between enable() and toggle() wouldn't be
        // in our cached `_inputs` array otherwise.
        if (this._access) {
            this._inputs = Array.from(this._access.inputs.values())
        }
        for (const input of this._inputs) input.onmidimessage = null
        this._enabled = false
        this._notify('MIDI off')
        return false
    }

    _onMessage(msg) {
        const data = msg.data
        const status = data[0] & 0xF0
        const channel = data[0] & 0x0F

        // MIDI clock
        if (data[0] === 0xF8) {
            this._onClockTick()
            return
        }
        if (data[0] === 0xFA || data[0] === 0xFB) {
            // start / continue — restart estimate
            this._clockTickCount = 0
            this._clockStartMs = 0
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

    /**
     * 24 ticks per quarter note. We estimate BPM over a 24-tick window
     * and feed the result into a rolling-average buffer so per-quarter
     * jitter (common over USB-MIDI from DAWs) doesn't visibly wobble
     * the BPM readout.
     */
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

    _onClockTick() {
        const now = performance.now()
        if (this._clockTickCount === 0) {
            this._clockStartMs = now
        }
        this._clockTickCount++
        if (this._clockTickCount >= 24) {
            const elapsedSec = (now - this._clockStartMs) / 1000
            if (elapsedSec > 0) {
                const instantBpm = 60 / elapsedSec
                if (Number.isFinite(instantBpm) && instantBpm > 20 && instantBpm < 400) {
                    this._bpmSamples.push(instantBpm)
                    if (this._bpmSamples.length > this._bpmSampleSize) {
                        this._bpmSamples.shift()
                    }
                    const avg = this._bpmSamples.reduce((a, b) => a + b, 0) / this._bpmSamples.length
                    this._lastBpm = avg
                    if (this._followClock && this._onBpm) {
                        this._onBpm(avg)
                    }
                }
            }
            this._clockTickCount = 0
            this._clockStartMs = now
        }
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
