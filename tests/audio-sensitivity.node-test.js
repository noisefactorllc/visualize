// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    SharedAudio,
    AUDIO_STORAGE_KEY,
    AUDIO_SENSITIVITY_STORAGE_KEY,
    DEFAULT_AUDIO_SENSITIVITY,
    MIN_AUDIO_SENSITIVITY,
    MAX_AUDIO_SENSITIVITY,
    parseAudioSensitivity,
    loadAudioSensitivity,
    persistAudioSensitivity
} from '../js/audio.js'

function createMockStorage(initial = {}) {
    const store = new Map(Object.entries(initial))
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null
        },
        setItem(key, value) {
            store.set(key, String(value))
        },
        removeItem(key) {
            store.delete(key)
        },
        clear() {
            store.clear()
        },
        _store: store
    }
}

test('audio sensitivity constants have expected default and range', () => {
    assert.equal(DEFAULT_AUDIO_SENSITIVITY, 1.5)
    assert.equal(MIN_AUDIO_SENSITIVITY, 0.5)
    assert.equal(MAX_AUDIO_SENSITIVITY, 4.0)
    assert.equal(AUDIO_STORAGE_KEY, 'visualize.audio.v1')
    assert.equal(AUDIO_SENSITIVITY_STORAGE_KEY, 'visualize.audio.sensitivity.v1')
})

test('parseAudioSensitivity returns default for missing, boolean, or invalid values', () => {
    assert.equal(parseAudioSensitivity(null), 1.5)
    assert.equal(parseAudioSensitivity(undefined), 1.5)
    assert.equal(parseAudioSensitivity(''), 1.5)
    assert.equal(parseAudioSensitivity('foo'), 1.5)
    assert.equal(parseAudioSensitivity(NaN), 1.5)
    assert.equal(parseAudioSensitivity(Infinity), 1.5)
    assert.equal(parseAudioSensitivity(true), 1.5)
    assert.equal(parseAudioSensitivity(false), 1.5)
    assert.equal(parseAudioSensitivity({}), 1.5)
    assert.equal(parseAudioSensitivity('{"sensitivity":"bad"}'), 1.5)
})

test('parseAudioSensitivity parses numeric strings, numbers, and JSON payloads', () => {
    assert.equal(parseAudioSensitivity(2.4), 2.4)
    assert.equal(parseAudioSensitivity('2.4'), 2.4)
    assert.equal(parseAudioSensitivity({ sensitivity: 2.8 }), 2.8)
    assert.equal(parseAudioSensitivity(JSON.stringify({ sensitivity: 3.1 })), 3.1)
    // Raw numeric string in JSON
    assert.equal(parseAudioSensitivity('3.5'), 3.5)
})

test('parseAudioSensitivity clamps to [0.5, 4.0] slider range and rounds to 0.1 step', () => {
    assert.equal(parseAudioSensitivity(0.1), 0.5)
    assert.equal(parseAudioSensitivity(-5), 0.5)
    assert.equal(parseAudioSensitivity(10.0), 4.0)
    assert.equal(parseAudioSensitivity(5.5), 4.0)
    assert.equal(parseAudioSensitivity(2.34), 2.3)
    assert.equal(parseAudioSensitivity(2.36), 2.4)
})

test('loadAudioSensitivity retrieves value from mock storage', () => {
    const storage = createMockStorage({
        [AUDIO_STORAGE_KEY]: JSON.stringify({ sensitivity: 2.7 })
    })
    assert.equal(loadAudioSensitivity(storage), 2.7)
})

test('loadAudioSensitivity falls back to legacy/alias sensitivity key if primary key missing', () => {
    const storage = createMockStorage({
        [AUDIO_SENSITIVITY_STORAGE_KEY]: '3.2'
    })
    assert.equal(loadAudioSensitivity(storage), 3.2)
})

test('loadAudioSensitivity returns default if storage is empty or throws', () => {
    const emptyStorage = createMockStorage()
    assert.equal(loadAudioSensitivity(emptyStorage), 1.5)

    const throwingStorage = {
        getItem() { throw new Error('SecurityError: Private browsing') }
    }
    assert.equal(loadAudioSensitivity(throwingStorage), 1.5)
    assert.equal(loadAudioSensitivity(null), 1.5)
})

test('persistAudioSensitivity stores normalized payload in storage and shallow merges existing keys', () => {
    const storage = createMockStorage({
        [AUDIO_STORAGE_KEY]: JSON.stringify({ deviceId: 'test-mic', existingParam: 42 })
    })
    const ok = persistAudioSensitivity(2.8, storage)
    assert.equal(ok, true)

    const saved = JSON.parse(storage.getItem(AUDIO_STORAGE_KEY))
    assert.deepEqual(saved, { deviceId: 'test-mic', existingParam: 42, sensitivity: 2.8 })
})

test('persistAudioSensitivity handles storage exceptions gracefully', () => {
    const throwingStorage = {
        getItem() { return null },
        setItem() { throw new Error('QuotaExceededError') }
    }
    const ok = persistAudioSensitivity(2.8, throwingStorage)
    assert.equal(ok, false)
})

test('SharedAudio sensitivity getter and constructor options', () => {
    const defaultAudio = new SharedAudio()
    assert.equal(defaultAudio.sensitivity, 1.5)

    const customAudio = new SharedAudio({ sensitivity: 2.2 })
    assert.equal(customAudio.sensitivity, 2.2)

    const numAudio = new SharedAudio(3.0)
    assert.equal(numAudio.sensitivity, 3.0)
})

test('SharedAudio setSensitivity guards against NaN, booleans, and non-finite values', () => {
    const audio = new SharedAudio()
    let changeCount = 0
    audio.onSensitivityChange(() => {
        changeCount++
    })

    audio.setSensitivity(NaN)
    assert.equal(audio.sensitivity, 1.5)
    assert.equal(changeCount, 0)

    audio.setSensitivity(Infinity)
    assert.equal(audio.sensitivity, 1.5)
    assert.equal(changeCount, 0)

    audio.setSensitivity('not-a-number')
    assert.equal(audio.sensitivity, 1.5)
    assert.equal(changeCount, 0)

    audio.setSensitivity(null)
    assert.equal(audio.sensitivity, 1.5)
    assert.equal(changeCount, 0)

    audio.setSensitivity(true)
    assert.equal(audio.sensitivity, 1.5)
    assert.equal(changeCount, 0)
})

test('SharedAudio setSensitivity clamps to slider range [0.5, 4.0] and fires onSensitivityChange listener', () => {
    const audio = new SharedAudio()
    let observed = null
    audio.onSensitivityChange((s) => {
        observed = s
    })

    audio.setSensitivity(2.5)
    assert.equal(audio.sensitivity, 2.5)
    assert.equal(observed, 2.5)

    audio.setSensitivity(0.01)
    assert.equal(audio.sensitivity, 0.5)
    assert.equal(observed, 0.5)

    audio.setSensitivity(5.0)
    assert.equal(audio.sensitivity, 4.0)
    assert.equal(observed, 4.0)
})

test('SharedAudio disable resets meters and emits zeroed meters to onMeters listener', async () => {
    const audio = new SharedAudio()
    let lastMeters = null
    audio.onMeters((m) => {
        lastMeters = { ...m }
    })
    // Simulate non-zero meters while active
    audio.meters.low = 0.8
    audio.meters.mid = 0.5
    audio.meters.high = 0.3
    audio.meters.sub = 0.6
    audio.meters.vol = 0.7

    await audio.disable()

    assert.equal(audio.meters.sub, 0)
    assert.equal(audio.meters.low, 0)
    assert.equal(audio.meters.mid, 0)
    assert.equal(audio.meters.high, 0)
    assert.equal(audio.meters.vol, 0)
    assert.deepEqual(lastMeters, { sub: 0, low: 0, mid: 0, high: 0, vol: 0 })
})

