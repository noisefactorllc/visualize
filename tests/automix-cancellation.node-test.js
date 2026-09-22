// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { AutoMix } from '../js/automix.js'

function deferred() {
    let resolve, reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function createHarness({ initialXfade = 0.0, enabled = true } = {}) {
    let currentXfade = initialXfade
    const statusMessages = []
    const loadedPrograms = []
    const rebindCalls = []

    let beatCb = () => {}
    const scheduler = {
        beatIndex: 0,
        onBeat(cb) { beatCb = cb },
        fireBeat(beatIndex, isDownbeat = (beatIndex % 4 === 0)) {
            this.beatIndex = beatIndex
            beatCb({ beatIndex, isDownbeat })
        }
    }

    const createMockDeck = (id) => {
        let loadVersion = 0
        const inFlightLoads = []
        return {
            id,
            currentDsl: `dsl-${id}`,
            currentName: `Name-${id}`,
            inFlightLoads,
            cancelPendingCalls: 0,
            cancelPending() {
                this.cancelPendingCalls++
                loadVersion++
            },
            async load(dsl, title) {
                const version = ++loadVersion
                const gate = deferred()
                inFlightLoads.push({ dsl, title, version, gate })
                await gate.promise
                if (version !== loadVersion) {
                    return { success: false, superseded: true }
                }
                this.currentDsl = dsl
                this.currentName = title
                return { success: true }
            }
        }
    }

    const deckA = createMockDeck('A')
    const deckB = createMockDeck('B')

    const library = {
        programs: [
            { dsl: 'prog1', title: 'Program 1' },
            { dsl: 'prog2', title: 'Program 2' },
            { dsl: 'prog3', title: 'Program 3' }
        ],
        _idx: 0,
        randomExcept(exclude) {
            const pool = this.programs.filter(p => !exclude.includes(p.title))
            return pool[this._idx++ % pool.length]
        }
    }

    const rebind = {
        rebindEq(deck, program) {
            rebindCalls.push({ deckId: deck.id, program: program.title })
        }
    }

    const autoMix = new AutoMix({
        library,
        decks: { A: deckA, B: deckB },
        compositor: {},
        scheduler,
        rebind,
        audio: { enabled: true },
        midi: { enabled: false },
        getXfade: () => currentXfade,
        setXfade: (v) => { currentXfade = v },
        onStatus: (msg, persist) => { statusMessages.push({ msg, persist }) },
        onLoad: (deckId, program) => { loadedPrograms.push({ deckId, program }) }
    })

    autoMix.setBarsPerScene(1)
    if (enabled) {
        autoMix.setEnabled(true)
    }

    return {
        autoMix,
        scheduler,
        deckA,
        deckB,
        library,
        statusMessages,
        loadedPrograms,
        rebindCalls,
        getXfade: () => currentXfade,
        setXfade: (v) => { currentXfade = v }
    }
}

test('cancelInFlightSwap cancels pending compilation on incoming deck and suppresses UI updates', async () => {
    const h = createHarness({ initialXfade: 0.0 })
    // At xfade=0, incoming deck is Deck B
    h.scheduler.fireBeat(4, true)

    assert.equal(h.deckB.inFlightLoads.length, 1)
    assert.equal(h.deckB.inFlightLoads[0].title, 'Program 1')

    // Operator initiates fast crossfade / override
    h.autoMix.cancelInFlightSwap()
    assert.equal(h.deckB.cancelPendingCalls, 1)

    // Complete the background compilation gate
    h.deckB.inFlightLoads[0].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Loaded programs and status messages should not have been updated for superseded load
    assert.equal(h.loadedPrograms.length, 0)
    assert.equal(h.rebindCalls.length, 0)
    assert.equal(h.statusMessages.some(s => s.msg.includes('Program 1')), false)
})

test('fast Auto-Mix: a new scene swap cancels obsolete in-flight compilation on incoming deck', async () => {
    const h = createHarness({ initialXfade: 0.0 })
    // Downbeat 1 triggers swap to Deck B
    h.scheduler.fireBeat(4, true)
    assert.equal(h.deckB.inFlightLoads.length, 1)
    assert.equal(h.deckB.cancelPendingCalls, 0)

    // Next downbeat arrives while compilation is still in flight
    h.scheduler.fireBeat(8, true)
    assert.equal(h.deckB.cancelPendingCalls, 1, 'earlier in-flight swap must be cancelled')
    assert.equal(h.deckB.inFlightLoads.length, 2, 'second load started')

    // Resolve the first (stale) load
    h.deckB.inFlightLoads[0].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // No programs or rebinds published yet
    assert.equal(h.loadedPrograms.length, 0)
    assert.equal(h.rebindCalls.length, 0)

    // Resolve the second (current) load
    h.deckB.inFlightLoads[1].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Second program should have loaded successfully
    assert.equal(h.loadedPrograms.length, 1)
    assert.equal(h.loadedPrograms[0].deckId, 'B')
    assert.equal(h.loadedPrograms[0].program.title, 'Program 2')
    assert.equal(h.rebindCalls.length, 1)
})

test('initiating a fast crossfade via noteUserOverride cancels obsolete in-flight compilation', async () => {
    const h = createHarness({ initialXfade: 0.0 })
    // Downbeat triggers swap
    h.scheduler.fireBeat(4, true)
    assert.equal(h.deckB.inFlightLoads.length, 1)

    // Operator triggers auto-fade or hits Cut B
    h.autoMix.noteUserOverride()
    assert.equal(h.deckB.cancelPendingCalls, 1, 'in-flight deck compile must be cancelled')

    // Resolve compilation gate
    h.deckB.inFlightLoads[0].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(h.loadedPrograms.length, 0)
    assert.equal(h.rebindCalls.length, 0)
})

test('disabling Auto-Mix while compilation is in flight cancels it', async () => {
    const h = createHarness({ initialXfade: 0.0 })
    h.scheduler.fireBeat(4, true)
    assert.equal(h.deckB.inFlightLoads.length, 1)

    // Turn auto-mix off
    h.autoMix.setEnabled(false)
    assert.equal(h.deckB.cancelPendingCalls, 1, 'compilation must be cancelled on disable')

    h.deckB.inFlightLoads[0].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(h.loadedPrograms.length, 0)
    assert.equal(h.rebindCalls.length, 0)
})

test('stale swap resolution does not clear incoming deck tracking for a newer active swap', async () => {
    const h = createHarness({ initialXfade: 0.0 })
    // Swap 1 starts targeting Deck B
    h.scheduler.fireBeat(4, true)
    assert.equal(h.deckB.inFlightLoads.length, 1)

    // Swap 2 starts targeting Deck B (cancelling Swap 1)
    h.scheduler.fireBeat(8, true)
    assert.equal(h.deckB.cancelPendingCalls, 1)
    assert.equal(h.deckB.inFlightLoads.length, 2)

    // Swap 1 resolves as superseded
    h.deckB.inFlightLoads[0].gate.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Now user initiates fast crossfade / override while Swap 2 is still in flight
    h.autoMix.noteUserOverride()

    // Swap 2's incoming deck must have been preserved, so Deck B cancelPending is called again
    assert.equal(h.deckB.cancelPendingCalls, 2, 'user override during Swap 2 must cancel Deck B even after Swap 1 resolved')
})

