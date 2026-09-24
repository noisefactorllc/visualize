// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    calculateCrossfadeNudge,
    CROSSFADE_NUDGE_STEP_STANDARD,
    CROSSFADE_NUDGE_STEP_FINE,
    CROSSFADE_ACCEL_REPEAT_THRESHOLD,
    CROSSFADE_ACCEL_RAMP_RATE,
    CROSSFADE_ACCEL_MAX_MULTIPLIER,
    calculateNudgeMultiplier,
    CrossfadeNudgeTracker
} from '../js/crossfader.js'

test('nudge constants match specification: 5% standard and 1% fine', () => {
    assert.equal(CROSSFADE_NUDGE_STEP_STANDARD, 0.05)
    assert.equal(CROSSFADE_NUDGE_STEP_FINE, 0.01)
})

test('repeat acceleration constants match ergonomic specifications', () => {
    assert.equal(CROSSFADE_ACCEL_REPEAT_THRESHOLD, 3)
    assert.equal(CROSSFADE_ACCEL_RAMP_RATE, 0.25)
    assert.equal(CROSSFADE_ACCEL_MAX_MULTIPLIER, 2.5)
})

test('calculateNudgeMultiplier: initial taps and early repeats stay at 1.0x baseline', () => {
    assert.equal(calculateNudgeMultiplier(0), 1.0)
    assert.equal(calculateNudgeMultiplier(1), 1.0)
    assert.equal(calculateNudgeMultiplier(2), 1.0)
    assert.equal(calculateNudgeMultiplier(3), 1.0)
})

test('calculateNudgeMultiplier: ramps progressively past threshold up to max cap', () => {
    // threshold = 3, rampRate = 0.25, max = 2.5
    assert.equal(calculateNudgeMultiplier(4), 1.25)
    assert.equal(calculateNudgeMultiplier(5), 1.50)
    assert.equal(calculateNudgeMultiplier(6), 1.75)
    assert.equal(calculateNudgeMultiplier(7), 2.00)
    assert.equal(calculateNudgeMultiplier(8), 2.25)
    assert.equal(calculateNudgeMultiplier(9), 2.50)
    assert.equal(calculateNudgeMultiplier(10), 2.50)
    assert.equal(calculateNudgeMultiplier(50), 2.50)
})

test('calculateNudgeMultiplier: accepts custom parameters and handles edge cases defensively', () => {
    assert.equal(calculateNudgeMultiplier(3, { threshold: 1, rampRate: 0.5, maxMultiplier: 3.0 }), 2.0)
    assert.equal(calculateNudgeMultiplier(-5), 1.0)
    assert.equal(calculateNudgeMultiplier(null), 1.0)
    assert.equal(calculateNudgeMultiplier(undefined), 1.0)
    assert.equal(calculateNudgeMultiplier(NaN), 1.0)
    assert.equal(calculateNudgeMultiplier('invalid'), 1.0)
})

test('calculateCrossfadeNudge: sustains repeat acceleration in standard and fine modes', () => {
    // Standard mode (0.05 base)
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeatCount: 0 }), 0.05)
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeatCount: 3 }), 0.05)
    // 0.05 * 1.25 = 0.0625
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeatCount: 4 }), 0.0625)
    // 0.05 * 2.0 = 0.10
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { repeatCount: 7 }), 0.6)
    // 0.05 * 2.5 = 0.125
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { repeatCount: 9 }), 0.625)
    assert.equal(calculateCrossfadeNudge(0.5, 'left', { repeatCount: 9 }), 0.375)

    // Fine mode (0.01 base with shiftKey)
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { shiftKey: true, repeatCount: 0 }), 0.51)
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { shiftKey: true, repeatCount: 3 }), 0.51)
    // 0.01 * 1.25 = 0.0125
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { shiftKey: true, repeatCount: 4 }), 0.5125)
    // 0.01 * 2.5 = 0.025
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { shiftKey: true, repeatCount: 9 }), 0.525)
    assert.equal(calculateCrossfadeNudge(0.5, 'left', { shiftKey: true, repeatCount: 9 }), 0.475)
})

test('calculateCrossfadeNudge: repeat boolean option activates repeat handling cleanly', () => {
    // repeat: false gives base step
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeat: false }), 0.05)
    // repeat: true with repeatCount: 4 accelerates
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeat: true, repeatCount: 4 }), 0.0625)
    // repeat: true without count stays at base step (count 1 <= threshold 3)
    assert.equal(calculateCrossfadeNudge(0, 'right', { repeat: true }), 0.05)
})

test('calculateCrossfadeNudge: custom step override ignores repeat acceleration', () => {
    assert.equal(calculateCrossfadeNudge(0.5, 'right', { step: 0.08, repeatCount: 10 }), 0.58)
    assert.equal(calculateCrossfadeNudge(0.5, 'left', { step: 0.08, repeatCount: 10 }), 0.42)
})

test('calculateCrossfadeNudge: accelerated nudges clamp cleanly at 0 and 1 without overshoot', () => {
    assert.equal(calculateCrossfadeNudge(0.05, 'left', { repeatCount: 10 }), 0)
    assert.equal(calculateCrossfadeNudge(0.95, 'right', { repeatCount: 10 }), 1)
})

test('CrossfadeNudgeTracker: tracks repeat count and accelerates sustained holds', () => {
    const tracker = new CrossfadeNudgeTracker()
    assert.equal(tracker.repeatCount, 0)
    assert.equal(tracker.activeDirection, null)

    // Tap 1 (initial press, repeat: false)
    const step1 = tracker.nudge(0, 'right', { repeat: false })
    assert.equal(step1.value, 0.05)
    assert.equal(step1.repeatCount, 0)
    assert.equal(step1.multiplier, 1.0)
    assert.equal(step1.step, 0.05)

    // Repeats 1, 2, 3 (below threshold)
    tracker.nudge(step1.value, 'right', { repeat: true })
    tracker.nudge(0.10, 'right', { repeat: true })
    const step4 = tracker.nudge(0.15, 'right', { repeat: true })
    assert.equal(step4.repeatCount, 3)
    assert.equal(step4.multiplier, 1.0)
    assert.equal(step4.step, 0.05)

    // Repeat 4 (exceeds threshold -> 1.25x)
    const step5 = tracker.nudge(0.20, 'right', { repeat: true })
    assert.equal(step5.repeatCount, 4)
    assert.equal(step5.multiplier, 1.25)
    assert.equal(step5.step, 0.0625)
    assert.equal(step5.value, 0.2625)

    // Repeat 9 (capped at max 2.5x)
    for (let i = 5; i <= 8; i++) {
        tracker.nudge(0.5, 'right', { repeat: true })
    }
    const stepMax = tracker.nudge(0.5, 'right', { repeat: true })
    assert.equal(stepMax.repeatCount, 9)
    assert.equal(stepMax.multiplier, 2.5)
    assert.equal(stepMax.step, 0.125)
    assert.equal(stepMax.value, 0.625)
})

test('CrossfadeNudgeTracker: direction reversal resets repeat count instantly', () => {
    const tracker = new CrossfadeNudgeTracker()
    // Hold right for 5 repeats
    tracker.nudge(0, 'right', { repeat: false })
    for (let i = 1; i <= 5; i++) {
        tracker.nudge(0.2, 'right', { repeat: true })
    }
    assert.equal(tracker.repeatCount, 5)

    // Switch to left: count immediately resets to 0 and multiplier resets to 1.0
    const reversed = tracker.nudge(0.3, 'left', { repeat: false })
    assert.equal(tracker.repeatCount, 0)
    assert.equal(reversed.multiplier, 1.0)
    assert.equal(reversed.step, 0.05)
    assert.equal(reversed.value, 0.25)
})

test('CrossfadeNudgeTracker: reset() completely clears tracker state', () => {
    const tracker = new CrossfadeNudgeTracker()
    tracker.nudge(0, 'right', { repeat: false })
    tracker.nudge(0.05, 'right', { repeat: true })
    assert.equal(tracker.repeatCount, 1)

    tracker.reset()
    assert.equal(tracker.repeatCount, 0)
    assert.equal(tracker.activeDirection, null)

    const next = tracker.nudge(0.5, 'right', { repeat: false })
    assert.equal(next.repeatCount, 0)
    assert.equal(next.multiplier, 1.0)
    assert.equal(next.value, 0.55)
})

test('CrossfadeNudgeTracker: supports Shift fine mode dynamically with acceleration', () => {
    const tracker = new CrossfadeNudgeTracker()
    // Tap with Shift: fine 0.01 step
    const fineTap = tracker.nudge(0.5, 'right', { shiftKey: true, repeat: false })
    assert.equal(fineTap.value, 0.51)
    assert.equal(fineTap.step, 0.01)

    // Sustained hold with Shift (repeats 1, 2, 3)
    for (let i = 1; i <= 3; i++) {
        tracker.nudge(0.51, 'right', { shiftKey: true, repeat: true })
    }
    // At repeat 4: 0.01 * 1.25 = 0.0125
    const fineAccel = tracker.nudge(0.55, 'right', { shiftKey: true, repeat: true })
    assert.equal(fineAccel.repeatCount, 4)
    assert.equal(fineAccel.step, 0.0125)
    assert.equal(fineAccel.value, 0.5625)
})

test('CrossfadeNudgeTracker: invalid direction gracefully returns current value and resets tracker', () => {
    const tracker = new CrossfadeNudgeTracker()
    tracker.nudge(0.5, 'right', { repeat: true })
    const result = tracker.nudge(0.5, 'invalid')
    assert.equal(result.value, 0.5)
    assert.equal(tracker.repeatCount, 0)
    assert.equal(tracker.activeDirection, null)
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
