// SPDX-License-Identifier: MIT
/**
 * Fullscreen main: the F shortcut fills the screen with the main canvas
 * and nothing else. The mixer-effect toolbar and the mixer parameter
 * panel stay out of fullscreen, as the main header and FX strip do.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
import { cursorsShown } from './cursorsShown.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test('fullscreen shows only the main canvas', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })
    // The mixer parameter panel is on screen before fullscreen.
    await expect(page.locator('#mixer-controls')).toBeVisible({ timeout: 30_000 * SCALE })

    await page.locator('body').press('f')
    await page.waitForFunction(() => document.fullscreenElement?.id === 'app')

    // Every point of the screen hits the main canvas or its FX overlay.
    const elsewhere = await page.evaluate(() => {
        const hits = new Set()
        for (let y = 1; y < innerHeight; y += 8) {
            for (let x = 1; x < innerWidth; x += 8) {
                const el = document.elementFromPoint(x, y)
                if (!el?.closest('.main-canvas-wrap')) {
                    const owner = el?.closest('[id], [class]') || el
                    hits.add(owner ? `${owner.tagName.toLowerCase()}#${owner.id}.${[...owner.classList].join('.')}` : 'none')
                }
            }
        }
        return [...hits]
    })
    expect(elsewhere).toEqual([])
    for (const selector of ['.main-head', '.main-toolbar', '#mixer-controls', '.main-fx']) {
        await expect(page.locator(selector)).toBeHidden()
    }

    // Leaving fullscreen brings the toolbar and the mixer panel back.
    await page.locator('body').press('Escape')
    await page.waitForFunction(() => !document.fullscreenElement)
    await expect(page.locator('.main-toolbar')).toBeVisible()
    await expect(page.locator('#mixer-controls')).toBeVisible()
})

test('fullscreen hides the cursor over the whole screen', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })
    const canvasCursor = () => page.locator('#main-canvas').evaluate(el => getComputedStyle(el).cursor)
    const before = await canvasCursor()
    expect(before).not.toBe('none')

    await page.locator('body').press('f')
    await page.waitForFunction(() => document.fullscreenElement?.id === 'app')
    expect(await cursorsShown(page)).toEqual([])
    // Moving and clicking keep it hidden.
    const { width, height } = page.viewportSize()
    await page.mouse.move(width / 2, height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move(width - 2, height - 2)
    expect(await cursorsShown(page)).toEqual([])
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('app')

    // Leaving fullscreen brings the cursor back.
    await page.locator('body').press('Escape')
    await page.waitForFunction(() => !document.fullscreenElement)
    expect(await canvasCursor()).toBe(before)
})
