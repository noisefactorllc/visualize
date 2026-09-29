// SPDX-License-Identifier: MIT
/**
 * Long-set soak: rapid program swaps and rebind reloads on a live deck
 * must serialize cleanly, never leave the deck stalled or uncompiled,
 * and keep published metadata consistent with the last winning load.
 *
 * Mirrors an Auto-VJ cadence (load → load → load → rebind reload) at a
 * pace far beyond real playback, then proves the deck is still running
 * at a healthy frame rate with zero page errors.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

test('deck load/reloadDsl soak serializes cleanly on a live deck', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    await routeHandfishLocal(page)
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A?.currentDsl, null, { timeout: 60_000 * SCALE })

    const soak = await page.evaluate(async () => {
        const resp = await fetch('data/programs.json', { cache: 'no-cache' })
        const programs = await resp.json()
        const titles = []
        for (const p of programs) {
            if (p.dsl && !titles.includes(p.title)) titles.push(p.title)
            if (titles.length === 3) break
        }
        const deck = window.__visualize.decks.A
        const results = []
        for (let i = 0; i < 12; i++) {
            const p = programs.find(x => x.title === titles[i % titles.length])
            // Auto-VJ cadence: three fresh loads, then a rebind reload.
            const res = i % 4 === 3
                ? await deck.reloadDsl(deck.currentDsl)
                : await deck.load(p.dsl, p.title)
            results.push({
                success: !!res.success,
                superseded: !!res.superseded,
                title: p.title
            })
        }
        return {
            results,
            currentName: deck.currentName,
            currentDsl: deck.currentDsl,
            rebindOriginal: deck.rebind.originalDsl,
            isRunning: deck.isRunning
        }
    })

    // Every swap resolved cleanly (success or superseded), none threw.
    for (const r of soak.results) {
        expect(r.success || r.superseded,
            `unexpected result for ${r.title}: ${JSON.stringify(r)}`).toBe(true)
    }
    const lastLoad = soak.results[10] // i=11 is the final reloadDsl
    expect(lastLoad.success).toBe(true)
    expect(soak.currentName).toBe(lastLoad.title)
    expect(soak.currentDsl).toBe(soak.rebindOriginal,
        'rebind reload must preserve the winning load as rebind source')
    expect(soak.isRunning).toBe(true)

    // The deck must still be rendering after the churn: sample the deck
    // canvas twice and require the frame content to keep evolving
    // (loop time advances every frame, even on SwiftShader).
    const frameA = await page.evaluate(() => {
        const c = document.getElementById('deck-a-canvas')
        const cvs = document.createElement('canvas')
        cvs.width = 32; cvs.height = 32
        const ctx = cvs.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(c, 0, 0, 32, 32)
        return Array.from(ctx.getImageData(0, 0, 32, 32).data)
    })
    await page.waitForTimeout(800)
    const frameB = await page.evaluate(() => {
        const c = document.getElementById('deck-a-canvas')
        const cvs = document.createElement('canvas')
        cvs.width = 32; cvs.height = 32
        const ctx = cvs.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(c, 0, 0, 32, 32)
        return Array.from(ctx.getImageData(0, 0, 32, 32).data)
    })
    let mad = 0
    for (let i = 0; i < frameA.length; i++) mad += Math.abs(frameA[i] - frameB[i])
    mad /= frameA.length
    expect(mad, 'deck canvas must keep animating after the soak').toBeGreaterThan(0.5)
    expect(pageErrors).toEqual([])
})
