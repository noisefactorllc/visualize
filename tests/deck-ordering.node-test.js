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
    const context = vm.createContext({ console, CanvasRenderer: function () { return engine },
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

test('choosing a deck image keeps original asset bytes and replaces only the selected media call', async () => {
    const h = harness()
    const asset = { id: 'selected', dataUrl: 'original-image-bytes' }
    const file = new Blob(['original-image-bytes'])
    h.deck._currentDsl = 'two media slots'
    h.deck.images = [{ id: 'other', dataUrl: 'other-image-bytes' }]
    h.deck._imageTools = {
        prepareImage: async blob => { assert.equal(blob, file); return asset },
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
    assert.deepEqual(h.deck.images, [{ id: 'other', dataUrl: 'other-image-bytes' }, asset])
    assert.equal(h.deck.currentDsl, 'two bound media slots')
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

