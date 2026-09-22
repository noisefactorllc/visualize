// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'

test.describe.configure({ timeout: 60_000, retries: 0 })

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await routeHandfishLocal(page)
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.scenes, null, { timeout: 30_000 })
    return { context, page }
}

test('scenes drawer inline rename validates against empty/duplicate names and persists across reloads', async ({ browser }) => {
    const { context, page } = await boot(browser)

    // Open scenes drawer
    await page.click('#scenes-open')
    await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'false')

    // Clean initial scenes
    await page.evaluate(() => {
        localStorage.removeItem('visualize.scenes.v1')
        if (window.__visualize?.scenes) {
            window.__visualize.scenes._scenes = []
            window.__visualize.scenes._emit()
        }
    })

    // Save two scenes: "Scene Alpha" and "Scene Beta"
    await page.fill('#scene-name-input', 'Scene Alpha')
    await page.click('#scene-save')
    await expect(page.locator('#scenes-list .scene-row')).toHaveCount(1)

    await page.fill('#scene-name-input', 'Scene Beta')
    await page.click('#scene-save')
    await expect(page.locator('#scenes-list .scene-row')).toHaveCount(2)

    const firstRow = page.locator('#scenes-list .scene-row').nth(0)
    const secondRow = page.locator('#scenes-list .scene-row').nth(1)

    await expect(firstRow.locator('.sr-name')).toHaveText('Scene Alpha')
    await expect(secondRow.locator('.sr-name')).toHaveText('Scene Beta')

    // 1. Click rename button on first row to enter inline edit mode
    await firstRow.locator('.sr-rename').click()
    const input = firstRow.locator('.sr-rename-input')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Scene Alpha')
    await expect(firstRow.locator('.sr-rename-save')).toBeVisible()
    await expect(firstRow.locator('.sr-rename-cancel')).toBeVisible()

    // 2. Validate Empty Name Rejection
    await input.fill('   ')
    await firstRow.locator('.sr-rename-save').click()

    // Error toast appears and input gets error styling
    const toast = page.locator('#toast')
    await expect(toast).toContainText(/empty/i)
    await expect(input).toHaveClass(/sr-input-error/)

    // State is preserved
    let scenes = await page.evaluate(() => window.__visualize.scenes.scenes)
    expect(scenes[0].name).toBe('Scene Alpha')

    // 3. Validate Duplicate Name Rejection (case-insensitive against "Scene Beta")
    await input.fill('scene beta')
    await input.press('Enter')

    await expect(toast).toContainText(/already exists/i)
    await expect(input).toHaveClass(/sr-input-error/)

    scenes = await page.evaluate(() => window.__visualize.scenes.scenes)
    expect(scenes[0].name).toBe('Scene Alpha')

    // 4. Test Escape Cancellation
    await input.press('Escape')
    await expect(firstRow.locator('.sr-rename-input')).toHaveCount(0)
    await expect(firstRow.locator('.sr-name')).toHaveText('Scene Alpha')

    // 5. Test Double-click rename trigger and Successful Commit
    // Track toasts to verify recallScene is never called by clicking or double-clicking .sr-name
    await page.evaluate(() => {
        window.__testToasts = []
        const origToast = window.toast
        window.toast = (msg) => {
            window.__testToasts.push(msg)
            return origToast ? origToast(msg) : undefined
        }
    })

    // Single-click on .sr-name does not recall
    await firstRow.locator('.sr-name').click()
    let toastHistory = await page.evaluate(() => window.__testToasts)
    expect(toastHistory.some(t => /recall/i.test(t))).toBe(false)

    // Double-click triggers inline rename mode without triggering recall
    await firstRow.locator('.sr-name').dblclick()
    toastHistory = await page.evaluate(() => window.__testToasts)
    expect(toastHistory.some(t => /recall/i.test(t))).toBe(false)

    await expect(firstRow.locator('.sr-rename-input')).toBeVisible()
    await firstRow.locator('.sr-rename-input').fill('Scene Prime')
    await firstRow.locator('.sr-rename-save').click()

    await expect(toast).toContainText('renamed: Scene Prime')
    await expect(firstRow.locator('.sr-rename-input')).toHaveCount(0)
    await expect(firstRow.locator('.sr-name')).toHaveText('Scene Prime')

    // Verify ordering and slot positions are intact (Index 0 is Prime, Index 1 is Beta)
    scenes = await page.evaluate(() => window.__visualize.scenes.scenes)
    expect(scenes.length).toBe(2)
    expect(scenes[0].name).toBe('Scene Prime')
    expect(scenes[1].name).toBe('Scene Beta')

    // Verify localStorage persistence
    const stored = await page.evaluate(() => {
        const raw = localStorage.getItem('visualize.scenes.v1')
        return raw ? JSON.parse(raw) : []
    })
    expect(stored[0].name).toBe('Scene Prime')
    expect(stored[1].name).toBe('Scene Beta')

    // 6. Test Drawer Close / Reset
    // Start editing second row, then close drawer via #scenes-close
    await secondRow.locator('.sr-rename').click()
    await expect(secondRow.locator('.sr-rename-input')).toBeVisible()
    await page.click('#scenes-close')
    await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'true')
    // Reopen via Shift+S - edit mode must be reset
    await page.keyboard.press('Shift+KeyS')
    await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'false')
    await expect(secondRow.locator('.sr-rename-input')).toHaveCount(0)

    // 7. Verify Persistence Across Page Reload
    await page.reload()
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize?.scenes, null, { timeout: 30_000 })
    await page.click('#scenes-open')

    const reloadedFirstRow = page.locator('#scenes-list .scene-row').nth(0)
    const reloadedSecondRow = page.locator('#scenes-list .scene-row').nth(1)
    await expect(reloadedFirstRow.locator('.sr-name')).toHaveText('Scene Prime')
    await expect(reloadedSecondRow.locator('.sr-name')).toHaveText('Scene Beta')

    await context.close()
})
