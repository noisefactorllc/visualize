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

test.describe.configure({ mode: 'serial' })

test('end-to-end smoke', async ({ page }) => {
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

    const deckA = await samplePixels('deck-a-canvas')
    const deckB = await samplePixels('deck-b-canvas')
    expect(deckA.max).toBeGreaterThan(0)
    expect(deckB.max).toBeGreaterThan(0)

    // Crossfader drives the main output: x=0 should be different from x=1
    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '0'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(400)
    const mainAtZero = await samplePixels('main-canvas')

    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '1'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(400)
    const mainAtOne = await samplePixels('main-canvas')

    // The two main samples should not be identical — otherwise the
    // crossfader isn't actually mixing decks.
    expect(Math.abs(mainAtZero.avg - mainAtOne.avg)).toBeGreaterThan(2)

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

    // Tap tempo: four taps at ~500ms should give ~120 BPM
    await page.click('#tap-tempo')
    await page.waitForTimeout(500); await page.click('#tap-tempo')
    await page.waitForTimeout(500); await page.click('#tap-tempo')
    await page.waitForTimeout(500); await page.click('#tap-tempo')
    const bpm = await page.evaluate(() => parseFloat(document.getElementById('bpm-input').value))
    expect(bpm).toBeGreaterThan(80)
    expect(bpm).toBeLessThan(180)

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
