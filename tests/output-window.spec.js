// SPDX-License-Identifier: MIT
/**
 * Output window: when the browser blocks the pop-up, the app says so in
 * its own toast. It never opens a built-in browser dialog.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test('a blocked output pop-up shows a toast, not a browser dialog', async ({ page }) => {
    const dialogs = []
    page.on('dialog', async (dialog) => {
        dialogs.push(`${dialog.type()}: ${dialog.message()}`)
        await dialog.dismiss()
    })
    // A blocked pop-up: window.open returns null.
    await page.addInitScript(() => { window.open = () => null })

    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })

    await page.click('#output-window')
    await expect(page.locator('#toast')).toContainText('Output window blocked')
    await expect(page.locator('#toast')).toHaveClass(/show/)
    expect(dialogs).toEqual([])
})

test('the output window shows the fullscreen hint on open', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })

    const popupOpened = page.waitForEvent('popup')
    await page.click('#output-window')
    const popup = await popupOpened
    const hint = popup.locator('.hint')
    await expect(hint).toHaveText('drag to projector · press F for fullscreen · close to detach')

    // The hint is visible when the window opens and fades out after three
    // seconds. Seek its fade to read the opacity at open and at the end.
    const fade = await hint.evaluate(el => {
        const [animation] = el.getAnimations()
        if (!animation) return { atOpen: getComputedStyle(el).opacity }
        const { delay, duration } = animation.effect.getComputedTiming()
        const playing = animation.currentTime
        animation.pause()
        animation.currentTime = 0
        const atOpen = getComputedStyle(el).opacity
        animation.currentTime = delay + duration
        const atEnd = getComputedStyle(el).opacity
        animation.currentTime = playing
        animation.play()
        return { delay, duration, atOpen, atEnd }
    })
    expect(fade).toEqual({ delay: 3000, duration: 1000, atOpen: '1', atEnd: '0' })
    await expect(hint).toHaveCSS('opacity', '0', { timeout: 10_000 * SCALE })
})
