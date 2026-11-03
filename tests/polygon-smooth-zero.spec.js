// SPDX-License-Identifier: MIT
/**
 * polygon(smooth: 0) must draw a hard edge on every backend.
 *
 * The engine's shape shader called smoothstep(radius, radius - smoothing, d)
 * with equal edges at zero smoothing, which is undefined: WebGL2 drew the
 * filled polygon and WebGPU drew its exact inverse (fixed in the engine by
 * the zero-smoothing polygon edge). Visualize renders any program a user
 * loads, including share links with polygon(smooth: 0) masks, so the inverse
 * mask was a WebGPU-only wrong picture.
 *
 * This pins the contract at the product boundary, on each backend: with
 * bgAlpha: 0 the inside must be opaque foreground color and the far outside
 * must stay transparent. Each case reports the backend the engine actually
 * built, so a silent fallback cannot stand in for the backend under test.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

const PROBE_DSL = 'search synth\npolygon(sides: 6, radius: 0.6, smooth: 0, fgColor: #ff0000, fgAlpha: 1, bgColor: #000000, bgAlpha: 0)\n.write(o0)\nrender(o0)'

async function runBackendCase(page, preferWebGPU) {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await page.goto('/')

    // The boot downloads the engine core from the CDN. The polygon effect
    // bundle loads from the same CDN during the compile below.
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    const result = await page.evaluate(async ({ preferWebGPU, dsl }) => {
        const { Deck } = await import('/js/noisemaker/deck.js')

        const canvas = document.createElement('canvas')
        const deck = new Deck(canvas, { preferWebGPU, id: 'probe', width: 128, height: 128 })
        await deck.init()
        const load = await deck.load(dsl, 'polygon hard-edge probe')
        const backend = deck._renderer.pipeline?.backend?.getName?.() ?? null

        // Sample the presented frame: draw it into a 2D canvas and read the
        // center (inside the hexagon) and a corner (far outside it).
        const probe = document.createElement('canvas')
        probe.width = 32
        probe.height = 32
        const ctx = probe.getContext('2d', { willReadFrequently: true })
        let center = null
        let corner = null
        const deadline = performance.now() + 15000
        while (performance.now() < deadline) {
            ctx.clearRect(0, 0, 32, 32)
            ctx.drawImage(deck.canvas, 0, 0, 32, 32)
            const bytes = ctx.getImageData(0, 0, 32, 32).data
            center = [bytes[(16 * 32 + 16) * 4], bytes[(16 * 32 + 16) * 4 + 1], bytes[(16 * 32 + 16) * 4 + 2], bytes[(16 * 32 + 16) * 4 + 3]]
            corner = [bytes[(1 * 32 + 1) * 4], bytes[(1 * 32 + 1) * 4 + 1], bytes[(1 * 32 + 1) * 4 + 2], bytes[(1 * 32 + 1) * 4 + 3]]
            // Wait until the center has real bytes: an unrendered canvas is
            // transparent black, which would look like the inverted defect.
            if (center[3] > 200) break
            await new Promise(r => setTimeout(r, 200))
        }
        deck.dispose()

        return { backend, loadSuccess: !!load.success, loadError: load?.error?.message || null, center, corner }
    }, { preferWebGPU, dsl: PROBE_DSL })

    return { pageErrors, result }
}

test('polygon(smooth: 0) fills its inside on WebGPU, not the inverse', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, true)

    expect(result.loadSuccess, `the probe compiled: ${result.loadError}`).toBe(true)
    expect(result.backend, 'the probe rendered on WebGPU, not a fallback').toBe('WebGPU')
    expect(result.center[3], 'the polygon inside is opaque (zero smoothing did not invert the mask)').toBeGreaterThan(200)
    expect(result.center[0], 'the polygon inside is the foreground red').toBeGreaterThan(200)
    expect(result.corner[3], 'the far outside stays transparent at bgAlpha: 0').toBeLessThan(10)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})

test('polygon(smooth: 0) fills its inside on WebGL2, not the inverse', async ({ page }) => {
    const { pageErrors, result } = await runBackendCase(page, false)

    expect(result.loadSuccess, `the probe compiled: ${result.loadError}`).toBe(true)
    expect(result.backend, 'the probe rendered on WebGL2, not a fallback').toBe('WebGL2')
    expect(result.center[3], 'the polygon inside is opaque (zero smoothing kept the hard edge)').toBeGreaterThan(200)
    expect(result.center[0], 'the polygon inside is the foreground red').toBeGreaterThan(200)
    expect(result.corner[3], 'the far outside stays transparent at bgAlpha: 0').toBeLessThan(10)
    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toEqual([])
})
