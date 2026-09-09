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
