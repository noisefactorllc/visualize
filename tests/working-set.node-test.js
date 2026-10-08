// SPDX-License-Identifier: MIT
// WorkingSet storage regression tests: validation, round-trip and
// quota refusal for the saved live set (js/workingSet.js).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    WORKING_SET_STORAGE_KEY,
    isValidWorkingSet,
    loadWorkingSet,
    saveWorkingSet
} from '../js/workingSet.js'

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial))
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: key => map.delete(key)
    }
}

function snapshot(overrides = {}) {
    return {
        createdAt: 1234,
        decks: {
            A: { title: 'One', dsl: 'search classicNoisedeck\nrender(o0)', speed: 1, rebind: { originalDsl: '', bandpass: true, oscillatorCount: 0, overrides: {} } },
            B: { title: 'Two', dsl: 'search classicNoisedeck\nnoise().write(o0)\nrender(o0)', speed: 1.2, rebind: { originalDsl: '', bandpass: true, oscillatorCount: 0, overrides: {} } }
        },
        xfade: 0.7,
        curve: 'dipped',
        bpm: 120,
        divider: 1,
        fx: { strobe: false, invert: true, bw: false, zoom: false, freeze: false },
        autoMix: { enabled: false, barsPerScene: 8, curve: 'dipped' },
        autoXfade: null,
        mixer: { id: 'blend', overrides: {} },
        deckDensity: { A: { mode: 'manual', value: 0.5 }, B: { mode: 'manual', value: 0.5 } },
        ...overrides
    }
}

test('WORKING_SET_STORAGE_KEY names its own localStorage key', () => {
    assert.equal(WORKING_SET_STORAGE_KEY, 'visualize.workingSet.v1')
})

test('save + load round-trips a snapshot with a version stamp', () => {
    const storage = fakeStorage()
    const snap = snapshot()
    assert.equal(saveWorkingSet(snap, storage), true)
    const loaded = loadWorkingSet(storage)
    assert.ok(loaded, 'saved set must load back')
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.decks, snap.decks)
    assert.equal(loaded.xfade, snap.xfade)
    assert.equal(loaded.fx.invert, true)
})

test('loadWorkingSet returns null for a missing key', () => {
    assert.equal(loadWorkingSet(fakeStorage()), null)
})

test('loadWorkingSet returns null for corrupt JSON', () => {
    assert.equal(loadWorkingSet(fakeStorage({ [WORKING_SET_STORAGE_KEY]: '{not json' })), null)
})

test('loadWorkingSet rejects snapshots without a known version', () => {
    const storage = fakeStorage()
    saveWorkingSet(snapshot(), storage)
    const raw = JSON.parse(storage.getItem(WORKING_SET_STORAGE_KEY))
    raw.version = 999
    storage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify(raw))
    assert.equal(loadWorkingSet(storage), null)
})

test('isValidWorkingSet requires at least one deck with a program', () => {
    assert.equal(isValidWorkingSet({ ...snapshot(), version: 1 }), true)
    const empty = snapshot({
        decks: { A: { title: '', dsl: '' }, B: { title: '', dsl: '' } }
    })
    assert.equal(isValidWorkingSet(empty), false)
})

test('isValidWorkingSet rejects malformed decks and non-objects', () => {
    assert.equal(isValidWorkingSet(null), false)
    assert.equal(isValidWorkingSet('set'), false)
    assert.equal(isValidWorkingSet({ version: 1 }), false)
    const badDeck = { ...snapshot(), version: 1 }
    badDeck.decks.A.dsl = 42
    assert.equal(isValidWorkingSet(badDeck), false)
})

test('saveWorkingSet returns false when storage refuses the write', () => {
    const full = {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError') }
    }
    assert.equal(saveWorkingSet(snapshot(), full), false)
})

test('loadWorkingSet returns null when storage is unavailable', () => {
    assert.equal(loadWorkingSet(null), null)
})
