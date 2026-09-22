// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AutoMix,
    DEFAULT_BARS_PER_SCENE,
    MIN_BARS_PER_SCENE,
    MAX_BARS_PER_SCENE,
    clampBarsPerScene
} from '../js/automix.js'

function createMockScheduler(initialBeat = 0) {
    let beatCb = () => {}
    return {
        beatIndex: initialBeat,
        onBeat(cb) { beatCb = cb },
        fireBeat(beatIndex, isDownbeat = (beatIndex % 4 === 0)) {
            this.beatIndex = beatIndex
            beatCb({ beatIndex, isDownbeat })
        }
    }
}

function createMockAutoMix(initialBars = 8) {
    const scheduler = createMockScheduler(0)
    let currentXfade = 0.0
    const swaps = []

    const autoMix = new AutoMix({
        library: { getRandom: () => ({ dsl: 'x', title: 'test' }) },
        decks: {
            A: { currentDsl: 'a', currentName: 'A', load: async () => ({ success: true }) },
            B: { currentDsl: 'b', currentName: 'B', load: async () => ({ success: true }) }
        },
        compositor: {},
        scheduler,
        getXfade: () => currentXfade,
        setXfade: (v) => { currentXfade = v },
        onStatus: () => {},
        onLoad: () => {}
    })

    // Mock _triggerSceneSwap to record swaps
    autoMix._triggerSceneSwap = (b) => {
        swaps.push({ beatIndex: b.beatIndex, xfade: currentXfade })
    }

    if (initialBars !== 8) {
        autoMix.setBarsPerScene(initialBars)
    }

    return { autoMix, scheduler, swaps }
}

test('Auto-VJ bar constants have expected values', () => {
    assert.equal(MIN_BARS_PER_SCENE, 1)
    assert.equal(MAX_BARS_PER_SCENE, 128)
    assert.equal(DEFAULT_BARS_PER_SCENE, 8)
})

test('clampBarsPerScene: returns default (8) for missing, null, undefined, empty, or boolean values', () => {
    assert.equal(clampBarsPerScene(null), 8)
    assert.equal(clampBarsPerScene(undefined), 8)
    assert.equal(clampBarsPerScene(''), 8)
    assert.equal(clampBarsPerScene('   '), 8)
    assert.equal(clampBarsPerScene(true), 8)
    assert.equal(clampBarsPerScene(false), 8)
})

test('clampBarsPerScene: returns default (8) for non-numeric or non-finite inputs', () => {
    assert.equal(clampBarsPerScene(NaN), 8)
    assert.equal(clampBarsPerScene(Infinity), 8)
    assert.equal(clampBarsPerScene(-Infinity), 8)
    assert.equal(clampBarsPerScene('not-a-number'), 8)
    assert.equal(clampBarsPerScene({}), 8)
    assert.equal(clampBarsPerScene([]), 8)
})

test('clampBarsPerScene: rejects zero and negative values by clamping to safe minimum (1 bar)', () => {
    assert.equal(clampBarsPerScene(0), 1)
    assert.equal(clampBarsPerScene(-0), 1)
    assert.equal(clampBarsPerScene('0'), 1)
    assert.equal(clampBarsPerScene(-1), 1)
    assert.equal(clampBarsPerScene(-8), 1)
    assert.equal(clampBarsPerScene('-16'), 1)
    assert.equal(clampBarsPerScene(-100), 1)
    assert.equal(clampBarsPerScene(0.1), 1)
    assert.equal(clampBarsPerScene(0.49), 1)
})

test('clampBarsPerScene: preserves valid positive integer bar values', () => {
    assert.equal(clampBarsPerScene(1), 1)
    assert.equal(clampBarsPerScene(2), 2)
    assert.equal(clampBarsPerScene(4), 4)
    assert.equal(clampBarsPerScene(8), 8)
    assert.equal(clampBarsPerScene(16), 16)
    assert.equal(clampBarsPerScene(32), 32)
    assert.equal(clampBarsPerScene(64), 64)
    assert.equal(clampBarsPerScene(128), 128)
})

test('clampBarsPerScene: parses numeric string values correctly', () => {
    assert.equal(clampBarsPerScene('1'), 1)
    assert.equal(clampBarsPerScene('2'), 2)
    assert.equal(clampBarsPerScene('4'), 4)
    assert.equal(clampBarsPerScene('8'), 8)
    assert.equal(clampBarsPerScene('16'), 16)
    assert.equal(clampBarsPerScene('32'), 32)
})

test('clampBarsPerScene: clamps values exceeding MAX_BARS_PER_SCENE to 128', () => {
    assert.equal(clampBarsPerScene(129), 128)
    assert.equal(clampBarsPerScene(256), 128)
    assert.equal(clampBarsPerScene(1000), 128)
    assert.equal(clampBarsPerScene('500'), 128)
})

test('clampBarsPerScene: quantizes floating-point bar counts to nearest integer', () => {
    assert.equal(clampBarsPerScene(1.2), 1)
    assert.equal(clampBarsPerScene(1.7), 2)
    assert.equal(clampBarsPerScene(3.5), 4)
    assert.equal(clampBarsPerScene(7.9), 8)
    assert.equal(clampBarsPerScene('15.6'), 16)
})

test('clampBarsPerScene: respects custom fallback when input is invalid or missing', () => {
    assert.equal(clampBarsPerScene(NaN, 16), 16)
    assert.equal(clampBarsPerScene(null, 4), 4)
    assert.equal(clampBarsPerScene(undefined, 32), 32)
    assert.equal(clampBarsPerScene('invalid', 2), 2)
    // Custom fallback itself is safely clamped
    assert.equal(clampBarsPerScene(null, -5), 1)
    assert.equal(clampBarsPerScene(NaN, 300), 128)
})

test('AutoMix: initializes with DEFAULT_BARS_PER_SCENE (8)', () => {
    const { autoMix } = createMockAutoMix()
    assert.equal(autoMix.barsPerScene, 8)
})

test('AutoMix.setBarsPerScene: clamps 0 and negative inputs to safe minimum (1 bar)', () => {
    const { autoMix } = createMockAutoMix()
    autoMix.setBarsPerScene(0)
    assert.equal(autoMix.barsPerScene, 1)

    autoMix.setBarsPerScene(-4)
    assert.equal(autoMix.barsPerScene, 1)

    autoMix.setBarsPerScene('-12')
    assert.equal(autoMix.barsPerScene, 1)
})

test('AutoMix.setBarsPerScene: updates to valid values and clamps upper bound', () => {
    const { autoMix } = createMockAutoMix()
    autoMix.setBarsPerScene(4)
    assert.equal(autoMix.barsPerScene, 4)

    autoMix.setBarsPerScene('16')
    assert.equal(autoMix.barsPerScene, 16)

    autoMix.setBarsPerScene(250)
    assert.equal(autoMix.barsPerScene, 128)
})

test('AutoMix.setBarsPerScene: preserves current value on NaN or non-numeric input', () => {
    const { autoMix } = createMockAutoMix()
    autoMix.setBarsPerScene(16)
    autoMix.setBarsPerScene(NaN)
    assert.equal(autoMix.barsPerScene, 16)

    autoMix.setBarsPerScene('invalid')
    assert.equal(autoMix.barsPerScene, 16)
})

test('AutoMix: provides fadeDurationSec and curve getters', () => {
    const { autoMix } = createMockAutoMix()
    assert.equal(autoMix.fadeDurationSec, 3)
    assert.equal(autoMix.curve, 'dipped')

    autoMix.setFadeDurationSec(5)
    assert.equal(autoMix.fadeDurationSec, 5)

    autoMix.setCurve('linear')
    assert.equal(autoMix.curve, 'linear')
})

test('AutoMix cadence: with 1 bar, downbeats trigger scene swap every 4 beats', () => {
    const { autoMix, scheduler, swaps } = createMockAutoMix(1)
    autoMix.setEnabled(true)

    // Beat 0 is downbeat 0 (at enable time _lastSwitchBeat = 0)
    scheduler.fireBeat(0, true)
    assert.equal(swaps.length, 0, 'No immediate swap on beat 0')

    // Beats 1, 2, 3: non-downbeats
    scheduler.fireBeat(1, false)
    scheduler.fireBeat(2, false)
    scheduler.fireBeat(3, false)
    assert.equal(swaps.length, 0, 'Non-downbeats do not trigger swap')

    // Beat 4 (downbeat 1: exactly 1 bar elapsed)
    scheduler.fireBeat(4, true)
    assert.equal(swaps.length, 1, 'Triggers swap on downbeat 1 (4 beats = 1 bar)')
    assert.equal(swaps[0].beatIndex, 4)

    // Beats 5, 6, 7
    scheduler.fireBeat(5, false)
    scheduler.fireBeat(6, false)
    scheduler.fireBeat(7, false)
    assert.equal(swaps.length, 1)

    // Beat 8 (downbeat 2: another 1 bar elapsed)
    scheduler.fireBeat(8, true)
    assert.equal(swaps.length, 2, 'Triggers swap on downbeat 2 (8 beats = 2 bars total)')
    assert.equal(swaps[1].beatIndex, 8)
})

test('AutoMix cadence: setting 0 bars safely clamps to 1 bar cadence without dividing by zero', () => {
    const { autoMix, scheduler, swaps } = createMockAutoMix()
    autoMix.setBarsPerScene(0) // safely clamped to 1
    autoMix.setEnabled(true)

    scheduler.fireBeat(0, true)
    scheduler.fireBeat(4, true)
    assert.equal(swaps.length, 1)
    scheduler.fireBeat(8, true)
    assert.equal(swaps.length, 2)
})

test('scene snapshot restore simulation: clamps malformed barsPerScene and selects closest option', () => {
    function simulateRestore(cfg, initialBars = 8) {
        let appliedBars = initialBars
        let dropdownValue = String(initialBars)
        const mockDropdown = {
            options: [
                { value: '1' },
                { value: '2' },
                { value: '4' },
                { value: '8' },
                { value: '16' },
                { value: '32' }
            ],
            getOptions() { return this.options },
            get value() { return dropdownValue },
            set value(v) { dropdownValue = v }
        }

        if (cfg.barsPerScene != null) {
            const clamped = clampBarsPerScene(cfg.barsPerScene)
            appliedBars = clamped
            const sel = mockDropdown
            const strVal = String(clamped)
            const opts = sel.getOptions ? sel.getOptions().map(o => o.value) : []
            if (opts.includes(strVal)) {
                sel.value = strVal
            } else {
                const nums = opts.map(Number).filter(Number.isFinite)
                if (nums.length > 0) {
                    const closest = nums.reduce((prev, curr) => Math.abs(curr - clamped) < Math.abs(prev - clamped) ? curr : prev)
                    sel.value = String(closest)
                }
            }
        }

        return { appliedBars, dropdownValue }
    }

    // Zero clamps to 1 bar, selects '1' option
    const resZero = simulateRestore({ barsPerScene: 0 })
    assert.equal(resZero.appliedBars, 1)
    assert.equal(resZero.dropdownValue, '1')

    // Negative clamps to 1 bar, selects '1' option
    const resNeg = simulateRestore({ barsPerScene: -8 })
    assert.equal(resNeg.appliedBars, 1)
    assert.equal(resNeg.dropdownValue, '1')

    // Non-preset value (3 bars) clamps to 3, selects closest option ('2')
    const resThree = simulateRestore({ barsPerScene: 3 })
    assert.equal(resThree.appliedBars, 3)
    assert.equal(resThree.dropdownValue, '2')

    // Excessive value (200 bars) clamps to 128, selects closest option ('32')
    const resExcess = simulateRestore({ barsPerScene: 200 })
    assert.equal(resExcess.appliedBars, 128)
    assert.equal(resExcess.dropdownValue, '32')

    // Float value (7.8 bars) rounds to 8, selects '8' option
    const resFloat = simulateRestore({ barsPerScene: 7.8 })
    assert.equal(resFloat.appliedBars, 8)
    assert.equal(resFloat.dropdownValue, '8')
})

