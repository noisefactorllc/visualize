// SPDX-License-Identifier: MIT
/**
 * An asyncInit overlay must reach the screen through the engine's upload
 * call.
 *
 * The engine's async-init closure passes each overlay source to the
 * backend's updateTextureFromSource with the source's own 2D context when
 * it has one (fixed together with the context-free canvas upload, and kept
 * working when the context lookup moved behind an existence guard).
 * Visualize renders any program a user loads, including programs with the
 * core async CPU overlays (fibers, scratches, strayHair), so a broken
 * upload leaves those programs with a blank overlay and no visible change.
 *
 * This pins the contract at the product boundary, on each backend: a real
 * deck running the fibers overlay must present worm strands over its solid
 * base color. Each case reports the backend the engine actually built, so
 * a silent fallback cannot stand in for the backend under test.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

// Mirrors the engine's own fibers case: solid base, fully opaque overlay.
const PROBE_DSL = 'search synth, filter\nsolid(color: #404040)\n.fibers(density: 1, alpha: 1, seed: 1)\n.write(o0)\nrender(o0)'

async function runBackendCase(page, preferWebGPU) {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await page.goto('/')

    // The boot downloads the engine core from the CDN. The fibers effect
    // bundle loads from the same CDN during the compile below.
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    const result = await page.evaluate(async ({ preferWebGPU, dsl }) => {
        const { Deck } = await import('/js/noisemaker/deck.js')

        // A small buffer keeps the CPU worm tracing fast; the overlay stays
        // screen-sized, so it covers the whole frame.
        const canvas = document.createElement('canvas')
        const deck = new Deck(canvas, { preferWebGPU, id: 'probe', width: 128, height: 128 })
        await deck.init()
        const load = await deck.load(dsl, 'async overlay probe')
        const backend = deck._renderer.pipeline?.backend?.getName?.() ?? null

        // Worm tracing is async (fire-and-forget with progressive uploads),
        // so poll until the overlay is visible or the deadline passes.
        const probe = document.createElement('canvas')
        probe.width = 32
        probe.height = 32
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        let deviatingFraction = 0
        const deadline = performance.now() + 25000
        while (performance.now() < deadline) {
            ctx.clearRect(0, 0, 32, 32)
            ctx.drawImage(deck.canvas, 0, 0, 32, 32)
            const bytes = ctx.getImageData(0, 0, 32, 32).data
            let deviating = 0
            for (let i = 0; i < bytes.length; i += 4) {
                const d = Math.max(Math.abs(bytes[i] - 0x40), Math.abs(bytes[i + 1] - 0x40), Math.abs(bytes[i + 2] - 0x40))
                if (d > 16) deviating++
            }
            deviatingFraction = deviating / (32 * 32)
            if (deviatingFraction > 0.01) break
            await new Promise(r => setTimeout(r, 250))
        }
        deck.dispose()

        return { backend, loadSuccess: !!load.success, loadError: load?.error?.message || null, deviatingFraction }
    }, { preferWebGPU, dsl: PROBE_DSL })

    return { pageErrors, result }
}

test('a fibers asyncInit overlay presents over the base on WebGPU', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, true)

    expect(result.loadSuccess, `the probe compiled: ${result.loadError}`).toBe(true)
    expect(result.backend, 'the probe rendered on WebGPU, not a fallback').toBe('WebGPU')
    expect(result.deviatingFraction, 'the fibers overlay uploaded and shows over the solid base').toBeGreaterThan(0.01)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})

test('a fibers asyncInit overlay presents over the base on WebGL2', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, false)

    expect(result.loadSuccess, `the probe compiled: ${result.loadError}`).toBe(true)
    expect(result.backend, 'the probe rendered on WebGL2, not a fallback').toBe('WebGL2')
    expect(result.deviatingFraction, 'the fibers overlay uploaded and shows over the solid base').toBeGreaterThan(0.01)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})
