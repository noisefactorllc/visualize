// SPDX-License-Identifier: MIT
/**
 * Smoke test — boots the app, loads the shader bundle from CDN, verifies
 * both decks compile, the main compositor actually changes output when
 * the crossfader moves, the live indicator follows xfade, main FX
 * toggle, tap-tempo registers, auto-VJ activates, and scenes round-trip
 * through localStorage + Shift+1 recall.
 *
 * Headless GPU rendering is significantly slower than real hardware; the
 * test allows generous waitFor budgets but does NOT assert specific FPS
 * numbers, which would be flaky.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

// One retry as defense-in-depth: this spec boots a real GPU pipeline and
// runs ~20 real-time interactions against random programs, so isolated GPU
// jitter shouldn't red CI. The two historically-flaky assertions below
// (crossfader mixing, tap tempo) are made deterministic, not retry-masked.
test.describe.configure({ mode: 'serial', retries: 1 })

// Serve the local handfish build (with <tempo-bar> + industrial.css) when
// HANDFISH_LOCAL is set; otherwise hit the real CDN. No machine path committed.
installHandfishLocal(test)

test('end-to-end smoke', async ({ page }) => {
    // Heaviest spec: one test drives a full session (boot → CDN shader
    // load → dual compile → crossfade → FX → tap → auto-VJ → scene save +
    // recall). On slow-CDN days the cumulative wall-clock overruns the
    // default 120s budget; test.slow() triples it. Orthogonal to the
    // determinism fixes + retries:1 above — a retry can't rescue a timeout
    // (it just times out again), so the budget needs its own headroom.
    test.slow()
    const consoleMessages = []
    const pageErrors = []
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')
    await page.click('#boot-start')

    // Wait until both decks have a program loaded
    await page.waitForFunction(() => {
        const a = document.getElementById('deck-a-name')?.textContent
        const b = document.getElementById('deck-b-name')?.textContent
        return a && a !== '—' && b && b !== '—'
    }, { timeout: 30_000 })

    // Library populated
    const libCount = await page.textContent('#library-count')
    expect(libCount).toMatch(/\d+ programs?/)

    // ── Industrial chrome (handfish adoption) ────────────────────────────
    // Document opts into the industrial typeface language.
    await expect(page.locator('html')).toHaveAttribute('data-language', 'industrial')
    // Colored logotype wordmark, ALL CAPS.
    await expect(page.locator('.hf-logotype .hf-logotype-text')).toHaveText('VISUALIZE')
    // Top-bar icon cluster: three .hf-icon-btn affordances (settings/fullscreen/about).
    await expect(page.locator('.hf-topbar-cluster .hf-icon-btn')).toHaveCount(3)
    // The <tempo-bar> component replaced the inline tempo DOM and bound its
    // scheduler to the app's test hook.
    await expect(page.locator('tempo-bar .tempo-bar__bpm')).toBeVisible()
    await expect(page.locator('tempo-bar .tempo-bar__beat')).toHaveCount(4)
    const tempoWired = await page.evaluate(() =>
        !!window.__visualize.scheduler && window.__visualize.scheduler === window.__visualize.tempoBar.scheduler)
    expect(tempoWired).toBe(true)

    // Give the compositor a few frames so main canvas accumulates content
    await page.waitForTimeout(800)

    // Sample a 5x5 grid; at least one pixel must be non-black
    async function samplePixels(id) {
        return page.evaluate((cid) => {
            const c = document.getElementById(cid)
            const cvs = document.createElement('canvas')
            cvs.width = c.width; cvs.height = c.height
            const ctx = cvs.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(c, 0, 0)
            let max = 0, sum = 0, n = 0
            for (let y = 1; y <= 5; y++) {
                for (let x = 1; x <= 5; x++) {
                    const px = ctx.getImageData(
                        Math.floor(c.width * x / 6),
                        Math.floor(c.height * y / 6),
                        1, 1
                    ).data
                    const b = (px[0] + px[1] + px[2]) / 3
                    if (b > max) max = b
                    sum += b; n++
                }
            }
            return { max, avg: sum / n }
        }, id)
    }

    // Downscale a GPU canvas into an n×n 2D buffer and return per-cell
    // brightness (one getImageData call). Dense enough that two distinct
    // programs differ in many cells even when their averages coincide —
    // the basis for a mean-absolute-difference that doesn't cancel.
    async function sampleField(id, n = 32) {
        return page.evaluate(({ cid, size }) => {
            const c = document.getElementById(cid)
            const cvs = document.createElement('canvas')
            cvs.width = size; cvs.height = size
            const ctx = cvs.getContext('2d', { willReadFrequently: true })
            ctx.drawImage(c, 0, 0, size, size)
            const d = ctx.getImageData(0, 0, size, size).data
            const out = new Array(size * size)
            for (let i = 0; i < size * size; i++) {
                out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3
            }
            return out
        }, { cid: id, size: n })
    }

    const deckA = await samplePixels('deck-a-canvas')
    const deckB = await samplePixels('deck-b-canvas')
    expect(deckA.max).toBeGreaterThan(0)
    expect(deckB.max).toBeGreaterThan(0)

    // Crossfader drives the main output: x=0 (pure deck A) must differ from
    // x=1 (pure deck B). Compare per-pixel, NOT by average brightness: two
    // random programs can share a similar average while looking nothing
    // alike, so |Δavg| flaked (~1.32 < 2 on unlucky pairs). Mean-absolute-
    // difference over a dense grid doesn't cancel local contrast, so it
    // stays large whenever the two decks genuinely differ.
    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '0'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(400)
    const fieldAtZero = await sampleField('main-canvas')

    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '1'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(400)
    const fieldAtOne = await sampleField('main-canvas')

    let madSum = 0
    for (let i = 0; i < fieldAtZero.length; i++) {
        madSum += Math.abs(fieldAtZero[i] - fieldAtOne[i])
    }
    const mad = madSum / fieldAtZero.length
    expect(
        mad,
        `main output barely changed across the crossfader (MAD=${mad.toFixed(2)}); ` +
        `crossfader may not be mixing decks`
    ).toBeGreaterThan(2)

    // Live indicator: at xfade=1, deck B has .live and deck A doesn't.
    const live = await page.evaluate(() => ({
        a: document.querySelector('.deck.deck-a').classList.contains('live'),
        b: document.querySelector('.deck.deck-b').classList.contains('live')
    }))
    expect(live).toEqual({ a: false, b: true })

    // Invert FX toggles the main canvas class
    await page.click('.fx-button[data-fx="invert"]')
    await page.waitForTimeout(100)
    const invertOn = await page.evaluate(() =>
        document.getElementById('main-canvas').classList.contains('invert'))
    expect(invertOn).toBe(true)

    // Tap tempo: drive four taps with exact 400ms spacing via injected
    // timestamps (scheduler.tap(now)). Real-time clicking + waitForTimeout
    // can't hold the spacing under headless-GPU/full-suite load — the
    // interval stretched far enough to read ~47 BPM and trip a `>80` check.
    // Injecting timestamps exercises the real tap math deterministically:
    // 400ms intervals → 150 BPM, distinct from the 120 default so we know
    // the taps actually drove the tempo (not just read the boot value).
    const bpm = await page.evaluate(() => {
        const s = window.__visualize.scheduler
        const base = 1_000_000
        s.tap(base)
        s.tap(base + 400)
        s.tap(base + 800)
        s.tap(base + 1200)
        return s.bpm
    })
    expect(bpm).toBeCloseTo(150, 0)
    // The <tempo-bar> BPM field reflects the tapped tempo (scheduler.onChange →
    // the component mirrors it into its own .tempo-bar__bpm input).
    const bpmShown = await page.evaluate(() =>
        parseFloat(document.querySelector('tempo-bar .tempo-bar__bpm').value))
    expect(bpmShown).toBeCloseTo(150, 0)

    // Auto-VJ toggle
    await page.click('#automix-toggle')
    const autoState = await page.getAttribute('#automix-toggle', 'data-state')
    expect(autoState).toBe('on')

    // Scenes: open drawer, save a scene, verify it lands in localStorage,
    // change xfade, recall via Shift+1, verify xfade restored.
    await page.click('#scenes-open')
    await page.waitForTimeout(150)
    await page.fill('#scene-name-input', 'smoke')
    await page.click('#scene-save')
    await page.waitForTimeout(200)

    const scenesPersisted = await page.evaluate(() => {
        const raw = localStorage.getItem('visualize.scenes.v1')
        return raw ? JSON.parse(raw).length : 0
    })
    expect(scenesPersisted).toBe(1)

    const rendered = await page.locator('#scenes-list .scene-row').count()
    expect(rendered).toBe(1)

    // Move xfade off-target, then recall
    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '0'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(200)
    await page.keyboard.press('Shift+Digit1')
    await page.waitForTimeout(800) // scene-apply re-compiles both decks

    const xfadeAfter = await page.evaluate(() =>
        parseFloat(document.getElementById('crossfader').value))
    expect(xfadeAfter).toBeCloseTo(1, 1)

    // No page errors and no console.error()s the whole time
    expect(pageErrors).toEqual([])
    // Allow console.error from the renderer when programs use experimental
    // effects, but fail on anything that smells like a thrown exception.
    const unexpectedErrors = consoleMessages.filter(m =>
        !m.includes('GPU stall') && !m.includes('willReadFrequently'))
    expect(unexpectedErrors, unexpectedErrors.join('\n')).toEqual([])
})
