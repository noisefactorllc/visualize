import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Execute the production Deck class, replacing only its CDN engine boundary.
const source = readFileSync(new URL('../js/noisemaker/deck.js', import.meta.url), 'utf8')
    .replace(/import \{[\s\S]*?\} from '\.\/bundle.js'/, '')
    .replace(/export /g, '')
const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
function deferred() {
    let resolve
    let reject
    const promise = new Promise((r, e) => { resolve = r; reject = e })
    return { promise, resolve, reject }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function harness() {
    const compiles = []
    const engine = { manifest: {}, loadEffects: async () => {}, rendered: '',
        async compile(dsl) {
            const gate = deferred()
            compiles.push({ dsl, ...gate })
            await gate.promise
            this.rendered = dsl
        }, start() { this.isRunning = true }, stop() {},
 dispose() { this.disposeCalls = (this.disposeCalls || 0) + 1 }, }
    const context = vm.createContext({ console, Blob, CanvasRenderer: function () { return engine },
        CDN_BASE: '', extractEffectNamesFromDsl: () => [], extractEffectsFromDsl: () => [] })
    const Deck = vm.runInContext(source + '\nDeck', context)
    const deck = new Deck({})
    deck._initialized = true
    deck._normalizeColorUniforms = () => {}
    return { deck, engine, compiles }
}

test('deck compiles engine text and binds original image references before starting', async () => {
    const h = harness()
    const calls = []
    h.deck.images = [{ id: 'image', dataUrl: 'original bytes' }]
    h.deck._imageTools = {
        stripMediaUrls: () => 'media().write(o0)',
        bindMediaImages: async (renderer, dsl, images) => calls.push({ renderer, dsl, images }),
    }
    const original = 'media(url:"image:image").write(o0)'
    const loaded = h.deck.load(original)
    await flush()
    assert.equal(h.compiles[0].dsl, 'media().write(o0)')
    assert.equal(h.engine.isRunning, undefined)
    h.compiles[0].resolve()
    assert.equal((await loaded).success, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].dsl, original)
    assert.equal(calls[0].images, h.deck.images)
    assert.equal(h.deck.currentDsl, original)
})

// The image tools' imageToBlob: a record's own Blob, or a legacy record's text decoded.
const imageToBlob = image => image.blob instanceof Blob ? image.blob : new Blob([`decoded ${image.dataUrl}`], { type: 'image/png' })

test('choosing a deck image holds its original bytes as a Blob and replaces only the selected media call', async () => {
    const h = harness()
    const file = new Blob(['original-image-bytes'], { type: 'image/png' })
    let asset
    h.deck._currentDsl = 'two media slots'
    const other = { id: 'other', blob: new Blob(['other-image-bytes'], { type: 'image/png' }) }
    h.deck.images = [other]
    h.deck._imageTools = {
        prepareImageFile: async blob => {
            assert.equal(blob.type, 'image/png')
            assert.equal(await blob.text(), 'original-image-bytes')
            asset = { id: 'selected', blob, mimeType: 'image/png', width: 1, height: 1 }
            return asset
        },
        prepareImage: async () => { throw new Error('a text image must not be made') },
        getMediaSources: () => [{}, {}],
        replaceMediaUrls: (dsl, replace) => {
            assert.equal(dsl, 'two media slots')
            assert.equal(replace('image:other', 0), 'image:other')
            assert.equal(replace(null, 1), 'image:selected')
            return 'two bound media slots'
        },
        stripMediaUrls: text => text,
        bindMediaImages: async () => {},
    }
    const selected = h.deck.setImage(file, 1)
    await flush()
    h.compiles[0].resolve()
    assert.equal((await selected).success, true)
    assert.deepEqual(h.deck.images, [other, asset])
    assert.ok(h.deck.images[1].blob instanceof Blob)
    assert.equal(await h.deck.images[1].blob.text(), 'original-image-bytes', 'the chosen file\'s bytes are held for scene storage')
    assert.equal('dataUrl' in h.deck.images[1], false, 'the image is not held as text')
    assert.equal(h.deck.currentDsl, 'two bound media slots')
})

test('a chosen file is read once, so a scene save never reads it from disk again', async () => {
    const h = harness()
    // A picked File reads its disk file on every use; once that file is
    // edited, moved or deleted, every read fails.
    let reads = 0
    class PickedFile extends Blob {
        async arrayBuffer() {
            if (++reads > 1) throw new DOMException('The file could not be read', 'NotReadableError')
            return super.arrayBuffer()
        }
        async text() { throw new DOMException('The file could not be read', 'NotReadableError') }
        stream() { throw new DOMException('The file could not be read', 'NotReadableError') }
        slice() { throw new DOMException('The file could not be read', 'NotReadableError') }
    }
    const file = new PickedFile(['picked-image-bytes'], { type: 'image/png' })
    h.deck._currentDsl = 'one media slot'
    h.deck._imageTools = {
        prepareImageFile: async blob => {
            assert.equal(blob instanceof PickedFile, false, 'the tools get the bytes in memory, not the file')
            return { id: 'picked', blob: new Blob([await blob.arrayBuffer()], { type: 'image/png' }), mimeType: 'image/png' }
        },
        getMediaSources: () => [{}],
        getReferencedImages: (dsl, images) => images.filter(image => image.id === 'picked'),
        imageToBlob,
        replaceMediaUrls: () => 'one bound media slot',
        stripMediaUrls: text => text,
        bindMediaImages: async () => {},
    }
    const selected = h.deck.setImage(file)
    await flush()
    h.compiles[0].resolve()
    assert.equal((await selected).success, true)
    assert.equal(reads, 1, 'the file was read once')
    const [saved] = h.deck.getImageFiles('one bound media slot')
    assert.equal(saved.id, 'picked')
    assert.equal(saved.blob.type, 'image/png')
    assert.equal(Buffer.from(await saved.blob.arrayBuffer()).toString(), 'picked-image-bytes')
    assert.equal(reads, 1, 'saving read the bytes held in memory, not the file')
})

test('a chosen file without a type reaches the image tools as its bytes, and the deck holds their record', async () => {
    const h = harness()
    const file = new Blob(['untyped-image-bytes'])
    let record
    h.deck._currentDsl = 'one media slot'
    h.deck._imageTools = {
        prepareImageFile: async blob => {
            assert.equal(blob.type, '')
            assert.equal(await blob.text(), 'untyped-image-bytes')
            record = { id: 'untyped', blob: new Blob([await blob.arrayBuffer()], { type: 'image/png' }), mimeType: 'image/png' }
            return record
        },
        getMediaSources: () => [{}],
        replaceMediaUrls: () => 'one bound media slot',
        stripMediaUrls: text => text,
        bindMediaImages: async () => {},
    }
    const selected = h.deck.setImage(file)
    await flush()
    h.compiles[0].resolve()
    assert.equal((await selected).success, true)
    assert.equal(h.deck.images.length, 1)
    assert.equal(h.deck.images[0], record)
    assert.equal(h.deck.images[0].blob.type, 'image/png')
    assert.equal(await h.deck.images[0].blob.text(), 'untyped-image-bytes')
})

test('a saved scene takes each image\'s own Blob and decodes only a record without one', () => {
    const h = harness()
    const held = new Blob(['held bytes'], { type: 'image/png' })
    const decodedFrom = []
    h.deck.images = [{ id: 'held', blob: held }, { id: 'shared', dataUrl: 'shared text' }]
    h.deck._imageTools = {
        getReferencedImages: (dsl, images) => {
            assert.equal(dsl, 'two images')
            return images
        },
        imageToBlob: image => {
            if (!image.blob) decodedFrom.push(image.id)
            return imageToBlob(image)
        },
    }
    const files = h.deck.getImageFiles('two images')
    assert.equal(files.length, 2)
    assert.equal(files[0].id, 'held')
    assert.equal(files[0].blob, held)
    assert.equal(files[1].id, 'shared')
    assert.ok(files[1].blob instanceof Blob)
    assert.deepEqual(decodedFrom, ['shared'])
})

test('a scene save fails while a referenced image has no bytes yet', () => {
    const h = harness()
    h.deck._imageTools = {
        getReferencedImages: () => { throw new Error('Image bytes are not available yet; wait for images to load and try again') },
    }
    assert.throws(() => h.deck.getImageFiles('media(url:"image:pending").write(o0)'), /not available yet/)
})

test('recalling a scene prepares its stored images like chosen files, before compiling', async () => {
    const h = harness()
    const id = 'a'.repeat(64)
    const stored = new Blob(['stored bytes'], { type: 'image/png' })
    const record = { id, blob: new Blob(['stored bytes'], { type: 'image/png' }), mimeType: 'image/png' }
    const asked = []
    h.deck.storedImage = async wanted => {
        asked.push(wanted)
        return wanted === id ? stored : null
    }
    h.deck.images = [{ id: 'held', blob: new Blob(['held bytes'], { type: 'image/png' }) }]
    h.deck._imageTools = {
        getMediaSources: () => [
            { url: `image:${id}` }, { url: 'image:held' }, { url: 'image:missing' }, { url: null }, { url: 'https://example.com/a.png' },
        ],
        prepareImageFile: async blob => {
            assert.equal(blob, stored)
            return record
        },
        prepareImage: async () => { throw new Error('a text image must not be made') },
    }
    await h.deck.loadStoredImages('media(url:"image:...").write(o0)')
    assert.deepEqual(asked, [id, 'missing'], 'held images and other URLs are not looked up')
    assert.equal(h.deck.images.length, 2)
    assert.equal(h.deck.images[1], record, 'the stored file is held as a Blob for the next save')
    assert.equal(h.compiles.length, 0)
})

test('recalling a scene saved with text images reads each one once, as bytes, when storage lacks it', async () => {
    const h = harness()
    const inStorage = 'a'.repeat(64), onlyText = 'b'.repeat(64)
    const stored = new Blob(['stored bytes'], { type: 'image/png' })
    const embedded = [{ id: inStorage, dataUrl: 'stored text' }, { id: onlyText, dataUrl: 'legacy text' }]
    h.deck.storedImage = async wanted => wanted === inStorage ? stored : null
    const decoded = []
    h.deck._imageTools = {
        getMediaSources: () => [{ url: `image:${inStorage}` }, { url: `image:${onlyText}` }],
        imageToBlob: image => { decoded.push(image.id); return imageToBlob(image) },
        // Each id names its bytes, as a SHA-256 would.
        prepareImageFile: async blob => ({
            id: (await blob.text()).includes('stored') ? inStorage : onlyText,
            blob: new Blob([await blob.arrayBuffer()], { type: 'image/png' }), mimeType: 'image/png',
        }),
    }
    await h.deck.loadStoredImages('media(url:"image:...").write(o0)', embedded)
    assert.deepEqual(decoded, [onlyText], 'the stored file wins over the scene\'s text')
    assert.deepEqual([...h.deck.images].map(image => image.id), [inStorage, onlyText])
    assert.ok(h.deck.images.every(image => image.blob instanceof Blob && !('dataUrl' in image)), 'no image is held as text')
    assert.equal(await h.deck.images[1].blob.text(), 'decoded legacy text')

    // A deck without image storage still reads a scene's text images, as bytes.
    const bare = harness()
    bare.deck._imageTools = h.deck._imageTools
    decoded.length = 0
    await bare.deck.loadStoredImages('media(url:"image:...").write(o0)', embedded)
    assert.deepEqual(decoded, [inStorage, onlyText])
    assert.ok(bare.deck.images.every(image => image.blob instanceof Blob && !('dataUrl' in image)))
})

test('recalling a scene leaves programs without images, or decks without storage, alone', async () => {
    const h = harness()
    h.deck._imageTools = { getMediaSources: () => { throw new Error('must not parse') } }
    h.deck.storedImage = async () => { throw new Error('must not read storage') }
    await h.deck.loadStoredImages('noise().write(o0)')
    h.deck.storedImage = null
    await h.deck.loadStoredImages('media(url:"image:x").write(o0)')
    assert.equal(h.deck.images.length, 0)
})

test('a stored image whose bytes do not match its id fails the recall', async () => {
    const h = harness()
    h.deck.storedImage = async () => new Blob(['other bytes'], { type: 'image/png' })
    h.deck._imageTools = {
        getMediaSources: () => [{ url: `image:${'b'.repeat(64)}` }],
        prepareImageFile: async blob => ({ id: 'c'.repeat(64), blob }),
    }
    await assert.rejects(h.deck.loadStoredImages('media(url:"image:b").write(o0)'), /do not match their id/)
    assert.equal(h.deck.images.length, 0)
})

for (const secondMethod of ['load', 'reloadDsl']) {
    test(`a newer ${secondMethod} waits for the active renderer compile and wins`, async () => {
        const h = harness()
        const first = h.deck.load('old', 'Old')
        await flush()
        const second = h.deck[secondMethod]('new', 'New')
        await flush()
        assert.deepEqual(h.compiles.map(c => c.dsl), ['old'], 'renderer compiles must not overlap')
        h.compiles[0].resolve()
        await flush()
        assert.equal((await first).superseded, true)
        assert.deepEqual(h.compiles.map(c => c.dsl), ['old', 'new'])
        h.compiles[1].resolve()
        assert.equal((await second).success, true)
        assert.equal(h.deck.currentDsl, 'new')
        assert.equal(h.engine.rendered, 'new')
    })
}

test('obsolete queued loads do not compile or report success for publication', async () => {
    const h = harness()
    const first = h.deck.load('old')
    await flush()
    const middle = h.deck.load('middle')
    const latest = h.deck.load('latest')
    h.compiles[0].resolve()
    await flush()
    assert.deepEqual(h.compiles.map(c => c.dsl), ['old', 'latest'])
    assert.equal((await first).superseded, true)
    assert.equal((await middle).superseded, true)
    h.compiles[1].resolve()
    assert.equal((await latest).success, true)
})

function editorHarness() {
    const editor = { value: 'old' }
    const loads = []
    const published = []
    const context = vm.createContext({ editor, deckId: 'A', console,
        state: { decks: { A: { load(text) {
            const gate = deferred()
            loads.push({ text, ...gate })
            return gate.promise
        } } } }, setCollaborativeDeckText() {}, showDeckEditorError() {},
        clearDeckEditorError() {}, audio: { refreshDeckStates() {} }, deckLabels: {},
        publishDeckDsl: () => published.push(editor.value), updateLed() {},
    })
    const fn = appSource.indexOf('            async function compileFromEditor()')
    const end = appSource.indexOf('            // Hot reload', fn)
    vm.runInContext('let inFlight = false;\n' + appSource.slice(fn, end), context)
    return { editor, loads, published, compile: context.compileFromEditor }
}

test('editor changes during a long compile are not dropped by the next hot reload', async () => {
    const h = editorHarness()
    const first = h.compile()
    h.editor.value = 'new'
    const second = h.compile()
    assert.deepEqual(h.loads.map(l => l.text), ['old', 'new'])
    h.loads[0].resolve({ success: false, superseded: true })
    h.loads[1].resolve({ success: true })
    await Promise.all([first, second])
    assert.deepEqual(h.published, ['new'])
})

test('an old editor compile cannot publish over a draft typed before its next debounce', async () => {
    const h = editorHarness()
    const first = h.compile()
    h.editor.value = 'new'
    h.loads[0].resolve({ success: true })
    await first
    assert.deepEqual(h.published, [])
})

test('a failed compile releases the queue and a rebind reload preserves its metadata', async () => {
    const h = harness()
    const bad = h.deck.load('invalid')
    await flush()
    h.compiles[0].reject(new Error('invalid program'))
    assert.equal((await bad).success, false)
    h.deck._currentName = 'Original'
    h.deck.rebind.originalDsl = 'original'
    h.deck.rebind.overrides = { scale: 2 }
    const good = h.deck.reloadDsl('rebound')
    await flush()
    h.compiles[1].resolve()
    assert.equal((await good).success, true)
    assert.equal(h.deck.currentDsl, 'rebound')
    assert.equal(h.deck.currentName, 'Original')
    assert.equal(h.deck.rebind.originalDsl, 'original')
    assert.deepEqual(h.deck.rebind.overrides, { scale: 2 })
})

test('a newer failed load leaves metadata matching the older successful renderer result', async () => {
    const h = harness()
    h.deck._currentDsl = h.engine.rendered = 'original'
    const old = h.deck.load('valid', 'Valid')
    await flush()
    const bad = h.deck.load('invalid', 'Invalid')
    h.compiles[0].resolve()
    await flush()
    assert.equal((await old).superseded, true, 'obsolete callers still must not publish')
    h.compiles[1].reject(new Error('invalid program'))
    assert.equal((await bad).success, false)
    assert.equal(h.engine.rendered, 'valid')
    assert.equal(h.deck.currentDsl, 'valid')
    assert.equal(h.deck.currentName, 'Valid')
    assert.equal(h.deck.rebind.originalDsl, 'valid')
})

test('a queued rebind retains its source metadata after an older load completes', async () => {
    const h = harness()
    h.deck._currentName = 'Original'
    h.deck.rebind.originalDsl = 'original'
    const old = h.deck.load('interim', 'Interim')
    await flush()
    h.deck.rebind.overrides = { scale: 2 }
    const next = h.deck.reloadDsl('rebound original')
    h.compiles[0].resolve()
    await flush()
    await old
    h.compiles[1].resolve()
    assert.equal((await next).success, true)
    assert.equal(h.deck.currentDsl, 'rebound original')
    assert.equal(h.deck.currentName, 'Original')
    assert.equal(h.deck.rebind.originalDsl, 'original')
    assert.deepEqual(h.deck.rebind.overrides, { scale: 2 })
})

test('disposing during compilation cannot restart the deck or adopt its late result', async () => {
    const h = harness()
    const pending = h.deck.load('late')
    await flush()
    h.deck.dispose()
    h.compiles[0].resolve()
    assert.equal((await pending).superseded, true)
    assert.equal(h.deck.currentDsl, '')
    assert.equal(h.deck.isRunning, false)
})

test('cancelPending invalidates an in-flight load while loading effects before compilation', async () => {
    const compiles = []
    const effectGates = []
    const engine = {
        manifest: {},
        async loadEffects(ids) {
            const gate = deferred()
            effectGates.push({ ids, ...gate })
            await gate.promise
        },
        rendered: '',
        async compile(dsl) {
            const gate = deferred()
            compiles.push({ dsl, ...gate })
            await gate.promise
            this.rendered = dsl
        },
        start() { this.isRunning = true }, stop() {}, dispose() {},
    }
    const context = vm.createContext({
        console,
        CanvasRenderer: function () { return engine },
        CDN_BASE: '',
        extractEffectNamesFromDsl: () => [{ effectId: 'fx1' }]
    })
    const Deck = vm.runInContext(source + '\nDeck', context)
    const deck = new Deck({})
    deck._initialized = true
    deck._normalizeColorUniforms = () => {}

    const loadPromise = deck.load('pending-fx', 'PendingFx')
    await flush()
    assert.equal(effectGates.length, 1)
    assert.equal(compiles.length, 0, 'compilation should not start before effects load')

    deck.cancelPending()
    effectGates[0].resolve()
    const res = await loadPromise

    assert.equal(res.superseded, true)
    assert.equal(res.success, false)
    assert.equal(compiles.length, 0, 'cancelled load must never call compile()')
    assert.equal(deck.currentDsl, '')
    assert.equal(deck.currentName, '')
})

test('cancelPending marks an in-flight compiling load as superseded', async () => {
    const h = harness()
    const loadPromise = h.deck.load('pending', 'Pending')
    await flush()
    assert.equal(h.compiles.length, 1)
    h.deck.cancelPending()
    h.compiles[0].resolve()
    const res = await loadPromise
    assert.equal(res.superseded, true)
    assert.equal(res.success, false)
})

test('cancelPending invalidates a queued load so it never compiles', async () => {
    const h = harness()
    const first = h.deck.load('first', 'First')
    await flush()
    const second = h.deck.load('second', 'Second')
    await flush()
    h.deck.cancelPending()
    h.compiles[0].resolve()
    await flush()
    assert.equal((await first).superseded, true)
    assert.equal((await second).superseded, true)
    assert.deepEqual(h.compiles.map(c => c.dsl), ['first'])
})

// Long-set memory & resource hygiene: repeated program swaps, rebind
// reloads, cancels, and disposals across a multi-hour set must never
// overlap renderer compiles, leak queued work past a dispose(), or
// abort a successful load because a surface registry looks unexpected.
test('soak: 120 alternating load/reloadDsl cycles with interleaved cancels serialize cleanly', async () => {
    const h = harness()
    const outcomes = []
    let nextCompile = 0
    const pump = () => {
        if (h.compiles.length > nextCompile) {
            h.compiles[nextCompile].resolve()
            nextCompile++
            return true
        }
        return false
    }
    for (let i = 0; i < 120; i++) {
        const dsl = `dsl-${i}`
        const p = i % 2 === 0 ? h.deck.load(dsl, `P${i}`) : h.deck.reloadDsl(dsl)
        outcomes.push(p.then(r => r, e => ({ thrown: e })))
        if (i % 9 === 4) h.deck.cancelPending()
        await flush()
        // The single-compile invariant: a queued request must wait for
        // the in-flight one; at most one unresolved compile may exist.
        assert.ok(h.compiles.length - nextCompile <= 1,
            `iteration ${i}: ${h.compiles.length - nextCompile} unresolved compiles`)
        pump()
        await flush()
    }
    while (pump()) await flush()
    const settled = await Promise.all(outcomes)
    assert.equal(settled.length, 120)
    for (const r of settled) {
        assert.equal(r.thrown, undefined, 'no load may reject during the soak')
        assert.ok(r.success || r.superseded, `unexpected result: ${JSON.stringify(r)}`)
    }
    // The engine's last compiled DSL must equal the deck's published
    // metadata; the rebind source is the last full load (the reloads
    // that follow preserve it).
    assert.equal(h.engine.rendered, h.deck.currentDsl)
    assert.ok(h.compiles.length <= 120, 'cancels must suppress queued compiles')
    assert.ok(h.compiles.length > 0)
    assert.equal(h.deck.rebind.originalDsl, 'dsl-118')
    assert.equal(h.deck._disposed, false)
    // The final request must have actually landed in the engine.
    assert.equal(h.engine.rendered, 'dsl-119')
})

test('dispose rejects queued loads and stays idempotent', async () => {
    const h = harness()
    const inFlight = h.deck.load('first', 'First')
    await flush()
    const queued = h.deck.load('second', 'Second')
    h.deck.dispose()
    h.deck.dispose()
    h.compiles[0].resolve()
    await flush()
    assert.equal((await inFlight).superseded, true)
    assert.equal((await queued).superseded, true)
    assert.deepEqual(h.compiles.map(c => c.dsl), ['first'])
    assert.equal(h.engine.disposeCalls, 1, 'double dispose must not dispose the renderer twice')
})

function surfaceHarness(clearSurface) {
    const h = harness()
    const cleared = []
    h.engine._pipeline = {
        surfaces: new Map([['o0', 'tex0'], ['o1', 'tex1']]),
        clearSurface(name) {
            cleared.push(name)
            if (clearSurface) clearSurface(name)
        }
    }
    return { ...h, cleared }
}

test('a fresh load clears every surface; a rebind reload preserves them', async () => {
    const h = surfaceHarness()
    const fresh = h.deck.load('fresh', 'Fresh')
    await flush()
    h.compiles[0].resolve()
    assert.equal((await fresh).success, true)
    assert.deepEqual(h.cleared, ['o0', 'o1'])
    const rebound = h.deck.reloadDsl('rebound')
    await flush()
    h.compiles[1].resolve()
    assert.equal((await rebound).success, true)
    assert.deepEqual(h.cleared, ['o0', 'o1'], 'rebind reloads must keep simulation surfaces')
})

test('a failing clearSurface warns but never aborts a successful load', async () => {
    const warns = []
    const origWarn = console.warn
    console.warn = (...args) => warns.push(args)
    try {
        const h = surfaceHarness(name => { if (name === 'o1') throw new Error('boom') })
        const pending = h.deck.load('fresh', 'Fresh')
        await flush()
        h.compiles[0].resolve()
        const res = await pending
        assert.equal(res.success, true, 'a surface-clear failure must not fail the load')
        assert.equal(warns.length, 1)
        assert.match(String(warns[0][0]), /\[deck\] clearSurface\(o1\) failed/)
    } finally {
        console.warn = origWarn
    }
})

test('clearSurfaces is a safe no-op for missing pipelines and unusual registries', () => {
    const h = harness()
    h.engine._pipeline = undefined
    h.deck.clearSurfaces() // no throw
    const cleared = []
    h.engine._pipeline = {
        surfaces: { keys: () => ['o0'] },
        clearSurface: name => cleared.push(name)
    }
    h.deck.clearSurfaces()
    assert.deepEqual(cleared, ['o0'])
    h.engine._pipeline = { surfaces: 'not-a-registry', clearSurface: () => {} }
    h.deck.clearSurfaces() // no throw
    h.engine._pipeline = { clearSurface: () => {} } // no surfaces registry
    h.deck.clearSurfaces() // no throw
    assert.deepEqual(cleared, ['o0'])
})

// Invalid deck state (corrupt persisted payload, NaN upstream computation)
// must never stomp a live deck mid-set: the setters reject it and keep
// current state instead of installing NaN/zero values that freeze or
// zero the render pipeline.
function stateHarness() {
    const h = harness()
    const durations = []
    h.engine.setLoopDuration = (dur) => durations.push(dur)
    const resizes = []
    h.engine.resize = (w, bh) => resizes.push([w, bh])
    h.toFiniteNumber = (() => {
        let Deck
        const context = vm.createContext({ console, CanvasRenderer: function () { return h.engine },
            CDN_BASE: '', extractEffectNamesFromDsl: () => [] })
        Deck = vm.runInContext(source + '\ntoFiniteNumber', context)
        return Deck
    })()
    return { ...h, durations, resizes }
}

test('toFiniteNumber accepts finite numbers and numeric strings only', () => {
    const h = stateHarness()
    assert.equal(h.toFiniteNumber(0.5), 0.5)
    assert.equal(h.toFiniteNumber('0.5'), 0.5)
    assert.equal(h.toFiniteNumber(' 2 '), 2)
    assert.equal(h.toFiniteNumber(-3), -3)
    assert.equal(h.toFiniteNumber(''), null)
    assert.equal(h.toFiniteNumber('   '), null)
    assert.equal(h.toFiniteNumber('abc'), null)
    assert.equal(h.toFiniteNumber(NaN), null)
    assert.equal(h.toFiniteNumber(Infinity), null)
    assert.equal(h.toFiniteNumber(-Infinity), null)
    assert.equal(h.toFiniteNumber(null), null)
    assert.equal(h.toFiniteNumber(undefined), null)
    assert.equal(h.toFiniteNumber(true), null)
    assert.equal(h.toFiniteNumber(false), null)
    assert.equal(h.toFiniteNumber({}), null)
})

test('setSpeed rejects corrupt values and keeps the live speed and loop duration', () => {
    const h = stateHarness()
    h.deck.setSpeed(2)
    assert.equal(h.deck._speed, 2)
    h.durations.length = 0
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, true, false, 'abc', '', '  ']) {
        h.deck.setSpeed(bad)
        assert.equal(h.deck._speed, 2, `speed must survive ${String(bad)}`)
        assert.deepEqual(h.durations, [], `renderer must not be reprogrammed for ${String(bad)}`)
    }
})

test('setSpeed accepts numeric strings and clamps to the documented floor', () => {
    const h = stateHarness()
    h.deck.setSpeed('2')
    assert.equal(h.deck._speed, 2)
    assert.equal(h.durations.at(-1), h.deck.loopDuration / 2)
    h.deck.setSpeed(0.001)
    assert.equal(h.deck._speed, 0.05)
})

test('setPixelDensity rejects corrupt values keeping the live buffer size', () => {
    const h = stateHarness()
    assert.equal(h.deck._pixelDensity, 1.0)
    h.deck.setPixelDensity(0.5)
    assert.equal(h.deck._pixelDensity, 0.5)
    assert.deepEqual(h.resizes.at(-1), [h.deck.width * 0.5, h.deck.height * 0.5])
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, true, false, 'abc', '', '  ']) {
        h.deck.setPixelDensity(bad)
        assert.equal(h.deck._pixelDensity, 0.5, `density must survive ${String(bad)}`)
    }
    assert.equal(h.resizes.length, 1, 'rejected densities must not touch the renderer')
    // Numeric strings are coerced; out-of-range clamps to [0.1, 1].
    h.deck.setPixelDensity('0.25')
    assert.equal(h.deck._pixelDensity, 0.25)
    h.deck.setPixelDensity('5')
    assert.equal(h.deck._pixelDensity, 1.0)
})

test('setBaseLoopDuration rejects non-finite and non-positive values', () => {
    const h = stateHarness()
    h.deck.loopDuration = 10
    h.deck.setSpeed(1)
    h.durations.length = 0
    for (const bad of [NaN, Infinity, 0, -5, null, undefined, true, false, 'abc', '', '  ']) {
        h.deck.setBaseLoopDuration(bad)
        assert.equal(h.deck.loopDuration, 10, `base loop must survive ${String(bad)}`)
        assert.deepEqual(h.durations, [], `renderer must not be reprogrammed for ${String(bad)}`)
    }
    h.deck.setBaseLoopDuration('20')
    assert.equal(h.deck.loopDuration, 20)
    assert.deepEqual(h.durations, [20])
})

test('resize and syncTimeOrigin reject corrupt values keeping live state', () => {
    const h = stateHarness()
    h.deck.resize(640, 360)
    assert.equal(h.deck.width, 640)
    assert.equal(h.deck.height, 360)
    assert.deepEqual(h.resizes.at(-1), [640, 360])
    const resizesAfter = h.resizes.length
    for (const bad of [[NaN, 360], [640, NaN], [null, null], ['x', 360], [640, true]]) {
        h.deck.resize(...bad)
        assert.equal(h.deck.width, 640, `width must survive ${String(bad)}`)
        assert.equal(h.deck.height, 360, `height must survive ${String(bad)}`)
    }
    assert.equal(h.resizes.length, resizesAfter, 'rejected resizes must not touch the renderer')
    h.deck.syncTimeOrigin(1234)
    assert.equal(h.deck._renderer._loopStartTime, 1234)
    h.deck.syncTimeOrigin(NaN)
    assert.equal(h.deck._renderer._loopStartTime, 1234, 'NaN time origin must not corrupt the loop clock')
})

