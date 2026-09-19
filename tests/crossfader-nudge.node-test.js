// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    calculateCrossfadeNudge,
    CROSSFADE_NUDGE_STEP_STANDARD,
    CROSSFADE_NUDGE_STEP_FINE
} from '../js/crossfader.js'

test('nudge constants match specification: 5% standard and 1% fine', () => {
    assert.equal(CROSSFADE_NUDGE_STEP_STANDARD, 0.05)
    assert.equal(CROSSFADE_NUDGE_STEP_FINE, 0.01)
})

test('standard nudge steps by exactly 0.05 (5%) in both directions', () => {
    assert.equal(calculateCrossfadeNudge(0, 'right'), 0.05)
    assert.equal(calculateCrossfadeNudge(0.05, 'right'), 0.1)
    assert.equal(calculateCrossfadeNudge(0.5, 'left'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'right'), 0.55)
    assert.equal(calculateCrossfadeNudge(1, 'left'), 0.95)
})

test('shift nudge steps by exactly 0.01 (1%) in both directions', () => {
    assert.equal(calculateCrossfadeNudge(0, 'right', { shiftKey: true }), 0.01)
    assert.equal(calculateCrossfadeNudge(0.01, 'right', { shiftKey: true }), 0.02)
    assert.equal(calculateCrossfadeNudge(0.5, 'left', { shiftKey: true }), 0.49)
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { shiftKey: true }), 0.51)
    assert.equal(calculateCrossfadeNudge(1, 'left', { shiftKey: true }), 0.99)
})

test('nudge clamps at lower bound 0 and upper bound 1', () => {
    assert.equal(calculateCrossfadeNudge(0, 'left'), 0)
    assert.equal(calculateCrossfadeNudge(0, 'left', { shiftKey: true }), 0)
    assert.equal(calculateCrossfadeNudge(0.02, 'left'), 0)
    assert.equal(calculateCrossfadeNudge(0.005, 'left', { shiftKey: true }), 0)

    assert.equal(calculateCrossfadeNudge(1, 'right'), 1)
    assert.equal(calculateCrossfadeNudge(1, 'right', { shiftKey: true }), 1)
    assert.equal(calculateCrossfadeNudge(0.98, 'right'), 1)
    assert.equal(calculateCrossfadeNudge(0.995, 'right', { shiftKey: true }), 1)
})

test('successive fine nudges (1%) do not accumulate IEEE 754 precision drift', () => {
    let val = 0
    for (let i = 1; i <= 100; i++) {
        val = calculateCrossfadeNudge(val, 'right', { shiftKey: true })
        const expected = Math.round(i * 0.01 * 100) / 100
        assert.equal(val, expected, `drift at step ${i}: expected ${expected}, got ${val}`)
    }
    assert.equal(val, 1)

    for (let i = 99; i >= 0; i--) {
        val = calculateCrossfadeNudge(val, 'left', { shiftKey: true })
        const expected = Math.round(i * 0.01 * 100) / 100
        assert.equal(val, expected, `drift downwards at step ${i}: expected ${expected}, got ${val}`)
    }
    assert.equal(val, 0)
})

test('successive standard nudges (5%) do not accumulate IEEE 754 precision drift', () => {
    let val = 0
    for (let i = 1; i <= 20; i++) {
        val = calculateCrossfadeNudge(val, 'right')
        const expected = Math.round(i * 0.05 * 100) / 100
        assert.equal(val, expected, `drift at step ${i}: expected ${expected}, got ${val}`)
    }
    assert.equal(val, 1)

    for (let i = 19; i >= 0; i--) {
        val = calculateCrossfadeNudge(val, 'left')
        const expected = Math.round(i * 0.05 * 100) / 100
        assert.equal(val, expected, `drift downwards at step ${i}: expected ${expected}, got ${val}`)
    }
    assert.equal(val, 0)
})

test('accepts direction aliases and is case-insensitive (left, arrowleft, arrowdown, down, -1, right, arrowright, arrowup, up, 1)', () => {
    assert.equal(calculateCrossfadeNudge(0.5, 'arrowleft'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'ArrowLeft'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'LEFT'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'arrowright'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, 'ArrowRight'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, 'RIGHT'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, 'arrowdown'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'ArrowDown'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'down'), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 'arrowup'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, 'ArrowUp'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, 'up'), 0.55)
    assert.equal(calculateCrossfadeNudge(0.5, -1), 0.45)
    assert.equal(calculateCrossfadeNudge(0.5, 1), 0.55)
})

test('unrecognized or invalid direction returns current value unmodified', () => {
    assert.equal(calculateCrossfadeNudge(0.5, 'invalid'), 0.5)
    assert.equal(calculateCrossfadeNudge(0.35, 'unknown'), 0.35)
    assert.equal(calculateCrossfadeNudge(0.7, null), 0.7)
    assert.equal(calculateCrossfadeNudge(0.2, 0), 0.2)
})

test('handles string and invalid inputs defensively', () => {
    assert.equal(calculateCrossfadeNudge('0.5', 'right'), 0.55)
    assert.equal(calculateCrossfadeNudge('0.25', 'left', { shiftKey: true }), 0.24)
    assert.equal(calculateCrossfadeNudge(NaN, 'right'), 0.05)
    assert.equal(calculateCrossfadeNudge(null, 'right'), 0.05)
    assert.equal(calculateCrossfadeNudge(undefined, 'right'), 0.05)
})

test('custom step override is honored when provided', () => {
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { step: 0.1 }), 0.6)
    assert.equal(calculateCrossfadeNudge(0.5, 'left', { step: 0.2 }), 0.3)
})
