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

test('browser: transport and performance touch targets satisfy minimum 44px hit dimensions', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // 1. Quick-cut transport buttons (#cut-a, #auto-fade, #cut-b) have bounding rect >= 44x44px
        const quickCutIds = ['#cut-a', '#auto-fade', '#cut-b']
        for (const id of quickCutIds) {
            const btn = page.locator(id)
            await expect(btn).toBeVisible()
            const box = await btn.boundingBox()
            expect(box, `bounding box for ${id} should exist`).not.toBeNull()
            expect(box.width, `width of ${id} must be at least 44px`).toBeGreaterThanOrEqual(44)
            expect(box.height, `height of ${id} must be at least 44px`).toBeGreaterThanOrEqual(44)
        }

        // 2. Main FX buttons provide at least 44px tactile height
        const fxButtons = page.locator('.fx-button')
        const fxCount = await fxButtons.count()
        expect(fxCount).toBe(6)
        for (let i = 0; i < fxCount; i++) {
            const btn = fxButtons.nth(i)
            const box = await btn.boundingBox()
            expect(box, `bounding box for fx button ${i}`).not.toBeNull()
            expect(box.height, `height of fx button ${i} must be at least 44px`).toBeGreaterThanOrEqual(44)
        }

        // 3. Status pills provide centered ::after pseudo-element with >= 44x44px hit dimensions
        const statusPills = ['#audio-status', '#midi-status', '#automix-toggle', '#scenes-open', '#record-toggle']
        for (const id of statusPills) {
            const targetSize = await page.evaluate((selector) => {
                const el = document.querySelector(selector)
                if (!el) return null
                const style = window.getComputedStyle(el, '::after')
                return {
                    minWidth: parseFloat(style.minWidth) || 0,
                    minHeight: parseFloat(style.minHeight) || 0,
                    position: style.position,
                }
            }, id)
            expect(targetSize, `targetSize for ${id}`).not.toBeNull()
            expect(targetSize.minWidth, `minWidth of ::after on ${id} must be >= 44px`).toBeGreaterThanOrEqual(44)
            expect(targetSize.minHeight, `minHeight of ::after on ${id} must be >= 44px`).toBeGreaterThanOrEqual(44)
        }

        // 4. Deck action buttons provide centered ::after pseudo-element with >= 44x44px hit dimensions
        const deckActionButtons = ['.deck-load-random', '.deck-edit-toggle', '.deck-rebind-eq', '.deck-rebind-midi', '.deck-bandpass']
        for (const cls of deckActionButtons) {
            const targetSize = await page.evaluate((selector) => {
                const el = document.querySelector(selector)
                if (!el) return null
                const style = window.getComputedStyle(el, '::after')
                return {
                    minWidth: parseFloat(style.minWidth) || 0,
                    minHeight: parseFloat(style.minHeight) || 0,
                }
            }, cls)
            expect(targetSize, `targetSize for ${cls}`).not.toBeNull()
            expect(targetSize.minWidth, `minWidth of ::after on ${cls} must be >= 44px`).toBeGreaterThanOrEqual(44)
            expect(targetSize.minHeight, `minHeight of ::after on ${cls} must be >= 44px`).toBeGreaterThanOrEqual(44)
        }

        // 5. Functional live touch interactions on the enlarged controls
        // Clicking Cut B snaps crossfader to 1
        await page.click('#cut-b')
        await expect.poll(async () => {
            return await page.evaluate(() => parseFloat(document.getElementById('crossfader').value))
        }).toBe(1)

        // Clicking Cut A snaps crossfader to 0
        await page.click('#cut-a')
        await expect.poll(async () => {
            return await page.evaluate(() => parseFloat(document.getElementById('crossfader').value))
        }).toBe(0)

        // Clicking Strobe toggles FX
        const strobeBtn = page.locator('.fx-button[data-fx="strobe"]')
        await strobeBtn.click()
        await expect(strobeBtn).toHaveAttribute('aria-pressed', 'true')
        await strobeBtn.click()
        await expect(strobeBtn).toHaveAttribute('aria-pressed', 'false')

        // 6. Offset click verification: clicking outside the compact visual boundary
        // but inside the 44x44 ::after pseudo-element delivers the click event
        const automixBtn = page.locator('#automix-toggle')
        const autoBox = await automixBtn.boundingBox()
        expect(autoBox).not.toBeNull()
        // The visual pill is ~24px tall. The ::after target extends >= 44px (10px above and below).
        // Clicking 4px above the top visual edge lands squarely on ::after.
        await page.mouse.click(autoBox.x + autoBox.width / 2, autoBox.y - 4)
        await expect(automixBtn).toHaveAttribute('data-state', 'on')
        // Click 4px above again to toggle off
        await page.mouse.click(autoBox.x + autoBox.width / 2, autoBox.y - 4)
        await expect(automixBtn).toHaveAttribute('data-state', 'off')

        // 7. Preset scene drawer action buttons provide expanded touch targets and safety margin
        await page.click('#scenes-open')
        await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'false')
        await page.evaluate(() => {
            localStorage.removeItem('visualize.scenes.v1')
            if (window.__visualize?.scenes) {
                window.__visualize.scenes._scenes = []
                window.__visualize.scenes._emit()
            }
        })
        await page.fill('#scene-name-input', 'Touch Target Test Scene')
        await page.click('#scene-save')
        await expect(page.locator('#scenes-list .scene-row')).toHaveCount(1)

        const sceneRowButtons = page.locator('#scenes-list .scene-row .sr-actions button')
        const rowBtnCount = await sceneRowButtons.count()
        expect(rowBtnCount).toBeGreaterThanOrEqual(2)
        for (let i = 0; i < rowBtnCount; i++) {
            const btn = sceneRowButtons.nth(i)
            const targetSize = await btn.evaluate((el) => {
                const style = window.getComputedStyle(el, '::after')
                return {
                    minWidth: parseFloat(style.minWidth) || 0,
                    minHeight: parseFloat(style.minHeight) || 0,
                }
            })
            expect(targetSize.minWidth, `scene button ${i} ::after minWidth`).toBeGreaterThanOrEqual(44)
            expect(targetSize.minHeight, `scene button ${i} ::after minHeight`).toBeGreaterThanOrEqual(44)
        }

        const deleteBtn = page.locator('#scenes-list .scene-row .sr-delete')
        const deleteMarginLeft = await deleteBtn.evaluate((el) => {
            return parseFloat(window.getComputedStyle(el).marginLeft) || 0
        })
        expect(deleteMarginLeft, 'destructive delete button must have safety margin from --hf-space-2').toBeGreaterThanOrEqual(7)
    } finally {
        await context.close()
    }
})
