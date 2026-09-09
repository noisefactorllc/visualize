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
        }, start() { this.isRunning = true }, stop() {}, dispose() {}, }
    const context = vm.createContext({ console, CanvasRenderer: function () { return engine },
        CDN_BASE: '', extractEffectNamesFromDsl: () => [] })
    const Deck = vm.runInContext(source + '\nDeck', context)
    const deck = new Deck({})
    deck._initialized = true
    deck._normalizeColorUniforms = () => {}
    return { deck, engine, compiles }
}

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
