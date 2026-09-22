// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { Scenes, validateSceneName, SCENES_STORAGE_KEY } from '../js/scenes.js'

function createMockStorage(initial = {}) {
    const data = new Map(Object.entries(initial))
    return {
        getItem(key) {
            return data.has(key) ? data.get(key) : null
        },
        setItem(key, value) {
            data.set(key, String(value))
        },
        removeItem(key) {
            data.delete(key)
        },
        clear() {
            data.clear()
        },
        dump(key) {
            const raw = data.get(key)
            return raw ? JSON.parse(raw) : null
        }
    }
}

function createDummySnapshot(tag = 'test') {
    return {
        createdAt: 1000,
        decks: {
            A: { title: `Deck A ${tag}`, dsl: 'search()', speed: 1, rebind: null },
            B: { title: `Deck B ${tag}`, dsl: 'invert()', speed: 1.5, rebind: null }
        },
        xfade: 0.5,
        curve: 'dipped',
        bpm: 124,
        divider: 1,
        fx: { strobe: false, invert: true },
        autoMix: null,
        autoXfade: null,
        mixer: null,
        deckDensity: null
    }
}

test('validateSceneName: rejects empty and whitespace-only names', () => {
    const emptyResults = [
        validateSceneName(''),
        validateSceneName('   '),
        validateSceneName('\t\n'),
        validateSceneName(null),
        validateSceneName(undefined),
        validateSceneName(123),
        validateSceneName({}),
        validateSceneName(false)
    ]

    for (const res of emptyResults) {
        assert.equal(res.ok, false)
        assert.equal(res.success, false)
        assert.equal(res.error, 'empty')
        assert.match(res.message, /empty/i)
    }
})

test('validateSceneName: trims whitespace and clamps to 40 characters', () => {
    const normal = validateSceneName('  Opening Set  ')
    assert.equal(normal.ok, true)
    assert.equal(normal.name, 'Opening Set')

    const longName = 'A'.repeat(50)
    const clamped = validateSceneName(longName)
    assert.equal(clamped.ok, true)
    assert.equal(clamped.name.length, 40)
    assert.equal(clamped.name, 'A'.repeat(40))
})

test('validateSceneName: rejects duplicates against existing scene names', () => {
    const existing = [
        { name: 'Warmup' },
        { name: 'Peak Time' },
        { name: 'Ambient Outro' }
    ]

    // Exact duplicate
    const res1 = validateSceneName('Warmup', null, existing)
    assert.equal(res1.ok, false)
    assert.equal(res1.error, 'duplicate')
    assert.match(res1.message, /already exists/i)

    // Case-insensitive duplicate
    const res2 = validateSceneName('peak time', null, existing)
    assert.equal(res2.ok, false)
    assert.equal(res2.error, 'duplicate')
    assert.match(res2.message, /already exists/i)

    // Leading/trailing whitespace duplicate
    const res3 = validateSceneName('  Ambient Outro  ', null, existing)
    assert.equal(res3.ok, false)
    assert.equal(res3.error, 'duplicate')

    // Accepts existingScenes formatted as plain strings
    const strScenes = ['Intro', 'Breakdown']
    const res4 = validateSceneName('intro', null, strScenes)
    assert.equal(res4.ok, false)
    assert.equal(res4.error, 'duplicate')

    // Valid unique name
    const res5 = validateSceneName('Encore', null, existing)
    assert.equal(res5.ok, true)
    assert.equal(res5.name, 'Encore')
})

test('validateSceneName: allows keeping current name or updating case when currentName is provided', () => {
    const existing = [
        { name: 'Warmup' },
        { name: 'Peak Time' }
    ]

    // Identical name for the current scene
    const res1 = validateSceneName('Warmup', 'Warmup', existing)
    assert.equal(res1.ok, true)
    assert.equal(res1.name, 'Warmup')
    assert.equal(res1.unchanged, true)

    // Case change on the current scene
    const res2 = validateSceneName('warmup', 'Warmup', existing)
    assert.equal(res2.ok, true)
    assert.equal(res2.name, 'warmup')
    assert.equal(res2.unchanged, false)

    // But colliding with a DIFFERENT existing scene is rejected
    const res3 = validateSceneName('Peak Time', 'Warmup', existing)
    assert.equal(res3.ok, false)
    assert.equal(res3.error, 'duplicate')
})

test('Scenes.validateName (static and instance) behaves consistently', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Scene 1', createDummySnapshot('1'))
    scenes.save('Scene 2', createDummySnapshot('2'))

    // Instance check
    assert.equal(scenes.validateName('').ok, false)
    assert.equal(scenes.validateName('Scene 1').ok, false)
    assert.equal(scenes.validateName('Scene 1', 'Scene 1').ok, true)
    assert.equal(scenes.validateName('Scene 3').ok, true)

    // Static check
    assert.equal(Scenes.validateName('Scene 1', null, scenes.scenes).ok, false)
    assert.equal(Scenes.validateName('Unique', null, scenes.scenes).ok, true)
})

test('Scenes.prototype.rename: rejects non-existent old scene name', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Initial', createDummySnapshot('init'))

    const notFound1 = scenes.rename('NonExistent', 'NewName')
    assert.equal(notFound1.ok, false)
    assert.equal(notFound1.error, 'not_found')

    const notFound2 = scenes.rename('', 'NewName')
    assert.equal(notFound2.ok, false)
    assert.equal(notFound2.error, 'not_found')

    const notFound3 = scenes.rename(null, 'NewName')
    assert.equal(notFound3.ok, false)
    assert.equal(notFound3.error, 'not_found')
})

test('Scenes.prototype.rename: rejects empty or duplicate new name without mutating state', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Alpha', createDummySnapshot('alpha'))
    scenes.save('Beta', createDummySnapshot('beta'))

    let emitCount = 0
    scenes.onChange(() => { emitCount++ })

    // Empty name
    const emptyRes = scenes.rename('Alpha', '   ')
    assert.equal(emptyRes.ok, false)
    assert.equal(emptyRes.error, 'empty')
    assert.equal(emitCount, 0)
    assert.equal(scenes.byName('Alpha').name, 'Alpha')

    // Duplicate name
    const dupRes = scenes.rename('Alpha', 'Beta')
    assert.equal(dupRes.ok, false)
    assert.equal(dupRes.error, 'duplicate')
    assert.equal(emitCount, 0)
    assert.equal(scenes.byName('Alpha').name, 'Alpha')

    // Case-insensitive duplicate
    const caseDupRes = scenes.rename('Alpha', 'beta')
    assert.equal(caseDupRes.ok, false)
    assert.equal(caseDupRes.error, 'duplicate')
    assert.equal(emitCount, 0)
})

test('Scenes.prototype.rename: no-op when new name equals current name', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Alpha', createDummySnapshot('alpha'))

    let emitCount = 0
    scenes.onChange(() => { emitCount++ })

    const res = scenes.rename('Alpha', 'Alpha')
    assert.equal(res.ok, true)
    assert.equal(res.unchanged, true)
    assert.equal(res.name, 'Alpha')
    assert.equal(emitCount, 0) // Unchanged should not trigger unnecessary emit/persist
})

test('Scenes.prototype.rename: successfully renames scene in place, persisting and preserving order/data', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Scene A', createDummySnapshot('A'))
    scenes.save('Scene B', createDummySnapshot('B'))
    scenes.save('Scene C', createDummySnapshot('C'))

    let emitPayload = null
    scenes.onChange((list) => { emitPayload = list })

    // Rename middle scene (index 1)
    const res = scenes.rename('Scene B', 'Scene B Prime')
    assert.equal(res.ok, true)
    assert.equal(res.success, true)
    assert.equal(res.name, 'Scene B Prime')
    assert.equal(res.prevName, 'Scene B')

    // Order/index preservation for Shift+1..9 hotkeys
    assert.equal(scenes.scenes.length, 3)
    assert.equal(scenes.byIndex(0).name, 'Scene A')
    assert.equal(scenes.byIndex(1).name, 'Scene B Prime')
    assert.equal(scenes.byIndex(2).name, 'Scene C')

    // Snapshot data integrity preserved
    assert.equal(scenes.byIndex(1).decks.A.title, 'Deck A B')
    assert.equal(scenes.byIndex(1).decks.B.speed, 1.5)
    assert.equal(scenes.byIndex(1).xfade, 0.5)
    assert.equal(scenes.byIndex(1).bpm, 124)

    // Lookup methods
    assert.equal(scenes.byName('Scene B'), null)
    assert.ok(scenes.byName('Scene B Prime'))

    // Listener was notified with updated list
    assert.ok(emitPayload)
    assert.equal(emitPayload[1].name, 'Scene B Prime')

    // Storage was persisted with updated list
    const persisted = storage.dump(SCENES_STORAGE_KEY)
    assert.equal(persisted[1].name, 'Scene B Prime')

    // Reloading from storage retains the renamed scene
    const reloaded = new Scenes({ storage })
    assert.equal(reloaded.byIndex(1).name, 'Scene B Prime')
})

test('Scenes.prototype.rename: accepts scene object as first argument', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Scene 1', createDummySnapshot('1'))

    const sceneObj = scenes.byIndex(0)
    const res = scenes.rename(sceneObj, 'Scene 1 Renamed')
    assert.equal(res.ok, true)
    assert.equal(res.name, 'Scene 1 Renamed')
    assert.equal(scenes.byIndex(0).name, 'Scene 1 Renamed')
})

test('Scenes.prototype.rename: exact match has precedence over case-insensitive match', () => {
    const storage = createMockStorage()
    // Simulate legacy storage containing differing-case entries
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([
        { name: 'chill', decks: {}, bpm: 120 },
        { name: 'Chill', decks: {}, bpm: 125 }
    ]))
    const scenes = new Scenes({ storage })

    // Renaming 'Chill' with exact case must target index 1 ('Chill'), not index 0 ('chill')
    const res = scenes.rename('Chill', 'Relaxed')
    assert.equal(res.ok, true)
    assert.equal(scenes.byIndex(0).name, 'chill')
    assert.equal(scenes.byIndex(1).name, 'Relaxed')
})
