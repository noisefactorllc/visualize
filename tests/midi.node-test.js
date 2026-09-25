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

