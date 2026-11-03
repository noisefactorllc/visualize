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
 * This pins the contract at the product boundary: a mixer upload of a
 * context-less deck canvas must leave the canvas free to take its
 * rendering context, and a real deck must still compile and run on it.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

test('a mixer upload of a context-less deck canvas leaves the deck canvas free to render', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await page.goto('/')

    // The boot downloads the engine core from the CDN. Every module import
    // below uses the same bundle.
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    const result = await page.evaluate(async () => {
        const { MixerRenderer } = await import('/js/mixer.js')
        const { Deck } = await import('/js/noisemaker/deck.js')

        // A deck canvas whose renderer has not compiled yet: no context.
        // There is no way to probe for one without taking it — a canvas
        // keeps the first context type it gets — so the assertions below
        // are what detect a poisoned canvas.
        const deckCanvas = document.createElement('canvas')
        deckCanvas.width = 320
        deckCanvas.height = 180

        // The real mixer upload path. The upload prefers WebGPU where
        // available — the poisoned state ran only on WebGPU — and a WebGL2
        // host falls back while holding the same assertions.
        const mixer = new MixerRenderer({ preferWebGPU: true })
        await mixer.init()
        mixer.bindDecks({ canvas: deckCanvas }, { canvas: deckCanvas })
        mixer._uploadDeckFrames()

        // The poisoned engine state fails exactly here: a 2D context on the
        // source canvas makes getContext('webgl2') return null.
        const tookWebGL2 = !!deckCanvas.getContext('webgl2')
        const uploaded = mixer._uploadedAtLeastOnce

        // And the deck still renders on the canvas the mixer uploaded first.
        const deck = new Deck(deckCanvas, { preferWebGPU: true, id: 'probe' })
        const load = await deck.load('search synth\nnoise(seed: 1).write(o0)\nrender(o0)', 'mixer context probe')
        const running = deck.isRunning
        deck.dispose()

        return {
            tookWebGL2,
            uploaded,
            loadSuccess: !!load.success,
            loadError: load?.error?.message || null,
            running,
        }
    })

    expect(result.uploaded, 'the mixer tick uploaded the context-less deck canvas without throwing').toBe(true)
    expect(result.tookWebGL2, 'an uploaded deck canvas can still take its WebGL2 context').toBe(true)
    expect(result.loadSuccess, `the deck compiled on the uploaded canvas: ${result.loadError}`).toBe(true)
    expect(result.running, 'the deck renders on the canvas the mixer uploaded first').toBe(true)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})
