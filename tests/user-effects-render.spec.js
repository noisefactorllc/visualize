// SPDX-License-Identifier: MIT
/**
 * A user effect that hands a texture on to the next effect in its chain
 * renders what the chain contract says: the producer writes a solid colour
 * into its own state texture, names it as outputTex, and the consumer reads
 * the handed-on texture through its chain input. The rendered deck pixels
 * are the proof — a dropped or blank handed-on name fails the chain instead
 * of showing the colour.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { routePortableImagesLocal } from './seanceLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 180_000 * SCALE, retries: 0 })

const RED = [255, 0, 0, 255]

const PRODUCER = {
    name: 'handProducer',
    description: 'writes red into its state texture and hands it on',
    tags: ['user'],
    globals: {},
    passes: [{ name: 'main', program: 'main', outputs: { color: 'stateTex' } }],
    textures: { stateTex: { width: 64, height: 64, format: 'rgba16f' } },
    outputTex: 'stateTex',
    shaders: {
        main: {
            glsl: '#version 300 es\nprecision highp float;\nout vec4 fragColor;\nvoid main() {\n    fragColor = vec4(1.0, 0.0, 0.0, 1.0);\n}\n',
            wgsl: 'struct Uniforms { time: f32, }\n@group(0) @binding(0) var<uniform> uniforms: Uniforms;\n\n@fragment\nfn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {\n    return vec4<f32>(1.0, 0.0, 0.0, 1.0);\n}\n',
        },
    },
}

const CONSUMER = {
    name: 'handConsumer',
    description: 'reads the chain input and shows it',
    tags: ['user'],
    globals: {},
    passes: [{ name: 'main', program: 'main', inputs: { src: 'inputTex' }, outputs: { color: 'outputTex' } }],
    shaders: {
        main: {
            glsl: '#version 300 es\nprecision highp float;\nuniform sampler2D src;\nout vec4 fragColor;\nvoid main() {\n    ivec2 texSize = textureSize(src, 0);\n    vec2 uv = gl_FragCoord.xy / vec2(texSize);\n    fragColor = texture(src, uv);\n}\n',
            wgsl: '@group(0) @binding(0) var samp: sampler;\n@group(0) @binding(1) var src: texture_2d<f32>;\nstruct Uniforms { time: f32, }\n@group(0) @binding(2) var<uniform> uniforms: Uniforms;\n\n@fragment\nfn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {\n    let dims = vec2<f32>(textureDimensions(src, 0));\n    let uv = pos.xy / dims;\n    return textureSample(src, samp, uv);\n}\n',
        },
    },
}

const CHAIN_DSL = 'search user\nhandProducer().handConsumer().write(o0)\nrender(o0)'

function canvasPixel(page, which) {
    return page.evaluate(id => {
        const source = window.__visualize.decks[id].canvas
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(source, source.width / 2, source.height / 2, 1, 1, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }, which)
}

// A WebGPU canvas holds its frame only during the task that rendered it, so
// drawImage outside that task reads blank. Read the deck's render surface
// copy instead: the bytes the deck actually presented.
function surfacePixel(page, which = 'A') {
    return page.evaluate(async id => {
        const renderer = window.__visualize.decks[id]._renderer
        const pipeline = renderer?.pipeline
        const surface = pipeline?.graph?.renderSurface
        if (!surface) return null
        const textureId = pipeline.frameReadTextures?.get(surface)
            ?? pipeline.surfaces?.get(surface)?.read
        if (!textureId) return null
        const { width, height, data } = await pipeline.backend.readPixels(textureId)
        const i = (height >> 1) * width * 4 + (width >> 1) * 4
        return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    }, which)
}

async function openVisualize(page) {
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routePortableImagesLocal(page)
    await page.goto('/')
    await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 90_000 * SCALE })
    await page.evaluate(() => window.VisualizeAgent.ready)
    // A fresh user-effects store per test: the install must come from this
    // test's payload, not from an earlier run.
    await page.evaluate(() => new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('visualize-user-effects')
        req.onsuccess = resolve
        req.onerror = reject
        req.onblocked = resolve
    }))
}

async function installHandOnChain(page) {
    return page.evaluate(async ({ producer, consumer }) => {
        const { getUserEffectsManager } = await import('/js/userEffects.js')
        const manager = getUserEffectsManager()
        const renderer = window.__visualize.decks.A._renderer
        return [
            await manager.uploadFromPayload(producer, renderer),
            await manager.uploadFromPayload(consumer, renderer),
        ]
    }, { producer: PRODUCER, consumer: CONSUMER })
}

test('a user effect chain that hands on a texture renders the handed-on colour (WebGL2)', async ({ page }) => {
    await openVisualize(page)
    const installed = await installHandOnChain(page)
    expect(installed.map(entry => entry.name)).toEqual(['handProducer', 'handConsumer'])

    const set = await page.evaluate(async dsl => window.VisualizeAgent.setProgram({ dsl, deck: 'A' }), CHAIN_DSL)
    expect(set.ok, set.error?.message ?? JSON.stringify(set)).toBe(true)

    await expect.poll(() => canvasPixel(page, 'A'), { timeout: 20_000 * SCALE, intervals: [500] }).toEqual(RED)
})

test('a user effect chain that hands on a texture renders the handed-on colour (WebGPU)', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('visualize.renderer.v1', JSON.stringify({ preferWebGPU: true }))
    })
    await openVisualize(page)

    const hasAdapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))
    test.skip(!hasAdapter, 'this browser offers no WebGPU adapter, so the WebGPU chain cannot run')
    const backend = await page.evaluate(() => window.__visualize.decks.A.activeBackend)
    test.skip(backend !== 'webgpu', `the deck fell back from WebGPU (${backend}), so the WebGPU chain cannot run`)

    const installed = await installHandOnChain(page)
    expect(installed.map(entry => entry.name)).toEqual(['handProducer', 'handConsumer'])

    const set = await page.evaluate(async dsl => window.VisualizeAgent.setProgram({ dsl, deck: 'A' }), CHAIN_DSL)
    expect(set.ok, set.error?.message ?? JSON.stringify(set)).toBe(true)

    await expect.poll(() => surfacePixel(page, 'A'), { timeout: 20_000 * SCALE, intervals: [500] }).toEqual(RED)
})
