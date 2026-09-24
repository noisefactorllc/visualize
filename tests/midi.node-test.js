// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test, { describe, it } from 'node:test'
import {
    SharedMidi,
    computeEdgeToggle,
    computePickup,
    normalizeCcValue,
    findConflicts,
    parseMidiStatus
} from '../js/midi.js'

describe('computeEdgeToggle pure helper', () => {
    it('fires on rising edge (off -> on)', () => {
        const res = computeEdgeToggle(false, true)
        assert.deepEqual(res, { fire: true, nextOn: true })
    })

    it('does not fire when held high (on -> on)', () => {
        const res = computeEdgeToggle(true, true)
        assert.deepEqual(res, { fire: false, nextOn: true })
    })

    it('does not fire on falling edge (on -> off)', () => {
        const res = computeEdgeToggle(true, false)
        assert.deepEqual(res, { fire: false, nextOn: false })
    })

    it('does not fire when held low (off -> off)', () => {
        const res = computeEdgeToggle(false, false)
        assert.deepEqual(res, { fire: false, nextOn: false })
    })

    it('normalizes truthy and falsy values to strict booleans', () => {
        assert.deepEqual(computeEdgeToggle(0, 1), { fire: true, nextOn: true })
        assert.deepEqual(computeEdgeToggle(1, 0), { fire: false, nextOn: false })
        assert.deepEqual(computeEdgeToggle(null, 'yes'), { fire: true, nextOn: true })
        assert.deepEqual(computeEdgeToggle(undefined, null), { fire: false, nextOn: false })
    })
})

describe('SharedMidi Note On / Note Off Edge Detection', () => {
    function createTestMidi() {
        const midi = new SharedMidi()
        midi._enabled = true
        return midi
    }

    it('triggers latch control exactly once on Note On, and zero times on Note Off (0x80)', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Note On (channel 0, note 36, velocity 100)
        midi._onMessage({ data: new Uint8Array([0x90, 36, 100]) })
        assert.equal(calls, 1, 'Handler should fire once on Note On')

        // Note Off via 0x80 with velocity 0
        midi._onMessage({ data: new Uint8Array([0x80, 36, 0]) })
        assert.equal(calls, 1, 'Handler must NOT fire on Note Off (no double-toggle)')

        // Second Note On
        midi._onMessage({ data: new Uint8Array([0x90, 36, 120]) })
        assert.equal(calls, 2, 'Handler should fire again on subsequent Note On')

        // Second Note Off
        midi._onMessage({ data: new Uint8Array([0x80, 36, 0]) })
        assert.equal(calls, 2, 'Handler must NOT fire on second Note Off')
    })

    it('does not double-toggle on Note Off with release velocity (0x80, vel > 0)', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxInvert', {
            label: 'fx · invert',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxInvert = { kind: 'note', ch: 0, note: 40, min: 0, max: 127, invert: false }

        // Note On
        midi._onMessage({ data: new Uint8Array([0x90, 40, 90]) })
        assert.equal(calls, 1)

        // Note Off with standard MIDI release velocity 64
        midi._onMessage({ data: new Uint8Array([0x80, 40, 64]) })
        assert.equal(calls, 1, 'Release velocity 64 on 0x80 must not trigger latch toggle')
    })

    it('does not double-toggle on Note Off sent as 0x90 with velocity 0 (running status)', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxBW', {
            label: 'fx · b&w',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxBW = { kind: 'note', ch: 1, note: 42, min: 0, max: 127, invert: false }

        // Note On (Channel 1 -> 0x91)
        midi._onMessage({ data: new Uint8Array([0x91, 42, 110]) })
        assert.equal(calls, 1)

        // Running-status Note Off (0x91, velocity 0)
        midi._onMessage({ data: new Uint8Array([0x91, 42, 0]) })
        assert.equal(calls, 1, 'Note On with velocity 0 must not trigger latch toggle')
    })

    it('absorbs pad bounce / repeated Note On messages without Note Off', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxZoom', {
            label: 'fx · zoom',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxZoom = { kind: 'note', ch: 0, note: 48, min: 0, max: 127, invert: false }

        // Rapid Note On events without release (contact bounce or arpeggiator re-trigger)
        midi._onMessage({ data: new Uint8Array([0x90, 48, 100]) })
        midi._onMessage({ data: new Uint8Array([0x90, 48, 115]) })
        midi._onMessage({ data: new Uint8Array([0x90, 48, 90]) })
        assert.equal(calls, 1, 'Only the first Note On rising edge should fire handler')

        // Release
        midi._onMessage({ data: new Uint8Array([0x80, 48, 0]) })
        assert.equal(calls, 1)

        // Next Note On
        midi._onMessage({ data: new Uint8Array([0x90, 48, 100]) })
        assert.equal(calls, 2)
    })

    it('fires momentary controls on press and not on release', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxFlash', {
            label: 'fx · flash',
            kind: 'momentary',
            handler: () => { calls++ }
        })
        midi._assignments.fxFlash = { kind: 'note', ch: 0, note: 52, min: 0, max: 127, invert: false }

        // Press
        midi._onMessage({ data: new Uint8Array([0x90, 52, 127]) })
        assert.equal(calls, 1)

        // Release
        midi._onMessage({ data: new Uint8Array([0x80, 52, 0]) })
        assert.equal(calls, 1, 'Momentary trigger should not fire on release')
    })

    it('enforces channel and note isolation', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxFreeze', {
            label: 'fx · freeze',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxFreeze = { kind: 'note', ch: 2, note: 60, min: 0, max: 127, invert: false }

        // Wrong channel (Channel 0 instead of 2)
        midi._onMessage({ data: new Uint8Array([0x90, 60, 100]) })
        assert.equal(calls, 0)

        // Wrong note (Note 61 on Channel 2)
        midi._onMessage({ data: new Uint8Array([0x92, 61, 100]) })
        assert.equal(calls, 0)

        // Matching Note and Channel
        midi._onMessage({ data: new Uint8Array([0x92, 60, 100]) })
        assert.equal(calls, 1)
    })

    it('ignores note messages for continuous controls', () => {
        const midi = createTestMidi()
        let xfValue = null
        midi.registerControl('crossfader', {
            label: 'crossfader',
            kind: 'continuous',
            handler: (v) => { xfValue = v },
            getValue: () => 0.5
        })
        midi._assignments.crossfader = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Note message should be skipped for continuous controls
        midi._onMessage({ data: new Uint8Array([0x90, 36, 127]) })
        assert.equal(xfValue, null, 'Continuous controls must ignore note messages')
    })

    it('discards short or malformed MIDI packets without crashing', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Truncated packets
        midi._onMessage({ data: null })
        midi._onMessage({ data: new Uint8Array([]) })
        midi._onMessage({ data: new Uint8Array([0x90]) })
        midi._onMessage({ data: new Uint8Array([0x90, 36]) })
        assert.equal(calls, 0)
    })

    it('ignores polyphonic aftertouch and channel pressure messages', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Aftertouch while holding pad
        midi._onMessage({ data: new Uint8Array([0xA0, 36, 80]) }) // Poly pressure
        midi._onMessage({ data: new Uint8Array([0xD0, 80]) })     // Channel pressure
        assert.equal(calls, 0)
    })

    it('reports 1 on Note On and 0 on Note Off via activity callbacks', () => {
        const midi = createTestMidi()
        const activities = []
        midi.onControlActivity((controlId, payload) => {
            activities.push({ controlId, ...payload })
        })
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => {}
        })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Note On
        midi._onMessage({ data: new Uint8Array([0x90, 36, 100]) })
        assert.equal(activities.length, 1)
        assert.equal(activities[0].controlId, 'fxStrobe')
        assert.equal(activities[0].value01, 1)

        // Note Off
        midi._onMessage({ data: new Uint8Array([0x80, 36, 0]) })
        assert.equal(activities.length, 2)
        assert.equal(activities[1].controlId, 'fxStrobe')
        assert.equal(activities[1].value01, 0)
    })
})

describe('SharedMidi Note Learn Lifecycle', () => {
    function createTestMidi() {
        const midi = new SharedMidi()
        midi._enabled = true
        return midi
    }

    it('learns a note on Note On without firing handler or firing on pad release', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => { calls++ }
        })

        // 1. Enter learn mode
        midi.startLearn('fxStrobe')
        assert.equal(midi._learningControlId, 'fxStrobe')

        // 2. User presses pad (Note On: channel 0, note 48, velocity 100)
        midi._onMessage({ data: new Uint8Array([0x90, 48, 100]) })

        // Check learn commitment
        assert.equal(midi._learningControlId, null, 'Learn mode should end after Note On')
        assert.deepEqual(midi._assignments.fxStrobe, {
            kind: 'note', ch: 0, note: 48, min: 0, max: 127, invert: false
        })
        assert.equal(calls, 0, 'Handler must NOT fire during note learn capture')

        // 3. User releases pad (Note Off: 0x80, note 48, release velocity 64)
        midi._onMessage({ data: new Uint8Array([0x80, 48, 64]) })
        assert.equal(calls, 0, 'Handler must NOT fire on release of pad used to learn')

        // 4. First real press after learning
        midi._onMessage({ data: new Uint8Array([0x90, 48, 100]) })
        assert.equal(calls, 1, 'First real Note On press after learn should fire handler')

        // 5. Release
        midi._onMessage({ data: new Uint8Array([0x80, 48, 0]) })
        assert.equal(calls, 1, 'Release must NOT fire handler')

        // 6. Second real press
        midi._onMessage({ data: new Uint8Array([0x90, 48, 100]) })
        assert.equal(calls, 2, 'Second Note On press should toggle cleanly')
    })

    it('ignores Note Off during learn mode (does not capture on release)', () => {
        const midi = createTestMidi()
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => {}
        })

        midi.startLearn('fxStrobe')
        // Send Note Off while in learn mode
        midi._onMessage({ data: new Uint8Array([0x80, 48, 64]) })
        assert.equal(midi._learningControlId, 'fxStrobe', 'Note Off must not capture')
        assert.equal(midi._assignments.fxStrobe, undefined)

        // Now send Note On with velocity 0 (running status Note Off)
        midi._onMessage({ data: new Uint8Array([0x90, 48, 0]) })
        assert.equal(midi._learningControlId, 'fxStrobe', 'Velocity 0 must not capture')
        assert.equal(midi._assignments.fxStrobe, undefined)
    })

    it('rejects learning notes to continuous controls', () => {
        const midi = createTestMidi()
        midi.registerControl('crossfader', {
            label: 'crossfader',
            kind: 'continuous',
            handler: () => {},
            getValue: () => 0.5
        })

        midi.startLearn('crossfader')
        midi._onMessage({ data: new Uint8Array([0x90, 60, 100]) })
        assert.equal(midi._learningControlId, 'crossfader', 'Continuous control should reject note learn')
        assert.equal(midi._assignments.crossfader, undefined)
    })

    it('clearAssignment resets runtime state so re-assignment does not double-toggle', () => {
        const midi = createTestMidi()
        let calls = 0
        midi.registerControl('fxStrobe', {
            label: 'fx · strobe',
            kind: 'latch',
            handler: () => { calls++ }
        })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }

        // Note On leaves prevOn = true
        midi._onMessage({ data: new Uint8Array([0x90, 36, 100]) })
        assert.equal(calls, 1)

        // Clear assignment
        midi.clearAssignment('fxStrobe')
        assert.equal(midi._assignments.fxStrobe, undefined)
        const rt = midi._controlRuntime.get('fxStrobe')
        assert.equal(rt?.prevOn, false, 'Runtime prevOn must be reset to false')

        // Re-assign and press
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }
        midi._onMessage({ data: new Uint8Array([0x90, 36, 100]) })
        assert.equal(calls, 2, 'Subsequent Note On after clear/re-assign must fire cleanly')
    })

    it('clearAllAssignments resets all control runtimes', () => {
        const midi = createTestMidi()
        midi.registerControl('fxStrobe', { label: 'fx · strobe', kind: 'latch', handler: () => {} })
        midi._assignments.fxStrobe = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }
        midi._onMessage({ data: new Uint8Array([0x90, 36, 100]) })

        midi.clearAllAssignments()
        assert.deepEqual(midi._assignments, {})
        assert.equal(midi._controlRuntime.get('fxStrobe')?.prevOn, false)
    })

    it('clearAssignment and clearAllAssignments cancel any in-flight learn session', () => {
        const midi = createTestMidi()
        midi.registerControl('fxStrobe', { label: 'fx · strobe', kind: 'latch', handler: () => {} })

        // clearAssignment while learning
        midi.startLearn('fxStrobe')
        assert.equal(midi._learningControlId, 'fxStrobe')
        midi.clearAssignment('fxStrobe')
        assert.equal(midi._learningControlId, null, 'clearAssignment should cancel active learn')

        // clearAllAssignments while learning
        midi.startLearn('fxStrobe')
        assert.equal(midi._learningControlId, 'fxStrobe')
        midi.clearAllAssignments()
        assert.equal(midi._learningControlId, null, 'clearAllAssignments should cancel active learn')
    })
})
