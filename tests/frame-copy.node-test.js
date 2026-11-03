import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// A WebGPU canvas holds its frame only during the task that rendered it.
// The deck and the mixer copy each WebGPU frame from the renderer's onFrame
// callback, and `frameCanvas` gives readers that copy. Under WebGL2 the
// canvas keeps its frame, so `frameCanvas` is the renderer's canvas.

function load(file, name, strip, context) {
    let source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const re of strip) source = source.replace(re, '')
    source = source.replace(/export /g, '')
    return vm.runInContext(`${source}\n${name}`, context)
}

function fakeDocument() {
    const draws = []
    return {
        draws,
        body: { appendChild() {} },
        createElement: () => {
            const canvas = { width: 0, height: 0, style: {} }
            canvas.getContext = () => ({
                clearRect: (x, y, w, h) => draws.push({ clear: [x, y, w, h], into: canvas }),
                drawImage: (source, x, y) => draws.push({ into: canvas, source, x, y }),
            })
            return canvas
        },
    }
}

function fakeEngine(backendName) {
    return {
        canvas: { width: 640, height: 360 },
        pipeline: backendName ? { backend: { getName: () => backendName } } : null,
        manifest: {}, loadEffects: async () => {}, compile: async () => {}, start() {}, stop() {}, dispose() {},
    }
}

function deck(backendName) {
    const engine = fakeEngine(backendName)
    const document = fakeDocument()
    const context = vm.createContext({
        console, Blob, document,
        CanvasRenderer: function (options) { engine.options = options; return engine },
        CDN_BASE: '', curatedRuntimeDsl: dsl => dsl,
        extractEffectNamesFromDsl: () => [], extractEffectsFromDsl: () => [],
    })
    const Deck = load('../js/noisemaker/deck.js', 'Deck', [
        /import \{[\s\S]*?\} from '\.\/bundle.js'/,
        /import \{ registerCuratedEffects, curatedRuntimeDsl \} from '\.\/curatedEffects.js'\n/,
    ], context)
    return { owner: new Deck({ width: 0, height: 0 }), engine, document }
}

function mixer(backendName) {
    const engine = fakeEngine(backendName)
    engine.canvas = { width: 1280, height: 720 }
    const document = fakeDocument()
    const context = vm.createContext({
        console, document,
        CanvasRenderer: function (options) { engine.options = options; return engine },
        CDN_BASE: '', DEFAULT_MIXER_ID: 'mixer-default', MIXERS: [], getMixer: () => null,
    })
    const MixerRenderer = load('../js/mixer.js', 'MixerRenderer', [
        /import \{ CanvasRenderer, CDN_BASE \} from '\.\/noisemaker\/bundle\.js'\n/,
        /import \{ MIXERS, getMixer, DEFAULT_MIXER_ID, buildDslArgs \} from '\.\/mixers\.js'\n/,
        /export \{ MIXERS, DEFAULT_MIXER_ID, getMixer \} from '\.\/mixers\.js'\n/,
    ], context)
    return { owner: new MixerRenderer({}), engine, document }
}

for (const [name, make] of [['deck', deck], ['mixer', mixer]]) {
    test(`${name}: under WebGL2 readers read the renderer's canvas and nothing is copied`, () => {
        const { owner, engine, document } = make('WebGL2')
        assert.equal(owner.frameCanvas, engine.canvas)
        engine.options.onFrame(1)
        assert.equal(document.draws.length, 0)
    })

    test(`${name}: before a pipeline exists readers read a blank copy, never the renderer's canvas`, () => {
        const { owner, engine, document } = make(null)
        const copy = owner.frameCanvas
        assert.notEqual(copy, engine.canvas)
        assert.deepEqual([copy.width, copy.height], [engine.canvas.width, engine.canvas.height])
        engine.options.onFrame(1)
        assert.equal(document.draws.length, 0, 'nothing is drawn into the copy')
    })

    test(`${name}: under WebGPU each frame is copied as it renders and readers read the copy`, () => {
        const { owner, engine, document } = make('WebGPU')
        const copy = owner.frameCanvas
        assert.notEqual(copy, engine.canvas)
        assert.equal(owner.frameCanvas, copy, 'the copy canvas stays the same object')
        assert.deepEqual([copy.width, copy.height], [engine.canvas.width, engine.canvas.height])

        // Each frame clears the copy, then draws the canvas into it.
        engine.options.onFrame(1)
        assert.deepEqual(document.draws.map(d => d.clear ? 'clear' : 'draw'), ['clear', 'draw'])
        assert.deepEqual(document.draws[0].clear, [0, 0, engine.canvas.width, engine.canvas.height])
        assert.equal(document.draws[1].into, copy)
        assert.equal(document.draws[1].source, engine.canvas)

        // A renderer that moved to a fresh canvas, at a new size, is copied
        // from that canvas into the same copy, resized.
        engine.canvas = { width: 320, height: 180 }
        engine.options.onFrame(2)
        assert.equal(document.draws[3].source, engine.canvas)
        assert.equal(owner.frameCanvas, copy)
        assert.deepEqual([copy.width, copy.height], [320, 180])
    })
}
