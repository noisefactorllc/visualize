import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// The decks and the mixer report the REQUESTED backend from the engine's
// preferredBackend, falling back to backend on engines that predate it. The
// engine's backend can then report the backend that runs.
function load(file, name, strip) {
    let source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const re of strip) source = source.replace(re, '')
    source = source.replace(/export /g, '')
    return vm.runInContext(`${source}\n${name}`, vm.createContext({ console }))
}

const Deck = load('../js/noisemaker/deck.js', 'Deck', [
    /import \{[\s\S]*?\} from '\.\/bundle.js'/,
    /import \{ registerCuratedEffects, curatedRuntimeDsl \} from '\.\/curatedEffects.js'\n/,
])
const MixerRenderer = load('../js/mixer.js', 'MixerRenderer', [
    /import \{[^}]*\} from '\.\/noisemaker\/bundle.js'\n/,
    /import \{[^}]*\} from '\.\/mixers.js'\n/,
    /export \{[^}]*\} from '\.\/mixers.js'\n/,
])

const deckBackend = (renderer) => Object.getOwnPropertyDescriptor(Deck.prototype, 'backend').get.call({ _renderer: renderer })
const mixerPrefersWebGPU = (renderer) => Object.getOwnPropertyDescriptor(MixerRenderer.prototype, 'preferWebGPU').get.call({ renderer })

test('a WebGPU request that fell back to WebGL2 still reads as requested', () => {
    const renderer = { preferredBackend: 'wgsl', backend: 'glsl' }
    assert.equal(deckBackend(renderer), 'webgpu')
    assert.equal(mixerPrefersWebGPU(renderer), true)
})

test('an engine without preferredBackend reports the request as backend', () => {
    assert.equal(deckBackend({ backend: 'wgsl' }), 'webgpu')
    assert.equal(mixerPrefersWebGPU({ backend: 'wgsl' }), true)
    assert.equal(mixerPrefersWebGPU({ backend: 'glsl' }), false)
})
