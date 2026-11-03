// SPDX-License-Identifier: MIT
/**
 * The mixer's tick uploads every bound deck canvas as a source texture.
 * The engine's WebGPU upload once asked the source canvas for a 2D context
 * to find its willReadFrequently overlays, and a canvas keeps the first
 * context type it gets: uploading a deck canvas before that deck's
 * renderer compiled left the deck without a WebGPU or WebGL2 context, so
 * its canvas never showed a frame (fixed in the engine by the
 * context-free canvas upload).
 *
 * This pins the contract at the product boundary, on each affected
 * backend: a mixer upload of a context-less deck canvas must leave the
 * canvas free to take its rendering context, and a real deck must still
 * compile, run, and present real pixel bytes on that canvas. Each case
 * reports the engine backend it ran, so a silent fallback cannot stand in
 * for the backend under test.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

const PROBE_DSL = 'search synth\nnoise(seed: 1).write(o0)\nrender(o0)'

async function runBackendCase(page, preferWebGPU) {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await page.goto('/')

    // The boot downloads the engine core from the CDN. Every module import
    // below uses the same bundle.
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    const result = await page.evaluate(async ({ preferWebGPU, dsl }) => {
        const { MixerRenderer } = await import('/js/mixer.js')
        const { Deck } = await import('/js/noisemaker/deck.js')

        // A deck canvas whose renderer has not compiled yet: no context.
        // There is no way to probe for one without taking it — a canvas
        // keeps the first context type it gets — so the assertions below
        // are what detect a poisoned canvas.
        const deckCanvas = document.createElement('canvas')
        deckCanvas.width = 320
        deckCanvas.height = 180

        // The real mixer upload path. The upload prefers the backend under
        // test — the poisoned state ran only on WebGPU — and each case
        // reports the backend the engine actually built.
        const mixer = new MixerRenderer({ preferWebGPU })
        await mixer.init()
        mixer.bindDecks({ canvas: deckCanvas }, { canvas: deckCanvas })
        mixer._uploadDeckFrames()
        const mixerBackend = mixer.renderer.pipeline?.backend?.getName?.() ?? null
        const uploaded = mixer._uploadedAtLeastOnce

        // The poisoned engine state fails exactly here: a 2D context on the
        // source canvas keeps the canvas from taking its rendering context.
        const tookContext = preferWebGPU
            ? !!deckCanvas.getContext('webgpu')
            : !!deckCanvas.getContext('webgl2')

        // And the deck still renders on the canvas the mixer uploaded first.
        const deck = new Deck(deckCanvas, { preferWebGPU, id: 'probe' })
        const load = await deck.load(dsl, 'mixer context probe')
        const deckBackend = deck._renderer.pipeline?.backend?.getName?.() ?? null

        // Read the bytes the deck presents: draw its canvas into a 2D
        // canvas and wait until the frame is non-transparent.
        const probe = document.createElement('canvas')
        probe.width = 8
        probe.height = 8
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        let nonZero = false
        let byteCount = 0
        const deadline = performance.now() + 15000
        while (performance.now() < deadline) {
            ctx.drawImage(deckCanvas, 0, 0, 8, 8)
            const bytes = ctx.getImageData(0, 0, 8, 8).data
            byteCount = bytes.length
            if (Array.prototype.some.call(bytes, v => v !== 0)) {
                nonZero = true
                break
            }
            await new Promise(r => setTimeout(r, 200))
        }
        deck.dispose()

        return {
            mixerBackend,
            uploaded,
            tookContext,
            loadSuccess: !!load.success,
            loadError: load?.error?.message || null,
            deckBackend,
            nonZero,
            byteCount,
        }
    }, { preferWebGPU, dsl: PROBE_DSL })

    return { pageErrors, result }
}

test('a mixer upload of a context-less deck canvas keeps WebGPU presenting real pixel bytes', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, true)

    expect(result.mixerBackend, 'the mixer compiled on WebGPU').toBe('WebGPU')
    expect(result.uploaded, 'the mixer tick uploaded the context-less deck canvas without throwing').toBe(true)
    expect(result.tookContext, 'an uploaded deck canvas can still take its WebGPU context').toBe(true)
    expect(result.loadSuccess, `the deck compiled on the uploaded canvas: ${result.loadError}`).toBe(true)
    expect(result.deckBackend, 'the deck rendered on WebGPU, not a fallback').toBe('WebGPU')
    expect(result.nonZero, 'the deck presented non-transparent pixel bytes after the mixer upload').toBe(true)
    expect(result.byteCount, 'the pixel read covered every channel of the probe frame').toBe(8 * 8 * 4)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})

test('a mixer upload of a context-less deck canvas keeps WebGL2 presenting real pixel bytes', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, false)

    expect(result.mixerBackend, 'the mixer compiled on WebGL2').toBe('WebGL2')
    expect(result.uploaded, 'the mixer tick uploaded the context-less deck canvas without throwing').toBe(true)
    expect(result.tookContext, 'an uploaded deck canvas can still take its WebGL2 context').toBe(true)
    expect(result.loadSuccess, `the deck compiled on the uploaded canvas: ${result.loadError}`).toBe(true)
    expect(result.deckBackend, 'the deck rendered on WebGL2, not a fallback').toBe('WebGL2')
    expect(result.nonZero, 'the deck presented non-transparent pixel bytes after the mixer upload').toBe(true)
    expect(result.byteCount, 'the pixel read covered every channel of the probe frame').toBe(8 * 8 * 4)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})
