// SPDX-License-Identifier: MIT
/**
 * AutoXfade — automate the crossfader from a single chosen source.
 *
 * Mutually exclusive with AutoMix (auto-VJ) — both raise an
 * onEnableChange event, and the app wires each to call setEnabled(false)
 * on the other.
 *
 * Source kinds:
 *   { kind: 'osc',   oscType: 0..4 }      sine/tri/saw/sawInv/square,
 *                                          one full cycle per N bars
 *                                          (N = getBarsPerCycle(), shared
 *                                          with Auto-VJ's cycle dropdown)
 *   { kind: 'audio', band: 'sub'|'low'|'mid'|'high' }
 *   { kind: 'midi',  channel: 0..15 }      latest CC seen on the channel
 *
 * tick(nowMs) is called from the compositor's per-frame hook; it reads
 * the current source value and writes via setXfade(value01).
 */

const OSC_NAMES = ['sine', 'tri', 'saw', 'sawInv', 'square']
const AUDIO_BANDS = ['sub', 'low', 'mid', 'high']

function evalOsc(typeIndex, phase) {
    // phase in [0, 1); return value in [0, 1]
    const t = phase - Math.floor(phase)
    switch (typeIndex) {
        case 0: return 0.5 + 0.5 * Math.sin(2 * Math.PI * t)   // sine
        case 1: return t < 0.5 ? 2 * t : 2 * (1 - t)            // tri
        case 2: return t                                         // saw
        case 3: return 1 - t                                     // sawInv
        case 4: return t < 0.5 ? 0 : 1                           // square
        default: return 0.5
    }
}

const DEFAULT_SOURCE = { kind: 'osc', oscType: 0 }

export class AutoXfade {
    constructor({ scheduler, audio, midi, setXfade, getBarsPerCycle }) {
        this.scheduler = scheduler
        this.audio = audio
        this.midi = midi
        this.setXfade = setXfade
        // Optional () => number — the bars per oscillator cycle.
        // We piggyback on Auto-VJ's `barsPerScene` so the two
        // mutually-exclusive automation modes share a single
        // "musical cycle length" knob (the existing cycle dropdown).
        // Defaults to 1 bar when no getter is supplied.
        this.getBarsPerCycle = typeof getBarsPerCycle === 'function'
            ? getBarsPerCycle : () => 1
        this._enabled = false
        this._source = { ...DEFAULT_SOURCE }
        this._enableListeners = []
    }

    get enabled() { return this._enabled }
    get source() { return { ...this._source } }

    onEnableChange(cb) { this._enableListeners.push(cb) }

    setEnabled(v) {
        const next = !!v
        if (next === this._enabled) return
        this._enabled = next
        for (const cb of this._enableListeners) cb(this._enabled)
    }

    /** Source must be { kind: 'osc'|'audio'|'midi', ... }. Invalid
     *  inputs are silently ignored — the picker constrains to valid
     *  values. */
    setSource(src) {
        if (!src || typeof src !== 'object') return
        if (src.kind === 'osc' && Number.isFinite(src.oscType)) {
            this._source = { kind: 'osc', oscType: src.oscType | 0 }
        } else if (src.kind === 'audio' && AUDIO_BANDS.includes(src.band)) {
            this._source = { kind: 'audio', band: src.band }
        } else if (src.kind === 'midi' && Number.isFinite(src.channel)) {
            this._source = { kind: 'midi', channel: src.channel | 0 }
        }
    }

    /** Read the live source value as a 0..1 float, or null if no
     *  signal yet (only happens for MIDI before any CC arrives). */
    readSource(nowMs) {
        const s = this._source
        if (s.kind === 'osc') {
            // Beat-aligned: phase comes from the BeatScheduler's
            // position within an N-bar cycle (N = getBarsPerCycle(),
            // shared with Auto-VJ's "cycle" dropdown). The cycle
            // tracks the music — resets on tap, follows MIDI clock,
            // doesn't drift.
            const bars = Math.max(1, Number(this.getBarsPerCycle()) || 1)
            const cycleBeats = bars * 4
            const sched = this.scheduler
            if (sched && typeof sched.beatIndex === 'number'
                && typeof sched.beatPhase === 'number') {
                const pos = (sched.beatIndex % cycleBeats) + sched.beatPhase
                const phase = pos / cycleBeats
                return evalOsc(s.oscType, phase)
            }
            // Fallback (no scheduler available) — wall-clock.
            const barSec = sched?.barSeconds?.() || 2
            return evalOsc(s.oscType, (nowMs / 1000) / (barSec * bars))
        }
        if (s.kind === 'audio') {
            return this.audio?.meters?.[s.band] ?? 0
        }
        if (s.kind === 'midi') {
            const v = this.midi?.lastCcOnChannel?.(s.channel)
            return v == null ? null : v
        }
        return null
    }

    tick(nowMs) {
        if (!this._enabled) return
        const v = this.readSource(nowMs)
        // Null only happens for MIDI-no-signal — park the fader at
        // 0.5 so it doesn't snap to either side.
        const xfade = v == null ? 0.5 : Math.max(0, Math.min(1, v))
        this.setXfade(xfade)
    }

    snapshot() {
        return { enabled: this._enabled, source: { ...this._source } }
    }

    restore(snap) {
        if (!snap) return
        if (snap.source) this.setSource(snap.source)
        this.setEnabled(!!snap.enabled)
    }
}

/** Display name for an oscillator type index. */
export function oscTypeName(i) { return OSC_NAMES[i] || `osc${i}` }
