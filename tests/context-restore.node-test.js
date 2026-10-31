import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// After a lost WebGL context, CanvasRenderer rebuilds the program on a
// fresh canvas and recompiles the DSL, so what load() applied after the
// compile is gone. These tests pin the restore contract: the deck and the
// mixer re-apply their post-compile state from onContextRestored, and
// every canvas consumer reads the renderer's current canvas instead of a
// captured element.

function load(file, name, strip, context = vm.createContext({ console })) {
    let source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const re of strip) source = source.replace(re, '')
    source = source.replace(/export /g, '')
    return vm.runInContext(`${source}\n${name}`, context)
}

const deckStrip = [
    /import \{[\s\S]*?\} from '\.\/bundle.js'/,
    /import \{ registerCuratedEffects, curatedRuntimeDsl \} from '\.\/curatedEffects.js'\n/,
]

function deckHarness() {
    const engine = { manifest: {}, loadEffects: async () => {}, rendered: '',
        compile: async () => {}, start() {}, stop() {}, dispose() {} }
    const deckCanvas = { width: 0, height: 0 }
    const context = vm.createContext({
        console, Blob,
        CanvasRenderer: function (options) {
            engine.canvas = options.canvas
            engine.options = options
            return engine
        },
        CDN_BASE: '', curatedRuntimeDsl: dsl => dsl,
        extractEffectNamesFromDsl: () => [], extractEffectsFromDsl: () => [],
    })
    const Deck = load('../js/noisemaker/deck.js', 'Deck', deckStrip, context)
    const deck = new Deck(deckCanvas)
    return { deck, engine, deckCanvas }
}

test('a context restore re-applies the deck state that a load applies after a compile', () => {
    const h = deckHarness()
    assert.equal(typeof h.engine.options.onContextRestored, 'function')
    const calls = []
    h.deck._normalizeColorUniforms = () => calls.push('normalize')
    h.deck._rebindImages = () => calls.push('rebind')
    h.engine.options.onContextRestored()
    assert.deepEqual(calls, ['normalize', 'rebind'])
})

test('deck.canvas follows the renderer to a fresh canvas after a restore', () => {
    const h = deckHarness()
    assert.equal(h.deck.canvas, h.deckCanvas)
    const fresh = { width: 1280, height: 720 }
    h.engine.canvas = fresh
    assert.equal(h.deck.canvas, fresh)
})

const mixerStrip = [
    /import \{ CanvasRenderer, CDN_BASE \} from '\.\/noisemaker\/bundle\.js'\n/,
    /import \{ MIXERS, getMixer, DEFAULT_MIXER_ID, buildDslArgs \} from '\.\/mixers\.js'\n/,
    /export \{ MIXERS, DEFAULT_MIXER_ID, getMixer \} from '\.\/mixers\.js'\n/,
]

function mixerHarness() {
    const engine = { canvas: { width: 1280, height: 720 } }
    const document = {
        createElement: () => ({ width: 0, height: 0, style: {} }),
        body: { appendChild() {} },
    }
    const context = vm.createContext({
        console, document,
        CanvasRenderer: function (options) {
            engine.options = options
            return engine
        },
        CDN_BASE: '', DEFAULT_MIXER_ID: 'mixer-default', MIXERS: [], getMixer: () => null,
    })
    const MixerRenderer = load('../js/mixer.js', 'MixerRenderer', mixerStrip, context)
    const mixer = new MixerRenderer({})
    return { mixer, engine }
}

function pipelineWithSteps() {
    return { graph: { passes: [
        { inputs: { imageTex: 1 }, stepIndex: 7 },
        { inputs: { imageTex: 1 }, stepIndex: 9 },
        { inputs: { inputTex: 1, tex: 1 }, stepIndex: 11 },
    ] } }
}

test('a context restore re-derives the media steps and forgets the pushed image sizes', () => {
    const h = mixerHarness()
    h.mixer._initialized = true
    h.engine._pipeline = pipelineWithSteps()
    h.mixer._mediaStepA = 0
    h.mixer._mediaStepB = 1
    h.mixer._mixerStep = 2
    h.mixer._lastImageSize = { 7: [1280, 720] }
    h.engine.options.onContextRestored()
    assert.equal(h.mixer._mediaStepA, 7)
    assert.equal(h.mixer._mediaStepB, 9)
    assert.equal(h.mixer._mixerStep, 11)
    assert.equal(Object.keys(h.mixer._lastImageSize).length, 0)
})

test('the mixer tick uploads each deck through its current canvas', () => {
    const h = mixerHarness()
    h.mixer._initialized = true
    h.mixer._mediaStepA = 7
    h.mixer._mediaStepB = 9
    const uploads = []
    h.engine.updateTextureFromSource = (name, source, options) => uploads.push({ name, source, options })
    h.engine.applyStepParameterValues = () => {}
    const canvasA = { width: 640, height: 360 }
    const canvasB = { width: 640, height: 360 }
    h.mixer.bindDecks({ canvas: canvasA }, { canvas: canvasB })
    h.mixer._uploadDeckFrames()
    assert.equal(uploads.length, 2)
    assert.equal(uploads[0].name, 'imageTex_step_7')
    assert.equal(uploads[0].source, canvasA)
    assert.equal(uploads[0].options.flipY, false)
    assert.equal(uploads[1].name, 'imageTex_step_9')
    assert.equal(uploads[1].source, canvasB)
    assert.equal(uploads[1].options.flipY, false)
    // After a restore the deck's canvas is a different element: the next
    // tick must upload from the new one, not the captured element.
    const freshA = { width: 640, height: 360 }
    h.mixer._deckA.canvas = freshA
    uploads.length = 0
    h.mixer._uploadDeckFrames()
    assert.equal(uploads[0].source, freshA)
})

const thumbStrip = [/import \{ Deck \} from '\.\/noisemaker\/deck\.js'\n/]

test('the thumbnail capture reads the deck canvas the renderer presents on', async () => {
    const originalCanvas = { width: 240, height: 135, style: {} }
    let currentCanvas = originalCanvas
    const fakeDeck = {
        get canvas() { return currentCanvas },
        init: async () => {},
        load: async () => {
            // The engine restored onto a fresh canvas between load and capture.
            currentCanvas = {
                width: 240, height: 135, style: {},
                toBlob: (callback) => { captured.push('fresh'); callback('captured-blob') },
            }
            return { success: true }
        },
        stop() {},
    }
    class Deck {
        constructor(canvas) {
            fakeDeck.givenCanvas = canvas
            return fakeDeck // Stand in for the real deck instance.
        }
    }
    const captured = []
    originalCanvas.toBlob = () => captured.push('original')
    const document = {
        createElement: () => originalCanvas,
        body: { appendChild() {} },
    }
    const context = vm.createContext({ console, document, Deck, setTimeout })
    const ThumbnailRenderer = load('../js/thumbnailRenderer.js', 'ThumbnailRenderer', thumbStrip, context)
    const renderer = new ThumbnailRenderer()
    assert.equal(renderer.deck, fakeDeck)
    assert.equal(fakeDeck.givenCanvas, originalCanvas)
    const pending = renderer.render('media().write(o0)')
    // Bounded wait: a capture from the wrong canvas never resolves.
    const blob = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ])
    assert.equal(blob, 'captured-blob')
    // The capture went to the fresh canvas, not the original element.
    assert.deepEqual(captured, ['fresh'])
})
