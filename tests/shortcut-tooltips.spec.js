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

test('browser: performance shortcuts appear in tooltips across all controls', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // Helper to check element has .tooltip, matching data-title, and no native title
        const checkTooltip = async (selector, expectedSubstring) => {
            const el = page.locator(selector).first()
            await expect(el).toHaveClass(/\btooltip\b/)
            const dataTitle = await el.getAttribute('data-title')
            expect(dataTitle).toContain(expectedSubstring)
            const title = await el.getAttribute('title')
            expect(title).toBeNull()
        }

        // 1. Transport bar
        await checkTooltip('#automix-toggle', '(Space)')
        await checkTooltip('#scenes-open', '(Shift+S)')
        await checkTooltip('#record-toggle', '(R)')
        await checkTooltip('#settings-toggle', '(S)')
        await checkTooltip('#fullscreen-toggle', '(F)')
        await checkTooltip('#crossfader', '5%')

        // 2. Tempo bar tap button
        await checkTooltip('.tempo-bar__tap', 'Tap tempo (T)')

        // 3. Quick cuts
        await checkTooltip('#cut-a', 'Cut to A (Z)')
        await checkTooltip('#auto-fade', 'Auto-fade (X)')
        await checkTooltip('#cut-b', 'Cut to B (C)')

        // 4. Main FX toggles (1-6)
        await checkTooltip('.fx-button[data-fx="strobe"]', '(1)')
        await checkTooltip('.fx-button[data-fx="invert"]', '(2)')
        await checkTooltip('.fx-button[data-fx="bw"]', '(3)')
        await checkTooltip('.fx-button[data-fx="zoom"]', '(4)')
        await checkTooltip('.fx-button[data-fx="freeze"]', '(5)')
        await checkTooltip('.fx-button[data-fx="flash"]', '(6)')

        // 5. Deck A and B random and rebind buttons
        await checkTooltip('.deck-load-random[data-deck="A"]', '(Q)')
        await checkTooltip('.deck-load-random[data-deck="B"]', '(W)')
        await checkTooltip('.deck-rebind-eq[data-deck="A"]', '(E)')
        await checkTooltip('.deck-rebind-eq[data-deck="B"]', '(Shift+E)')
        await checkTooltip('.deck-rebind-midi[data-deck="A"]', '(M)')
        await checkTooltip('.deck-rebind-midi[data-deck="B"]', '(Shift+M)')

        // 6. Drawer close buttons
        await checkTooltip('#settings-close', 'Close settings (Esc)')
        await checkTooltip('#scenes-close', 'Close scenes (Esc)')
    } finally {
        await context.close()
    }
})

test('browser: record button tooltip dynamically reflects recording state with (R) shortcut', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const recordBtn = page.locator('#record-toggle')
        await expect(recordBtn).toHaveAttribute('data-title', 'Record main output (R)')

        // If MediaRecorder is supported in test environment, trigger record toggle
        const isSupported = await page.evaluate(() => typeof MediaRecorder !== 'undefined')
        if (isSupported) {
            await page.keyboard.press('r')
            await expect(recordBtn).toHaveAttribute('data-state', 'on')
            await expect(recordBtn).toHaveAttribute('data-title', 'Stop recording (R)')

            // Stop recording
            await page.keyboard.press('r')
            await expect(recordBtn).toHaveAttribute('data-state', 'off')
            await expect(recordBtn).toHaveAttribute('data-title', 'Record main output (R)')
        }
    } finally {
        await context.close()
    }
})

test('browser: scene recall buttons in drawer display Shift+1..9 shortcuts in tooltips', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // Open scenes drawer
        await page.click('#scenes-open')
        await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'false')

        // Save a test scene if none exists
        await page.fill('#scene-name-input', 'Test Scene 1')
        await page.click('#scene-save')

        // First scene recall button should have Shift+1 tooltip
        const firstRecall = page.locator('#scenes-list .scene-row button').filter({ hasText: /^recall$/ }).first()
        await expect(firstRecall).toHaveClass(/\btooltip\b/)
        await expect(firstRecall).toHaveAttribute('data-title', 'Recall scene (Shift+1)')

        // Scene name in row should have Handfish tooltip attributes and no native title
        const sceneNameEl = page.locator('#scenes-list .scene-row .sr-name').first()
        await expect(sceneNameEl).toHaveClass(/\btooltip\b/)
        await expect(sceneNameEl).toHaveAttribute('data-title', 'Double-click to rename')
        expect(await sceneNameEl.getAttribute('title')).toBeNull()

        // Close scenes drawer via Esc
        await page.keyboard.press('Escape')
        await expect(page.locator('#scenes-drawer')).toHaveAttribute('aria-hidden', 'true')
    } finally {
        await context.close()
    }
})
