// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'

test.describe.configure({ timeout: 60_000, retries: 1 })

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await routeHandfishLocal(page)
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize?.state,
        null, { timeout: 30_000 })
    return { context, page }
}

test('crossfader arrow keys: 5% standard nudge and 1% fine shift nudge', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // Set known initial crossfade position 0
        await page.evaluate(() => {
            const xf = document.getElementById('crossfader')
            xf.value = '0'
            xf.dispatchEvent(new Event('input', { bubbles: true }))
        })

        const getXfade = () => page.evaluate(() => ({
            stateVal: window.__visualize.state.crossfade,
            domVal: parseFloat(document.getElementById('crossfader').value)
        }))

        let current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0, 4)
        expect(current.domVal).toBeCloseTo(0, 4)

        // Standard ArrowRight: +0.05
        await page.keyboard.press('ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)
        expect(current.domVal).toBeCloseTo(0.05, 4)

        // Second standard ArrowRight: +0.05 -> 0.10
        await page.keyboard.press('ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        // Shift+ArrowRight: +0.01 -> 0.11
        await page.keyboard.press('Shift+ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.11, 4)
        expect(current.domVal).toBeCloseTo(0.11, 4)

        // Standard ArrowLeft: -0.05 -> 0.06
        await page.keyboard.press('ArrowLeft')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.06, 4)
        expect(current.domVal).toBeCloseTo(0.06, 4)

        // Shift+ArrowLeft: -0.01 -> 0.05
        await page.keyboard.press('Shift+ArrowLeft')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)
        expect(current.domVal).toBeCloseTo(0.05, 4)

        // Lower clamp at 0
        await page.keyboard.press('ArrowLeft')
        current = await getXfade()
        expect(current.stateVal).toBe(0)
        expect(current.domVal).toBe(0)

        await page.keyboard.press('ArrowLeft')
        current = await getXfade()
        expect(current.stateVal).toBe(0)
        expect(current.domVal).toBe(0)

        // Crossfader input focused: should also nudge with custom 5% / 1% steps rather than 0.001
        await page.focus('#crossfader')
        await page.keyboard.press('ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)
        expect(current.domVal).toBeCloseTo(0.05, 4)

        await page.keyboard.press('Shift+ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.06, 4)
        expect(current.domVal).toBeCloseTo(0.06, 4)

        // Vertical arrow keys on focused crossfader also step 5% / 1%
        await page.keyboard.press('ArrowUp')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.11, 4)
        expect(current.domVal).toBeCloseTo(0.11, 4)

        await page.keyboard.press('Shift+ArrowDown')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        // Modifier keys (Cmd, Alt, Control) must NOT hijack crossfader
        await page.keyboard.press('Alt+ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        await page.keyboard.press('Control+ArrowLeft')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        // Non-crossfader range sliders (e.g. speed A) handle arrow keys natively without altering crossfader
        const speedASlider = page.locator('#speed-a')
        await speedASlider.focus()
        const initialSpeedA = await speedASlider.evaluate(el => parseFloat(el.value))
        await page.keyboard.press('ArrowRight')
        const newSpeedA = await speedASlider.evaluate(el => parseFloat(el.value))
        expect(newSpeedA).toBeGreaterThan(initialSpeedA)

        // Crossfader must remain untouched while manipulating speed slider
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        // Typing in a text input must NOT nudge the crossfader
        const searchInput = page.locator('#library-search')
        await searchInput.focus()
        await page.keyboard.press('ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.10, 4)
        expect(current.domVal).toBeCloseTo(0.10, 4)

        // Verify tooltip and ARIA attribute on crossfader element
        const xfader = page.locator('#crossfader')
        await expect(xfader).toHaveAttribute('aria-label', 'Crossfader')
        await expect(xfader).toHaveAttribute('data-title', /Crossfader/)
    } finally {
        await context.close()
    }
})

test('crossfader sustained hold accelerates repeat nudges and resets cleanly on keyup', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        await page.evaluate(() => {
            const xf = document.getElementById('crossfader')
            xf.value = '0'
            xf.dispatchEvent(new Event('input', { bubbles: true }))
        })

        const getXfade = () => page.evaluate(() => ({
            stateVal: window.__visualize.state.crossfade,
            domVal: parseFloat(document.getElementById('crossfader').value),
            repeatCount: window.__visualize.xfadeNudgeTracker.repeatCount
        }))

        // Initial single tap: exactly 0.05, repeatCount 0
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                repeat: false,
                bubbles: true
            }))
        })
        let current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)
        expect(current.repeatCount).toBe(0)

        // Sustained hold simulated via keydown repeat events
        // Dispatch 4 repeat keydown events for ArrowRight
        for (let i = 1; i <= 4; i++) {
            await page.evaluate(() => {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'ArrowRight',
                    code: 'ArrowRight',
                    repeat: true,
                    bubbles: true
                }))
            })
        }

        current = await getXfade()
        expect(current.repeatCount).toBe(4)
        // At repeat 4: initial (0.05), repeat 1 (0.10), repeat 2 (0.15), repeat 3 (0.20), repeat 4 (0.20 + 0.0625 = 0.2625)
        expect(current.stateVal).toBeCloseTo(0.2625, 4)

        // Keyup event resets repeatCount immediately
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                bubbles: true
            }))
        })

        current = await getXfade()
        expect(current.repeatCount).toBe(0)

        // Subsequent single tap steps by exactly 0.05 baseline again (no lingering acceleration)
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                repeat: false,
                bubbles: true
            }))
        })
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.3125, 4)
        expect(current.repeatCount).toBe(0)
    } finally {
        await context.close()
    }
})

test('crossfader focus lock prevention and Home/End deck cuts', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const getXfade = () => page.evaluate(() => ({
            stateVal: window.__visualize.state.crossfade,
            domVal: parseFloat(document.getElementById('crossfader').value)
        }))

        // 1. Home and End keys cut to Deck A (0) and Deck B (1)
        await page.keyboard.press('End')
        let current = await getXfade()
        expect(current.stateVal).toBe(1)
        expect(current.domVal).toBe(1)

        await page.keyboard.press('Home')
        current = await getXfade()
        expect(current.stateVal).toBe(0)
        expect(current.domVal).toBe(0)

        // 2. Escape blurs focused crossfader (prevents focus lock)
        await page.focus('#crossfader')
        let isFocused = await page.evaluate(() => document.activeElement?.id === 'crossfader')
        expect(isFocused).toBe(true)

        await page.keyboard.press('Escape')
        isFocused = await page.evaluate(() => document.activeElement?.id === 'crossfader')
        expect(isFocused).toBe(false)

        // 3. Focusing a button (e.g. #cut-a) does not lock arrow keys
        await page.focus('#cut-a')
        let activeTag = await page.evaluate(() => document.activeElement?.id)
        expect(activeTag).toBe('cut-a')

        await page.keyboard.press('ArrowRight')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)

        // 4. Focusing a non-crossfader slider (#speed-a) and pressing End does not cut crossfader
        await page.focus('#speed-a')
        await page.keyboard.press('End')
        current = await getXfade()
        expect(current.stateVal).toBeCloseTo(0.05, 4)
    } finally {
        await context.close()
    }
})
