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
    await page.waitForFunction(() => !!window.__visualize?.scenes,
        null, { timeout: 30_000 })
    return { context, page }
}

test('browser: FX toggle buttons maintain active/latched state, ARIA semantics, and hover contrast', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const latchingFx = ['strobe', 'invert', 'bw', 'zoom', 'freeze']

        // 1. Initial boot state: all 5 latching toggles are unpressed/off
        for (const fx of latchingFx) {
            const btn = page.locator(`.fx-button[data-fx="${fx}"]`)
            await expect(btn).toBeVisible()
            await expect(btn).not.toHaveClass(/\bactive\b/)
            await expect(btn).toHaveAttribute('aria-pressed', 'false')
            await expect(btn).toHaveAttribute('data-state', 'off')
        }

        const flashBtn = page.locator('.fx-button[data-fx="flash"]')
        await expect(flashBtn).toBeVisible()
        await expect(flashBtn).not.toHaveClass(/\bactive\b/)
        const flashAria = await flashBtn.getAttribute('aria-pressed')
        expect(flashAria).toBeNull()

        // 2. Click toggling strobe: becomes active, latches aria-pressed and data-state
        const strobeBtn = page.locator('.fx-button[data-fx="strobe"]')
        await strobeBtn.click()

        await expect(strobeBtn).toHaveClass(/\bactive\b/)
        await expect(strobeBtn).toHaveAttribute('aria-pressed', 'true')
        await expect(strobeBtn).toHaveAttribute('data-state', 'on')

        // Move cursor away so we inspect the latched active state without hover
        await page.mouse.move(0, 0)
        await expect(strobeBtn).toHaveCSS('font-weight', /(?:700|bold)/)

        // 3. Hovering the active button preserves latched high-contrast active state
        await strobeBtn.hover()
        await expect(strobeBtn).toHaveClass(/\bactive\b/)
        await expect(strobeBtn).toHaveAttribute('aria-pressed', 'true')
        await expect(strobeBtn).toHaveAttribute('data-state', 'on')
        await expect(strobeBtn).toHaveCSS('font-weight', /(?:700|bold)/)

        // 4. Clicking again unlatches the button
        await strobeBtn.click()
        await expect(strobeBtn).not.toHaveClass(/\bactive\b/)
        await expect(strobeBtn).toHaveAttribute('aria-pressed', 'false')
        await expect(strobeBtn).toHaveAttribute('data-state', 'off')

        // 5. Keyboard shortcuts toggle FX and synchronize ARIA semantics (e.g. shortcut '2' for invert)
        const invertBtn = page.locator('.fx-button[data-fx="invert"]')
        await page.keyboard.press('2')
        await expect(invertBtn).toHaveClass(/\bactive\b/)
        await expect(invertBtn).toHaveAttribute('aria-pressed', 'true')
        await expect(invertBtn).toHaveAttribute('data-state', 'on')

        const canvasInvert = await page.evaluate(() =>
            document.getElementById('main-canvas')?.classList.contains('invert')
        )
        expect(canvasInvert).toBe(true)

        // Press '2' again to disable
        await page.keyboard.press('2')
        await expect(invertBtn).not.toHaveClass(/\bactive\b/)
        await expect(invertBtn).toHaveAttribute('aria-pressed', 'false')
        await expect(invertBtn).toHaveAttribute('data-state', 'off')

        // 6. Flash button triggers momentary feedback without latching aria-pressed
        // Register observer before click to avoid racing the 300ms overlay removal
        const flashPromise = page.evaluate(() => new Promise(resolve => {
            const overlay = document.getElementById('main-fx-overlay')
            if (!overlay) return resolve(false)
            if (overlay.classList.contains('flash')) return resolve(true)
            const observer = new MutationObserver(() => {
                if (overlay.classList.contains('flash')) {
                    observer.disconnect()
                    resolve(true)
                }
            })
            observer.observe(overlay, { attributes: true, attributeFilter: ['class'] })
            setTimeout(() => {
                observer.disconnect()
                resolve(overlay.classList.contains('flash'))
            }, 3000)
        }))

        await flashBtn.click()
        const sawFlash = await flashPromise
        expect(sawFlash).toBe(true)
        await expect(flashBtn).not.toHaveClass(/\bactive\b/)
        expect(await flashBtn.getAttribute('aria-pressed')).toBeNull()

        // 7. Theme switching maintains styling across Handfish themes
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'cyberpunk'
        })
        await page.keyboard.press('3') // B&W
        const bwBtn = page.locator('.fx-button[data-fx="bw"]')
        await expect(bwBtn).toHaveClass(/\bactive\b/)
        await expect(bwBtn).toHaveAttribute('aria-pressed', 'true')
        await expect(bwBtn).toHaveAttribute('data-state', 'on')

        // Switch to a light theme
        await page.evaluate(() => {
            document.documentElement.dataset.theme = 'neutral-light'
        })
        await expect(bwBtn).toHaveClass(/\bactive\b/)
        await expect(bwBtn).toHaveAttribute('aria-pressed', 'true')
        await expect(bwBtn).toHaveAttribute('data-state', 'on')

        // Restore
        await page.keyboard.press('3')
        await expect(bwBtn).not.toHaveClass(/\bactive\b/)
        await expect(bwBtn).toHaveAttribute('aria-pressed', 'false')
    } finally {
        await context.close()
    }
})
