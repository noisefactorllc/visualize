// SPDX-License-Identifier: MIT
/**
 * Auto-Mix smoke. Boots the full app, verifies:
 *   - osc source: readSource sweeps over a wide range across one bar
 *   - audio source: the meter value flows straight through
 *   - midi source: latest CC on the chosen channel feeds the fader
 *   - mutual exclusion with Auto-VJ (enabling one disables the other)
 */
import { test, expect } from '@playwright/test'

test.describe.configure({ timeout: 120_000, retries: 1 })

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize?.autoXfade,
        null, { timeout: 30_000 })
    return { context, page }
}

test('autoXfade: osc source sweeps a wide range across one bar', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const samples = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            ax.setSource({ kind: 'osc', oscType: 0 })   // sine
            // Read the actual bar duration from the live scheduler so
            // we sweep exactly one full cycle (barSec varies with the
            // saved BPM divider — default divider=4 gives 8s at 120BPM).
            const barMs = ax.scheduler.barSeconds() * 1000
            const out = []
            for (let i = 0; i <= 16; i++) {
                out.push(ax.readSource(i * barMs / 16))
            }
            return out
        })
        const min = Math.min(...samples), max = Math.max(...samples)
        // Sine across [0,1] full cycle should span close to 1.0.
        expect(max - min).toBeGreaterThan(0.9)
    } finally {
        await context.close()
    }
})

test('autoXfade: audio source reads from meters', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const audio = window.__visualize.audio
            ax.setSource({ kind: 'audio', band: 'low' })
            audio.meters.low = 0.42
            return ax.readSource(0)
        })
        expect(result).toBeCloseTo(0.42, 5)
    } finally {
        await context.close()
    }
})

test('autoXfade: midi source reads latest CC on channel', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const midi = window.__visualize.midi
            midi._lastCcByChannel.set(3, 0.77)
            ax.setSource({ kind: 'midi', channel: 3 })
            return ax.readSource(0)
        })
        expect(result).toBeCloseTo(0.77, 5)
    } finally {
        await context.close()
    }
})

test('autoXfade: mutual exclusion with auto-VJ', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const am = window.__visualize.autoMix
            am.setEnabled(true)
            ax.setEnabled(true)
            return { autoMixEnabled: am.enabled, autoXfadeEnabled: ax.enabled }
        })
        expect(result.autoMixEnabled).toBe(false)
        expect(result.autoXfadeEnabled).toBe(true)
    } finally {
        await context.close()
    }
})
