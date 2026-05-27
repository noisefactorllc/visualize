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

test('autoXfade: osc sweeps over the auto-VJ cycle length (beat-aligned)', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const samples = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            ax.setSource({ kind: 'osc', oscType: 0 })   // sine
            // The osc phase is derived from scheduler.beatIndex +
            // scheduler.beatPhase, spanning N bars where N comes
            // from getBarsPerCycle() (= autoMix.barsPerScene).
            // Default is 8 bars = 32 beats. Drive the scheduler
            // synthetically across exactly that many beats.
            const sched = ax.scheduler
            const bars = window.__visualize.autoMix.barsPerScene
            const cycleBeats = bars * 4
            const out = []
            const origIndex = sched._beatIndex
            for (let i = 0; i <= 16; i++) {
                const t = i / 16   // 0..1 across the full cycle
                const beat = Math.floor(t * cycleBeats)
                const phaseInBeat = (t * cycleBeats) - beat
                sched._beatIndex = beat
                Object.defineProperty(sched, 'beatPhase', {
                    get: () => phaseInBeat, configurable: true
                })
                out.push(ax.readSource(0))
            }
            sched._beatIndex = origIndex
            return out
        })
        const min = Math.min(...samples), max = Math.max(...samples)
        // Sine across the cycle should span close to 1.0.
        expect(max - min).toBeGreaterThan(0.9)
    } finally {
        await context.close()
    }
})

test('autoXfade: cycle length follows Auto-VJ bars setting', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const am = window.__visualize.autoMix
            ax.setSource({ kind: 'osc', oscType: 2 })   // saw — strictly increasing 0..1
            const sched = ax.scheduler
            // With 4 bars (16 beats), sampling at beat 8 gives saw at
            // phase 0.5 → value ≈ 0.5.
            am.setBarsPerScene(4)
            sched._beatIndex = 8
            Object.defineProperty(sched, 'beatPhase', { get: () => 0, configurable: true })
            const at4 = ax.readSource(0)
            // With 8 bars (32 beats), sampling at beat 8 gives saw at
            // phase 0.25 → value ≈ 0.25.
            am.setBarsPerScene(8)
            const at8 = ax.readSource(0)
            return { at4, at8 }
        })
        // The same beat position yields half the value when the cycle
        // doubles — confirms barsPerScene drives the phase divisor.
        expect(result.at4).toBeCloseTo(0.5, 1)
        expect(result.at8).toBeCloseTo(0.25, 1)
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
