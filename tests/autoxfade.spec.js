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

test('autoXfade: osc source sweeps a wide range across one bar (beat-aligned)', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const samples = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            ax.setSource({ kind: 'osc', oscType: 0 })   // sine
            // The osc phase is now derived from scheduler.beatInBar +
            // scheduler.beatPhase. Drive the scheduler synthetically:
            // override its phase fields directly across one bar.
            const sched = ax.scheduler
            const out = []
            const origInBar = sched._beatIndex
            // Sample 17 phases across 4 beats (one bar).
            for (let i = 0; i <= 16; i++) {
                const t = i / 16   // 0..1 across bar
                const beat = Math.floor(t * 4)
                const phaseInBeat = (t * 4) - beat
                // Stub: temporarily monkey-patch the getters via the
                // backing fields the scheduler exposes.
                Object.defineProperty(sched, 'beatInBar', {
                    get: () => beat, configurable: true
                })
                Object.defineProperty(sched, 'beatPhase', {
                    get: () => phaseInBeat, configurable: true
                })
                out.push(ax.readSource(0))
            }
            // Restore (define the original getters back as data)
            sched._beatIndex = origInBar
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
