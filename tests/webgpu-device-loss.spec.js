// SPDX-License-Identifier: MIT
/**
 * A lost WebGPU device must rebuild the deck on a fresh canvas.
 *
 * A GPU process exit or a driver reset loses the page's WebGPU device for
 * good: its lost promise resolves and no event reaches the canvas. The
 * engine kept its loop running on the dead device, the canvas froze on its
 * last frame, and every read of it (recording, the output window) came
 * back empty until a reload (fixed in the engine by the device-loss
 * rebuild). Visualize runs its decks on WebGPU when the machine offers it,
 * so a mid-set GPU process exit used to leave a frozen, black-reading
 * deck.
 *
 * This pins the contract at the product boundary: after the deck's device
 * is lost, the deck presents on a different canvas, the same program is
 * still loaded, the renderer runs again, and that canvas presents real
 * pixel bytes. The engine reports the backend it rebuilt on, so a silent
 * fallback cannot stand in for WebGPU.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

const PROBE_DSL = 'search synth\nnoise(seed: 1).write(o0)\nrender(o0)'

test('a lost WebGPU device rebuilds the deck on a fresh canvas presenting real pixel bytes', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await page.goto('/')

    // The boot downloads the engine core from the CDN. Every module import
    // below uses the same bundle.
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    const result = await page.evaluate(async (dsl) => {
        const { Deck } = await import('/js/noisemaker/deck.js')

        const deck = new Deck(document.createElement('canvas'), { preferWebGPU: true, id: 'probe', width: 128, height: 128 })
        await deck.init()
        const load = await deck.load(dsl, 'device-loss probe')

        // Wait until the deck has presented frames: a loss while it draws
        // its first frame legitimately skips the rebuild, so wait past it.
        const probe = document.createElement('canvas')
        probe.width = 8
        probe.height = 8
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        let presented = false
        const warmup = performance.now() + 15000
        while (performance.now() < warmup) {
            // Clear first: drawImage composites over the probe's previous
            // content, and a transparent source leaves it unchanged.
            ctx.clearRect(0, 0, 8, 8)
            ctx.drawImage(deck.canvas, 0, 0, 8, 8)
            if (Array.prototype.some.call(ctx.getImageData(0, 0, 8, 8).data, v => v !== 0)) { presented = true; break }
            await new Promise(r => setTimeout(r, 200))
        }
        const oldCanvas = deck.canvas
        const backend = deck._renderer.pipeline?.backend?.getName?.() ?? null

        // A GPU process exit or a driver reset resolves the device's lost
        // promise; device.destroy() does the same from the page.
        deck._renderer.pipeline.backend.device.destroy()

        // The engine rebuilds asynchronously: poll for the fresh canvas,
        // a running loop on a new WebGPU pipeline, and real bytes on it.
        let rebuilt = false
        let newBackend = null
        let nonZero = false
        const deadline = performance.now() + 30000
        while (performance.now() < deadline) {
            if (deck.canvas !== oldCanvas) {
                rebuilt = true
                newBackend = deck._renderer.pipeline?.backend?.getName?.() ?? null
                ctx.clearRect(0, 0, 8, 8)
                ctx.drawImage(deck.canvas, 0, 0, 8, 8)
                if (Array.prototype.some.call(ctx.getImageData(0, 0, 8, 8).data, v => v !== 0)) { nonZero = true; break }
            }
            await new Promise(r => setTimeout(r, 250))
        }
        // Read the deck's post-rebuild state before dispose stops the loop.
        const dslKept = deck.currentDsl === dsl
        const running = deck.isRunning
        deck.dispose()

        return {
            backend,
            presented,
            loadSuccess: !!load.success,
            loadError: load?.error?.message || null,
            rebuilt,
            newBackend,
            nonZero,
            dslKept,
            running,
        }
    }, PROBE_DSL)

    expect(result.loadSuccess, `the probe compiled: ${result.loadError}`).toBe(true)
    expect(result.backend, 'the probe rendered on WebGPU before the loss').toBe('WebGPU')
    expect(result.presented, 'the deck presented pixel bytes before the device loss').toBe(true)
    expect(result.rebuilt, 'the engine rebuilt the deck on a fresh canvas after the device loss').toBe(true)
    expect(result.newBackend, 'the rebuilt pipeline rendered on WebGPU, not a fallback').toBe('WebGPU')
    expect(result.dslKept, 'the rebuilt deck still runs the program it had before the loss').toBe(true)
    expect(result.running, 'the rebuilt deck resumed its render loop').toBe(true)
    expect(result.nonZero, 'the fresh canvas presents real pixel bytes after the rebuild').toBe(true)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})
