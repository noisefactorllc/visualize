import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Exercise the production generator without loading the browser-only CDN.
const source = readFileSync(new URL('../js/rebind.js', import.meta.url), 'utf8')
    .replace(/import \{[\s\S]*?\} from '\.\/noisemaker\/bundle.js'/, '')
    .replace(/export /g, '')
const generators = vm.runInNewContext(source + '\n({ buildAudioOverrides, buildMidiOverrides })', { console })

for (const generator of ['buildAudioOverrides', 'buildMidiOverrides']) {
    test(`${generator} supplies the resolved oscillator offset required for valid DSL`, () => {
        const overrides = generators[generator]({
            rebindable: [
                { stepIndex: 0, paramName: 'speed', spec: { min: 0, max: 4 } },
                { stepIndex: 1, paramName: 'scale', spec: { min: 1, max: 100 } },
            ],
            count: 2, oscillatorCount: 2, rand: () => 0.5,
            homeBands: [0], bandpass: true,
        })
        const values = Object.values(overrides).flatMap(Object.values)
        assert.equal(values.length, 2)
        for (const value of values) {
            assert.equal(value.type, 'Oscillator')
            // Noisemaker's resolved-config unparser emits every nonzero
            // offset. Undefined would become the invalid offset: undefined.
            assert.equal(value.offset, 0)
            assert.ok(Number.isFinite(value.min))
            assert.ok(Number.isFinite(value.max))
        }
    })
}

test('rebind: rebinding audio bands on Deck A preserves existing oscillator configurations on Deck B', () => {
    // Model two independent decks in the mixer pipeline
    const deckA = {
        rebind: {
            originalDsl: 'rect().color(1, 0, 0)',
            bandpass: true,
            oscillatorCount: 0,
            overrides: {}
        }
    }
    const deckB = {
        rebind: {
            originalDsl: 'circle().color(0, 1, 0)',
            bandpass: false,
            oscillatorCount: 3,
            overrides: {
                0: {
                    speed: { type: 'Oscillator', oscType: 0, speed: 2, offset: 0, min: 0.1, max: 2.5 },
                    radius: { type: 'Oscillator', oscType: 1, speed: 4, offset: 0, min: 10, max: 80 }
                }
            }
        }
    }

    const initialDeckBOverrides = JSON.parse(JSON.stringify(deckB.rebind.overrides))

    // Rebind audio bands on Deck A (oscillatorCount = 0)
    const rebindableA = [
        { stepIndex: 0, paramName: 'width', spec: { min: 5, max: 50 } },
        { stepIndex: 0, paramName: 'height', spec: { min: 5, max: 50 } }
    ]
    const overridesA = generators.buildAudioOverrides({
        rebindable: rebindableA,
        homeBands: [0],
        bandpass: deckA.rebind.bandpass,
        count: 2,
        oscillatorCount: deckA.rebind.oscillatorCount,
        rand: () => 0.1
    })
    deckA.rebind.overrides = overridesA

    // Deck A must have audio overrides
    const aValues = Object.values(deckA.rebind.overrides).flatMap(Object.values)
    assert.equal(aValues.length, 2)
    for (const val of aValues) {
        assert.equal(val.type, 'Audio')
    }

    // Deck B's oscillator configurations and overrides must be completely untouched
    assert.equal(deckB.rebind.oscillatorCount, 3)
    assert.deepEqual(deckB.rebind.overrides, initialDeckBOverrides)
    assert.equal(deckB.rebind.overrides[0].speed.type, 'Oscillator')
    assert.equal(deckB.rebind.overrides[0].radius.type, 'Oscillator')
})

test('Scenes.snapshot and Scenes.apply preserve and restore oscillatorCount on both decks', async () => {
    const { Scenes } = await import('../js/scenes.js')

    const sourceDecks = {
        A: {
            currentName: 'Bass Bloom',
            currentDsl: 'search()',
            _speed: 1,
            rebind: { originalDsl: 'search()', bandpass: true, oscillatorCount: 1, overrides: {} }
        },
        B: {
            currentName: 'Mid Mirror',
            currentDsl: 'invert()',
            _speed: 1.5,
            rebind: { originalDsl: 'invert()', bandpass: false, oscillatorCount: 3, overrides: {} }
        }
    }

    const snapshot = Scenes.snapshot({
        decks: sourceDecks,
        getXfade: () => 0.4,
        getCurve: () => 'blend',
        scheduler: { divider: 1 },
        getFxState: () => ({}),
        getAutoMixConfig: () => null,
        getMixerState: () => null,
        getDeckDensity: () => null,
        getAutoXfadeConfig: () => null
    })

    assert.equal(snapshot.decks.A.rebind.oscillatorCount, 1)
    assert.equal(snapshot.decks.B.rebind.oscillatorCount, 3)

    // Apply snapshot to target decks with zero initial counts
    const targetDecks = {
        A: {
            rebind: { originalDsl: '', bandpass: false, oscillatorCount: 0, overrides: {} },
            load: async () => ({ success: true }),
            setSpeed: () => {}
        },
        B: {
            rebind: { originalDsl: '', bandpass: true, oscillatorCount: 0, overrides: {} },
            load: async () => ({ success: true }),
            setSpeed: () => {}
        }
    }

    let refreshRebindCalled = false
    await Scenes.apply(snapshot, {
        decks: targetDecks,
        setXfade: () => {},
        setCurve: () => {},
        scheduler: {},
        setFx: () => {},
        setAutoMixConfig: () => {},
        refreshRebind: () => { refreshRebindCalled = true }
    })

    assert.equal(targetDecks.A.rebind.oscillatorCount, 1)
    assert.equal(targetDecks.B.rebind.oscillatorCount, 3)
    assert.equal(refreshRebindCalled, true)
})

test('Scenes.snapshot clamps and safely defaults oscillatorCount', async () => {
    const { Scenes } = await import('../js/scenes.js')

    const testCases = [
        { input: 4, expected: 4 },
        { input: 99, expected: 4 }, // clamped to max 4
        { input: -5, expected: 0 }, // clamped to min 0
        { input: null, expected: 0 },
        { input: undefined, expected: 0 },
        { input: '3', expected: 3 },
        { input: 'invalid', expected: 0 }
    ]

    for (const { input, expected } of testCases) {
        const snap = Scenes.snapshot({
            decks: {
                A: { currentName: 'A', currentDsl: '', _speed: 1, rebind: { originalDsl: '', bandpass: true, oscillatorCount: input, overrides: {} } },
                B: { currentName: 'B', currentDsl: '', _speed: 1, rebind: null }
            },
            getXfade: () => 0.5,
            getCurve: () => 'blend',
            scheduler: { divider: 1 },
            getFxState: () => ({}),
            getAutoMixConfig: () => null,
            getMixerState: () => null,
            getDeckDensity: () => null,
            getAutoXfadeConfig: () => null
        })
        assert.equal(snap.decks.A.rebind.oscillatorCount, expected)
        assert.equal(snap.decks.B.rebind.oscillatorCount, 0)
    }
})
