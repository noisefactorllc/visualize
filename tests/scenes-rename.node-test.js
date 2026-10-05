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

const RED = { id: 'a'.repeat(64), dataUrl: 'data:image/png;base64,UkVE' }
const GREEN = { id: 'b'.repeat(64), dataUrl: 'data:image/png;base64,R1JFRU4=' }
const imageDsl = id => `search synth\nmedia(url: "image:${id}").write(o0)\nrender(o0)`
const applyTo = decks => ({ decks, scheduler: {}, setXfade() {}, setCurve() {}, setFx() {}, setAutoMixConfig() {} })

/** A deck as scenes saved it before images had their own storage. */
function legacyDeck(images) {
    const dsl = images.length ? imageDsl(images[0].id) : 'search synth\nnoise().write(o0)\nrender(o0)'
    return { title: 'Deck', dsl, images, speed: 1, rebind: { originalDsl: dsl, bandpass: true, oscillatorCount: 0, overrides: {} } }
}

function legacyScene(name, a = [], b = []) {
    return { name, ...createDummySnapshot(name), decks: { A: legacyDeck(a), B: legacyDeck(b) } }
}

async function quietly(work) {
    const error = console.error
    console.error = () => {}
    try { return await work() } finally { console.error = error }
}

test('a saved scene keeps its image references and never image bytes', () => {
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    const asked = []
    const deck = {
        currentDsl: imageDsl(RED.id), currentName: 'Picture', rebind: { originalDsl: imageDsl(RED.id) },
        images: [RED],
        getImageFiles(dsl) { asked.push(dsl); return [{ id: RED.id, blob: file }] },
    }
    const decks = { A: deck, B: deck }
    const snapshot = Scenes.snapshot({ decks, getXfade: () => 0, getCurve: () => 'linear', scheduler: {}, getFxState: () => ({}), getAutoMixConfig: () => ({}) })
    assert.deepEqual(Scenes.imageFiles(snapshot, decks), [{ id: RED.id, blob: file }, { id: RED.id, blob: file }])
    assert.deepEqual(asked, [imageDsl(RED.id), imageDsl(RED.id)])
    const storage = createMockStorage()
    assert.equal(new Scenes({ storage }).save('Images', snapshot), true)
    assert.equal(storage.getItem(SCENES_STORAGE_KEY).includes('data:'), false)
    const saved = new Scenes({ storage }).byName('Images')
    for (const id of ['A', 'B']) {
        assert.equal(saved.decks[id].dsl, imageDsl(RED.id))
        assert.equal('images' in saved.decks[id], false)
    }
})

test('recall readies each deck\'s stored images before that deck compiles', async () => {
    const scene = { name: 'Images', decks: {
        A: { title: 'Picture', dsl: imageDsl(RED.id), speed: 1, rebind: { originalDsl: imageDsl(RED.id) } },
        B: { title: 'Picture', dsl: imageDsl(GREEN.id), speed: 1, rebind: null },
    } }
    const order = []
    const target = name => ({
        rebind: {}, images: [{ id: 'previous', dataUrl: 'previous text' }], setSpeed() {},
        async loadStoredImages(dsl) {
            assert.deepEqual(this.images, [], 'a scene brings no embedded images')
            order.push(`${name} images ${dsl}`)
        },
        async load(dsl) {
            order.push(`${name} compile ${dsl}`)
            return { success: true }
        },
    })
    assert.deepEqual(await Scenes.apply(scene, applyTo({ A: target('A'), B: target('B') })), [])
    assert.deepEqual(order, [
        `A images ${imageDsl(RED.id)}`, `A compile ${imageDsl(RED.id)}`,
        `B images ${imageDsl(GREEN.id)}`, `B compile ${imageDsl(GREEN.id)}`,
    ])
})

test('a recall whose stored image cannot be prepared reports it and still recalls the other deck', async () => {
    const scene = { name: 'Images', decks: {
        A: { title: 'Picture', dsl: imageDsl(RED.id), speed: 1 },
        B: { title: 'Plain', dsl: 'noise().write(o0)', speed: 1 },
    } }
    const compiled = []
    const target = name => ({ rebind: {}, images: [], setSpeed() {},
        async loadStoredImages() { if (name === 'A') throw new Error('Stored image bytes do not match their id') },
        async load() { compiled.push(name); return { success: true } } })
    const errors = await Scenes.apply(scene, applyTo({ A: target('A'), B: target('B') }))
    assert.deepEqual(errors, ['deck A: Stored image bytes do not match their id'])
    assert.deepEqual(compiled, ['B'])
})

test('a scene saved before image storage is recalled from its embedded images', async () => {
    const scene = { name: 'Old', decks: { A: legacyDeck([RED]) } }
    let compiled = false
    const deck = { rebind: {}, images: [], setSpeed() {}, async loadStoredImages() {},
        async load() { assert.deepEqual(this.images, [RED]); compiled = true; return { success: true } } }
    assert.deepEqual(await Scenes.apply(scene, applyTo({ A: deck, B: deck })), [])
    assert.equal(compiled, true)
})

test('moving embedded images strips the text only after each image is stored, once per image', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([
        legacyScene('Red and green', [RED], [GREEN]),
        legacyScene('Red again', [RED]),
        legacyScene('Plain'),
    ]))
    const scenes = new Scenes({ storage })
    let emitted = 0
    scenes.onChange(() => emitted++)
    const received = []
    const moved = await scenes.moveEmbeddedImages(async images => {
        assert.ok(storage.getItem(SCENES_STORAGE_KEY).includes(images[0].dataUrl), 'the text stays until its bytes are stored')
        received.push(...images)
    })
    assert.equal(moved, 3)
    assert.deepEqual(received, [RED, GREEN])
    const stored = storage.dump(SCENES_STORAGE_KEY)
    assert.equal(JSON.stringify(stored).includes('data:'), false)
    assert.deepEqual(stored.map(scene => scene.name), ['Red and green', 'Red again', 'Plain'])
    assert.equal(stored[0].decks.A.dsl, imageDsl(RED.id))
    assert.equal(stored[0].decks.B.dsl, imageDsl(GREEN.id))
    assert.equal('images' in stored[0].decks.A, false)
    assert.equal('images' in stored[0].decks.B, false)
    assert.equal('images' in stored[1].decks.A, false)
    assert.deepEqual(stored[1].decks.B.images, [], 'an empty list carries no image and is left alone')
    assert.equal('images' in scenes.byName('Red again').decks.A, false, 'memory matches storage')
    assert.equal(emitted, 1)
    assert.equal(await scenes.moveEmbeddedImages(async () => { throw new Error('nothing is left to move') }), 0)
})

test('a deck whose image cannot be stored keeps all of its embedded images', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([legacyScene('Mixed', [RED, GREEN], [RED])]))
    const scenes = new Scenes({ storage })
    const moved = await quietly(() => scenes.moveEmbeddedImages(async images => {
        if (images[0].id === GREEN.id) throw new Error('IndexedDB unavailable')
    }))
    assert.equal(moved, 1)
    const stored = storage.dump(SCENES_STORAGE_KEY)[0]
    assert.deepEqual(stored.decks.A.images, [RED, GREEN])
    assert.equal('images' in stored.decks.B, false)
})

test('nothing is written when no image can be stored', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([legacyScene('Legacy', [RED])]))
    const before = storage.getItem(SCENES_STORAGE_KEY)
    const scenes = new Scenes({ storage })
    let writes = 0
    const setItem = storage.setItem
    storage.setItem = (...args) => { writes++; return setItem(...args) }
    assert.equal(await quietly(() => scenes.moveEmbeddedImages(async () => { throw new Error('IndexedDB unavailable') })), 0)
    assert.equal(writes, 0)
    assert.equal(storage.getItem(SCENES_STORAGE_KEY), before)
    assert.deepEqual(scenes.byName('Legacy').decks.A.images, [RED])
})

test('a scene saved while images are moving is kept', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([legacyScene('Legacy', [RED])]))
    const scenes = new Scenes({ storage })
    assert.equal(await scenes.moveEmbeddedImages(async () => {
        assert.equal(new Scenes({ storage }).save('Saved meanwhile', createDummySnapshot('meanwhile')), true)
    }), 1)
    const stored = storage.dump(SCENES_STORAGE_KEY)
    assert.deepEqual(stored.map(scene => scene.name), ['Legacy', 'Saved meanwhile'])
    assert.equal('images' in stored[0].decks.A, false)
    assert.ok(scenes.byName('Saved meanwhile'))
})

test('a failed write leaves storage and memory with the embedded images', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([legacyScene('Legacy', [RED])]))
    const before = storage.getItem(SCENES_STORAGE_KEY)
    const scenes = new Scenes({ storage })
    storage.setItem = () => { throw new Error('Quota exceeded') }
    assert.equal(await quietly(() => scenes.moveEmbeddedImages(async () => {})), 0)
    assert.equal(storage.getItem(SCENES_STORAGE_KEY), before)
    assert.deepEqual(scenes.byName('Legacy').decks.A.images, [RED])
})

test('a scene list that cannot be re-read is never written back', async () => {
    const storage = createMockStorage()
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([legacyScene('Legacy', [RED])]))
    const scenes = new Scenes({ storage })
    let writes = 0
    const setItem = storage.setItem
    storage.setItem = (...args) => { writes++; return setItem(...args) }
    assert.equal(await scenes.moveEmbeddedImages(async () => { storage.getItem = () => '{"corrupt' }), 0)
    assert.equal(writes, 0)
    assert.deepEqual(scenes.byName('Legacy').decks.A.images, [RED])
})

/**
 * localStorage as Chrome bounds it: every key and value counts its characters
 * against 5,242,880 per origin, and a write that does not grow the total is
 * always allowed.
 */
function createQuotaStorage(quota = 5_242_880) {
    const data = new Map()
    const used = () => [...data].reduce((sum, [key, value]) => sum + key.length + value.length, 0)
    return {
        used,
        getItem: key => (data.has(key) ? data.get(key) : null),
        setItem(key, value) {
            const text = String(value)
            const before = used()
            const after = before - (data.has(key) ? key.length + data.get(key).length : 0) + key.length + text.length
            if (after > quota && after > before) {
                throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
            }
            data.set(key, text)
        },
        removeItem: key => { data.delete(key) },
    }
}

test('a localStorage filled by scene images is freed by moving them, and scenes save again', async () => {
    const storage = createQuotaStorage()
    const image = (char, length) => ({ id: char.repeat(64), dataUrl: `data:image/png;base64,${'A'.repeat(length)}` })
    const red = image('a', 1_225_000), green = image('b', 1_225_000), blue = image('c', 1_225_000)
    storage.setItem(SCENES_STORAGE_KEY, JSON.stringify([
        legacyScene('Red and green', [red], [green]),
        legacyScene('Red again', [red]),
        legacyScene('Blue', [blue]),
    ]))
    storage.setItem('visualize.mixer.v1', JSON.stringify({ id: 'blend', overrides: {} }))
    const seeded = storage.used()
    assert.ok(seeded > 4_850_000 && seeded < 5_242_880, `seeded ${seeded} characters`)

    const scenes = new Scenes({ storage })
    const textScene = { ...createDummySnapshot('text'), decks: { A: legacyDeck([image('d', 400_000)]), B: legacyDeck([]) } }
    assert.equal(scenes.save('Saved as text', textScene), false, 'a full localStorage refuses the old format')

    const stored = []
    assert.equal(await scenes.moveEmbeddedImages(async images => { stored.push(images[0].id) }), 4, 'four decks held images')
    assert.deepEqual(stored, [red.id, green.id, blue.id], 'each image is stored once')
    const freed = storage.used()
    assert.ok(freed < 10_000, `${freed} characters left in use`)

    const withImage = { ...createDummySnapshot('new'), decks: { A: { title: 'Picture', dsl: imageDsl('d'.repeat(64)), speed: 1, rebind: null }, B: legacyDeck([]) } }
    assert.equal(scenes.save('After moving', withImage), true)
    const reloaded = new Scenes({ storage })
    assert.deepEqual(reloaded.scenes.map(scene => scene.name), ['Red and green', 'Red again', 'Blue', 'After moving'])
    assert.equal(reloaded.byName('Blue').decks.A.dsl, imageDsl(blue.id))
    assert.equal(reloaded.byName('After moving').decks.A.dsl, imageDsl('d'.repeat(64)))
    assert.equal(JSON.stringify(reloaded.scenes).includes('data:'), false)
})

test('a refused scene image save preserves the previous durable scene and reports failure', () => {
    const storage = createMockStorage()
    const scenes = new Scenes({ storage })
    scenes.save('Before', createDummySnapshot())
    storage.setItem = () => { throw new Error('Quota exceeded') }
    assert.equal(scenes.save('Image', createDummySnapshot()), false)
    assert.equal(scenes.byName('Image'), null)
    assert.ok(scenes.byName('Before'))
})
