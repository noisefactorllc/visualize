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

test('escape dismisses settings drawer and restores focus to #settings-toggle', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const settingsDrawer = page.locator('#settings-drawer')
        const settingsToggle = page.locator('#settings-toggle')

        // Initially closed
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'true')

        // Open settings via S key
        await page.keyboard.press('s')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'false')

        // Press Escape to dismiss settings
        await page.keyboard.press('Escape')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'true')

        // Focus restored to settings toggle button
        await expect(settingsToggle).toBeFocused()
    } finally {
        await context.close()
    }
})

test('escape dismisses scenes drawer and restores focus to #scenes-open', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const scenesDrawer = page.locator('#scenes-drawer')
        const scenesOpen = page.locator('#scenes-open')

        // Initially closed
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')

        // Open scenes via Shift+S
        await page.keyboard.press('Shift+S')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'false')

        // Press Escape to dismiss scenes
        await page.keyboard.press('Escape')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')

        // Focus restored to scenes open button
        await expect(scenesOpen).toBeFocused()
    } finally {
        await context.close()
    }
})

test('mutual drawer exclusion: opening one drawer closes the other', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const settingsDrawer = page.locator('#settings-drawer')
        const scenesDrawer = page.locator('#scenes-drawer')

        // Open scenes drawer via keyboard
        await page.keyboard.press('Shift+S')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'false')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'true')

        // Open settings drawer via keyboard S -> closes scenes drawer
        await page.keyboard.press('s')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'false')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')

        // Open scenes drawer again via keyboard Shift+S -> closes settings drawer
        await page.keyboard.press('Shift+S')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'false')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'true')

        // Dismiss via Escape
        await page.keyboard.press('Escape')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')
    } finally {
        await context.close()
    }
})

test('escape while focused in scene-name-input dismisses drawer and restores focus', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const scenesDrawer = page.locator('#scenes-drawer')
        const scenesOpen = page.locator('#scenes-open')
        const sceneNameInput = page.locator('#scene-name-input')

        // Open scenes drawer
        await page.keyboard.press('Shift+S')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'false')

        // Focus and type in the scene name input
        await sceneNameInput.click()
        await sceneNameInput.fill('Temp Scene Draft')
        await expect(sceneNameInput).toBeFocused()

        // Press Escape while focused on the input
        await page.keyboard.press('Escape')

        // Drawer should be dismissed cleanly
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')
        await expect(scenesOpen).toBeFocused()
    } finally {
        await context.close()
    }
})

test('escape priority in fullscreen: dismisses open drawer without exiting fullscreen', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const app = page.locator('#app')
        const settingsDrawer = page.locator('#settings-drawer')
        const scenesDrawer = page.locator('#scenes-drawer')

        // Mock fullscreen state on document to simulate live fullscreen reliably across environments
        await page.evaluate(() => {
            window.__exitFullscreenCalls = 0
            const origExit = document.exitFullscreen?.bind(document)
            let mockFullscreen = true

            Object.defineProperty(document, 'fullscreenElement', {
                configurable: true,
                get: () => mockFullscreen ? document.getElementById('app') : null
            })

            document.exitFullscreen = async () => {
                window.__exitFullscreenCalls++
                mockFullscreen = false
                document.getElementById('app')?.classList.remove('fullscreen-main')
                document.dispatchEvent(new Event('fullscreenchange'))
                return origExit ? origExit().catch(() => {}) : undefined
            }

            document.getElementById('app')?.classList.add('fullscreen-main')
            document.dispatchEvent(new Event('fullscreenchange'))
        })

        await expect(app).toHaveClass(/\bfullscreen-main\b/)

        // 1. Open settings drawer via keyboard S while in fullscreen
        await page.keyboard.press('s')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'false')

        // 2. Press Escape: must dismiss settings drawer BUT MUST NOT exit fullscreen
        await page.keyboard.press('Escape')
        await expect(settingsDrawer).toHaveAttribute('aria-hidden', 'true')

        // Fullscreen remains active!
        await expect(app).toHaveClass(/\bfullscreen-main\b/)
        const exitCalls1 = await page.evaluate(() => window.__exitFullscreenCalls)
        expect(exitCalls1).toBe(0)

        // 3. Open scenes drawer via keyboard Shift+S while in fullscreen
        await page.keyboard.press('Shift+S')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'false')

        // Focus input inside scenes drawer
        await page.locator('#scene-name-input').fill('Testing in Fullscreen')

        // Press Escape: dismisses scenes drawer BUT MUST NOT exit fullscreen
        await page.keyboard.press('Escape')
        await expect(scenesDrawer).toHaveAttribute('aria-hidden', 'true')

        // Fullscreen STILL remains active!
        await expect(app).toHaveClass(/\bfullscreen-main\b/)
        const exitCalls2 = await page.evaluate(() => window.__exitFullscreenCalls)
        expect(exitCalls2).toBe(0)

        // 4. Now with NO drawers open, press Escape: now it exits fullscreen!
        await page.keyboard.press('Escape')
        await expect(app).not.toHaveClass(/\bfullscreen-main\b/)
        const exitCalls3 = await page.evaluate(() => window.__exitFullscreenCalls)
        expect(exitCalls3).toBe(1)
    } finally {
        await context.close()
    }
})
