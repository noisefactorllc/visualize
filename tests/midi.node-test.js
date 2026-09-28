// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test, { describe, it } from 'node:test'
import {
    SharedMidi,
    computeEdgeToggle,
    computePickup,
    normalizeCcValue,
    normalizeRange,
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

describe('findConflicts helper & channel isolation', () => {
    it('returns empty object when no conflicts exist', () => {
        const c = findConflicts({
            speedA: { kind: 'cc', ch: 0, cc: 20 },
            speedB: { kind: 'cc', ch: 0, cc: 21 },
            crossfader: { kind: 'cc', ch: 1, cc: 20 }, // same CC, different channel (isolated)
        })
        assert.deepEqual(c, {})
    })

    it('enforces channel isolation: same CC on different channels does NOT conflict', () => {
        const c = findConflicts({
            deckA_fader: { kind: 'cc', ch: 0, cc: 50 },
            deckB_fader: { kind: 'cc', ch: 1, cc: 50 },
            deckC_fader: { kind: 'cc', ch: 2, cc: 50 },
        })
        assert.deepEqual(c, {})
    })

    it('detects CC conflict on same channel with structured metadata', () => {
        const c = findConflicts({
            speedA: { kind: 'cc', ch: 0, cc: 50 },
            crossfader: { kind: 'cc', ch: 0, cc: 50 },
            solo: { kind: 'cc', ch: 0, cc: 10 },
        })
        assert.ok(c.speedA)
        assert.ok(c.crossfader)
        assert.equal(c.solo, undefined)

        assert.equal(c.speedA.key, 'cc:0:50')
        assert.equal(c.speedA.kind, 'cc')
        assert.equal(c.speedA.ch, 0)
        assert.equal(c.speedA.num, 50)
        assert.deepEqual(c.speedA.others, ['crossfader'])

        assert.equal(c.crossfader.key, 'cc:0:50')
        assert.equal(c.crossfader.kind, 'cc')
        assert.equal(c.crossfader.ch, 0)
        assert.equal(c.crossfader.num, 50)
        assert.deepEqual(c.crossfader.others, ['speedA'])
    })

    it('handles multiple conflicting controls on the same channel', () => {
        const c = findConflicts({
            c1: { kind: 'cc', ch: 3, cc: 77 },
            c2: { kind: 'cc', ch: 3, cc: 77 },
            c3: { kind: 'cc', ch: 3, cc: 77 },
        })
        assert.deepEqual(c.c1.others, ['c2', 'c3'])
        assert.deepEqual(c.c2.others, ['c1', 'c3'])
        assert.deepEqual(c.c3.others, ['c1', 'c2'])
    })

    it('does not conflate note and cc on the same channel and number', () => {
        const c = findConflicts({
            fxStrobe: { kind: 'note', ch: 0, note: 60 },
            filterFreq: { kind: 'cc', ch: 0, cc: 60 },
        })
        assert.deepEqual(c, {})
    })
})

describe('SharedMidi Conflict Highlighting & Channel Isolation in Learn Mode', () => {
    function createTestMidi() {
        const midi = new SharedMidi()
        midi._enabled = true
        return midi
    }

    it('getLearnView provides otherLabels for conflicting assignments', () => {
        const midi = createTestMidi()
        midi.registerControl('crossfader', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi.registerControl('speedA', { label: 'speed A', kind: 'continuous', handler: () => {} })
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 40, min: 0, max: 127 }
        midi._assignments.speedA = { kind: 'cc', ch: 0, cc: 40, min: 0, max: 127 }

        const rows = midi.getLearnView()
        const cfRow = rows.find(r => r.controlId === 'crossfader')
        const saRow = rows.find(r => r.controlId === 'speedA')

        assert.ok(cfRow?.conflict)
        assert.deepEqual(cfRow.conflict.others, ['speedA'])
        assert.deepEqual(cfRow.conflict.otherLabels, ['speed A'])

        assert.ok(saRow?.conflict)
        assert.deepEqual(saRow.conflict.others, ['crossfader'])
        assert.deepEqual(saRow.conflict.otherLabels, ['crossfader'])
    })

    it('detects conflict during live in-flight capture before commit', () => {
        const midi = createTestMidi()
        midi.registerControl('crossfader', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi.registerControl('speedA', { label: 'speed A', kind: 'continuous', handler: () => {} })
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 40, min: 0, max: 127 }

        // Start learning speedA
        midi.startLearn('speedA')
        // User moves knob 40 on channel 0
        midi._captureCc(0, 40, 64)

        const rows = midi.getLearnView()
        const cfRow = rows.find(r => r.controlId === 'crossfader')
        const saRow = rows.find(r => r.controlId === 'speedA')

        assert.ok(saRow.capturing, 'speedA should be in capturing state')
        assert.equal(saRow.cc, 40)
        assert.equal(saRow.ch, 0)
        assert.ok(saRow.conflict, 'speedA should immediately flag conflict with crossfader')
        assert.deepEqual(saRow.conflict.otherLabels, ['crossfader'])
        assert.ok(cfRow.conflict, 'crossfader should also flag conflict during capture')

        // Clean up commit timer
        midi.cancelLearn()
    })

    it('notifies with warning when committing conflicting CC assignment', () => {
        const midi = createTestMidi()
        midi.registerControl('crossfader', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi.registerControl('speedA', { label: 'speed A', kind: 'continuous', handler: () => {} })
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 40, min: 0, max: 127 }

        let notice = ''
        midi._notify = (msg) => { notice = msg }

        midi.startLearn('speedA')
        midi._captureCc(0, 40, 64)
        midi._commitLearn()

        assert.match(notice, /⚠ conflict with crossfader/)
    })

    it('notifies with warning when committing conflicting Note assignment', () => {
        const midi = createTestMidi()
        midi.registerControl('fxStrobe', { label: 'fx · strobe', kind: 'momentary', handler: () => {} })
        midi.registerControl('fxFlash', { label: 'fx · flash', kind: 'momentary', handler: () => {} })
        midi._assignments.fxStrobe = { kind: 'note', ch: 1, note: 36, min: 0, max: 127 }

        let notice = ''
        midi._notify = (msg) => { notice = msg }

        midi.startLearn('fxFlash')
        midi._captureNote(1, 36)

        assert.match(notice, /⚠ conflict with fx · strobe/)
    })

    it('setChannel isolates channel and clears conflict immediately', () => {
        const midi = createTestMidi()
        midi.registerControl('crossfader', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi.registerControl('speedA', { label: 'speed A', kind: 'continuous', handler: () => {} })
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 }
        midi._assignments.speedA = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 }

        // Initially in conflict
        assert.ok(midi.getLearnView().find(r => r.controlId === 'speedA')?.conflict)

        // Move speedA to channel 1 (channel isolation)
        midi.setChannel('speedA', 1)
        assert.equal(midi._assignments.speedA.ch, 1)

        // Conflict is cleared on both controls
        const rows = midi.getLearnView()
        assert.equal(rows.find(r => r.controlId === 'speedA')?.conflict, null)
        assert.equal(rows.find(r => r.controlId === 'crossfader')?.conflict, null)
    })

    it('setCc reassigns CC and resolves conflict', () => {
        const midi = createTestMidi()
        midi.registerControl('c1', { label: 'C1', kind: 'continuous', handler: () => {} })
        midi.registerControl('c2', { label: 'C2', kind: 'continuous', handler: () => {} })
        midi._assignments.c1 = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 }
        midi._assignments.c2 = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 }

        assert.ok(midi.getLearnView().find(r => r.controlId === 'c2')?.conflict)

        midi.setCc('c2', 51)
        assert.equal(midi._assignments.c2.cc, 51)
        assert.equal(midi.getLearnView().find(r => r.controlId === 'c2')?.conflict, null)
    })

    it('setNote reassigns Note and resolves conflict', () => {
        const midi = createTestMidi()
        midi.registerControl('p1', { label: 'P1', kind: 'momentary', handler: () => {} })
        midi.registerControl('p2', { label: 'P2', kind: 'momentary', handler: () => {} })
        midi._assignments.p1 = { kind: 'note', ch: 0, note: 36, min: 0, max: 127 }
        midi._assignments.p2 = { kind: 'note', ch: 0, note: 36, min: 0, max: 127 }

        assert.ok(midi.getLearnView().find(r => r.controlId === 'p2')?.conflict)

        midi.setNote('p2', 37)
        assert.equal(midi._assignments.p2.note, 37)
        assert.equal(midi.getLearnView().find(r => r.controlId === 'p2')?.conflict, null)
    })
})


describe('MIDI soft-takeover vs software jumps (scene recall / auto-fade)', () => {
    function createPickupRig() {
        const midi = new SharedMidi()
        midi._enabled = true
        const rig = { software: 0.5, applied: [] }
        midi.registerControl('crossfader', {
            label: 'crossfader',
            kind: 'continuous',
            handler: (v01) => { rig.software = v01; rig.applied.push(v01) },
            getValue: () => rig.software,
        })
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 7, min: 0, max: 127, invert: false }
        rig.cc = (raw) => midi._dispatch('cc', 0, 7, raw, false)
        rig.rt = () => midi._controlRuntime.get('crossfader')
        return rig
    }

    it('a scene-recall jump past a parked fader does not hijack the control on the next CC', () => {
        const rig = createPickupRig()
        // Park the fader below the software value: arms side -1, no apply.
        rig.cc(25) // ≈0.197 vs software 0.5
        assert.equal(rig.applied.length, 0)
        assert.equal(rig.rt().engaged, false)
        assert.equal(rig.rt().armSide, -1)

        // Scene recall (or an auto-fade sweep) moves the software value
        // across the parked hardware position, 0.5 -> 0.1.
        rig.software = 0.1
        rig.cc(25)
        // Without the stale-arm invalidation this "crossing" would engage
        // and stomp the recalled value with the parked hardware position.
        assert.equal(rig.applied.length, 0, 'parked fader must not stomp a recalled value')
        assert.equal(rig.rt().engaged, false)
        assert.equal(rig.rt().armSide, 1, 'stale arm is invalidated and re-armed fresh against the recalled value')
    })

    it('after a recall jump the fader must travel to the new software value to catch', () => {
        const rig = createPickupRig()
        rig.cc(25) // arm below 0.5
        rig.software = 0.1 // scene recall
        rig.cc(25) // stale arm invalidated
        // Fader sweeps down toward the recalled value; nothing applies
        // until it lands within eps of 0.1.
        rig.cc(38) // ≈0.299
        rig.cc(32) // ≈0.252
        rig.cc(25) // ≈0.197
        assert.equal(rig.applied.length, 0, 'approaching from a re-armed side must not engage')
        rig.cc(13) // ≈0.102 — within eps of 0.1
        assert.equal(rig.applied.length, 1)
        assert.equal(rig.rt().engaged, true)
    })

    it('crossing catch still engages when the software value is static (regression)', () => {
        const rig = createPickupRig()
        rig.cc(38) // ≈0.299 vs static software 0.5 → arm side -1
        assert.equal(rig.rt().armSide, -1)
        rig.cc(77) // ≈0.606 — hardware crossed the static software value
        assert.equal(rig.applied.length, 1)
        assert.equal(rig.rt().engaged, true)
        assert.equal(rig.rt().armSide, null)
    })

    it('an engaged fader re-arms after an automation sweep moves the software value', () => {
        const rig = createPickupRig()
        rig.cc(64) // ≈0.504 — within eps of 0.5, engages
        assert.equal(rig.rt().engaged, true)
        // Auto-xfade sweep moves the software value away.
        rig.software = 0.9
        rig.cc(64)
        assert.equal(rig.applied.length, 1, 're-arm must suppress the stale hardware value')
        assert.equal(rig.rt().engaged, false)
        // Holding the fader steady must not fight the sweep; the value is
        // only caught again once the fader reaches the swept position.
        rig.cc(64)
        assert.equal(rig.applied.length, 1)
        rig.cc(114) // ≈0.898 — within eps of 0.9
        assert.equal(rig.applied.length, 2)
        assert.equal(rig.rt().engaged, true)
    })

    it('external software movement within PICKUP_EPS does not invalidate a stale arm', () => {
        const rig = createPickupRig()
        // Park the fader below the software value: arms side -1.
        rig.cc(25) // ≈0.197 vs software 0.5
        assert.equal(rig.rt().armSide, -1)
        // Software nudges by less than eps (0.02) — e.g. a rounding-level
        // drift or a sub-eps trim. The arm must survive; a subsequent
        // crossing still catches.
        rig.software = 0.485 // |Δ| = 0.015 < eps
        rig.cc(25) // still below 0.485 → re-arms side -1, no apply
        assert.equal(rig.applied.length, 0)
        assert.equal(rig.rt().armSide, -1)
        // Crossing the (barely moved) software value engages as before.
        rig.cc(77) // ≈0.606 > 0.485
        assert.equal(rig.applied.length, 1)
        assert.equal(rig.rt().engaged, true)
    })

    it('a speed fader behaves identically: scene-recall speed jump does not get stomped', () => {
        const midi = new SharedMidi()
        midi._enabled = true
        const deck = { speed: 1.0 }
        const applied = []
        midi.registerControl('speedA', {
            label: 'speed A',
            kind: 'continuous',
            handler: (v01) => { deck.speed = 0.1 + v01 * 3.9; applied.push(deck.speed) },
            getValue: () => (deck.speed - 0.1) / 3.9,
        })
        midi._assignments.speedA = { kind: 'cc', ch: 0, cc: 20, min: 0, max: 127, invert: false }
        const cc = (raw) => midi._dispatch('cc', 0, 20, raw, false)

        cc(102) // ≈0.803 → ≈3.23× vs software 1.0: arm side +1, no apply
        assert.equal(applied.length, 0)
        deck.speed = 0.35 // scene recall restores 0.35× (≈0.064 normalized)
        cc(102) // stale arm (side +1) must not "cross" the recalled value
        assert.equal(applied.length, 0, 'recalled deck speed must not be stomped by parked fader')
        cc(120) // ≈0.945 → ≈3.78×: side +1 again but arm was invalidated; re-arms, no apply
        assert.equal(applied.length, 0)
        cc(120) // same side, still not near 0.064 — no apply
        assert.equal(applied.length, 0)
    })
})

describe('normalizeRange canonicalization', () => {
    it('swaps crossed bounds deterministically', () => {
        assert.deepEqual(normalizeRange(120, 10), { min: 10, max: 120 })
        assert.deepEqual(normalizeRange(64, 1), { min: 1, max: 64 })
    })

    it('rounds and clamps both bounds into 0..127', () => {
        assert.deepEqual(normalizeRange(-5, 200), { min: 0, max: 127 })
        assert.deepEqual(normalizeRange(10.4, 63.6), { min: 10, max: 64 })
        assert.deepEqual(normalizeRange(-0.5, 127.4), { min: 0, max: 127 })
    })

    it('leaves equal and ordered pairs as-is', () => {
        assert.deepEqual(normalizeRange(20, 100), { min: 20, max: 100 })
        assert.deepEqual(normalizeRange(42, 42), { min: 42, max: 42 })
    })
})

describe('MIDI learn range editing hardening', () => {
    function createTestMidi() {
        const midi = new SharedMidi()
        midi._enabled = true
        return midi
    }

    it('setRange swaps crossed bounds instead of storing them inverted', () => {
        const midi = createTestMidi()
        midi.registerControl('xfade', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 0, max: 127, invert: false }
        midi.setRange('xfade', 110, 15)
        assert.equal(midi._assignments.xfade.min, 15)
        assert.equal(midi._assignments.xfade.max, 110)
        assert.ok(midi._assignments.xfade.min <= midi._assignments.xfade.max)
    })

    it('setRange clamps out-of-range bounds into 0..127', () => {
        const midi = createTestMidi()
        midi.registerControl('xfade', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 0, max: 127, invert: false }
        midi.setRange('xfade', -10, 300)
        assert.equal(midi._assignments.xfade.min, 0)
        assert.equal(midi._assignments.xfade.max, 127)
    })

    it('setRange ignores non-finite input and keeps the live assignment', () => {
        const midi = createTestMidi()
        midi.registerControl('xfade', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 10, max: 90, invert: false }
        midi.setRange('xfade', NaN, 90)
        assert.equal(midi._assignments.xfade.min, 10)
        midi.setRange('xfade', 10, Infinity)
        assert.equal(midi._assignments.xfade.max, 90)
    })

    it('setRange with unchanged values does not re-save or reset runtime', () => {
        const midi = createTestMidi()
        midi.registerControl('xfade', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 10, max: 90, invert: false }
        let updates = 0
        midi.onLearnUpdate(() => { updates++ })
        midi.setRange('xfade', 10, 90)
        assert.equal(updates, 0, 'no-op edit must not churn runtime or notifications')
    })

    it('CC values outside the edited range clamp to the range edges mid-performance', () => {
        const midi = createTestMidi()
        const applied = []
        midi.registerControl('xfade', {
            label: 'crossfader',
            kind: 'continuous',
            handler: (v) => { applied.push(v) },
            getValue: () => 0,
        })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 32, max: 96, invert: false }
        midi._dispatch('cc', 0, 7, 0, false)    // below min → 0
        midi._dispatch('cc', 0, 7, 127, false)  // above max → 1
        assert.deepEqual(applied, [0, 1])
    })

    it('out-of-range clamping composes deterministically with invert', () => {
        const midi = createTestMidi()
        const applied = []
        // Software value starts at the inverted top edge so the first CC
        // catches immediately (pickup) and later CCs follow while engaged.
        midi.registerControl('xfade', {
            label: 'crossfader',
            kind: 'continuous',
            handler: (v) => { applied.push(v) },
            getValue: () => 1,
        })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 32, max: 96, invert: true }
        midi._dispatch('cc', 0, 7, 0, false)    // below min → clamped 0, inverted → 1
        midi._dispatch('cc', 0, 7, 127, false)  // above max → clamped 1, inverted → 0
        assert.deepEqual(applied, [1, 0])
    })

    it('toggling invert deterministically flips the mapping without touching stored bounds', () => {
        assert.equal(
            normalizeCcValue(32, 0, 127, true),
            1 - normalizeCcValue(32, 0, 127, false),
            'invert is the exact complement at the same raw value',
        )
        const midi = createTestMidi()
        midi.registerControl('xfade', { label: 'crossfader', kind: 'continuous', handler: () => {} })
        midi._assignments.xfade = { kind: 'cc', ch: 0, cc: 7, min: 10, max: 90, invert: false }
        midi._controlRuntime.set('xfade', { prevOn: false, engaged: true, armSide: null, lastWritten: 0.5, lastCurrent: 0.5 })
        midi.setInvert('xfade', true)
        assert.equal(midi._assignments.xfade.min, 10, 'bounds are untouched by invert')
        assert.equal(midi._assignments.xfade.max, 90, 'bounds are untouched by invert')
        assert.equal(midi._assignments.xfade.invert, true)
        // Runtime reset: the takeover arm/engage state is cleared so the
        // flipped mapping re-arms cleanly instead of fighting stale state.
        assert.equal(midi._controlRuntime.get('xfade').engaged, false)
        assert.equal(midi._controlRuntime.get('xfade').armSide, null)
    })

    it('inverted assignments survive a save/reload round-trip with canonical bounds', () => {
        const store = new Map()
        globalThis.localStorage = {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, v) },
            removeItem: (k) => { store.delete(k) },
        }
        try {
            const midi = createTestMidi()
            midi.registerControl('speedA', { label: 'speed A', kind: 'continuous', handler: () => {} })
            midi._assignments.speedA = { kind: 'cc', ch: 3, cc: 20, min: 120, max: 5, invert: true }
            midi.setRange('speedA', 120, 5) // crossed → canonicalized + persisted
            assert.deepEqual(midi._assignments.speedA, { kind: 'cc', ch: 3, cc: 20, min: 5, max: 120, invert: true })

            const reloaded = new SharedMidi()
            assert.deepEqual(reloaded._assignments.speedA, { kind: 'cc', ch: 3, cc: 20, min: 5, max: 120, invert: true })
        } finally {
            delete globalThis.localStorage
        }
    })
})
