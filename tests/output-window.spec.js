// SPDX-License-Identifier: MIT
/**
 * Output window: when the browser blocks the pop-up, the app says so in
 * its own toast. It never opens a built-in browser dialog.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
import { cursorsShown } from './cursorsShown.js'
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

test('the fullscreen output window hides the cursor over the whole screen', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })

    const popupOpened = page.waitForEvent('popup')
    await page.click('#output-window')
    const popup = await popupOpened
    await popup.waitForFunction(() => !!window._visualizeOutput)

    await popup.locator('body').press('f')
    await popup.waitForFunction(() => document.fullscreenElement === document.documentElement)
    expect(await cursorsShown(popup)).toEqual([])
    // Moving and clicking keep it hidden.
    const { width, height } = popup.viewportSize()
    await popup.mouse.move(width / 2, height / 2)
    await popup.mouse.down()
    await popup.mouse.up()
    expect(await cursorsShown(popup)).toEqual([])

    await popup.locator('body').press('f')
    await popup.waitForFunction(() => !document.fullscreenElement)
    await popup.close()
})

test('the output window keeps getting new frames while the main window is hidden', async ({ page }) => {
    // Stand-in for a hidden main window (minimized, or on another Space
    // behind a fullscreen output window): the browser reports the document
    // hidden and runs none of its animation frames until it is shown again.
    await page.addInitScript(() => {
        const request = window.requestAnimationFrame.bind(window)
        const cancel = window.cancelAnimationFrame.bind(window)
        const pending = new Map()
        let next = 1
        let hidden = false
        window.requestAnimationFrame = (callback) => {
            const id = next++
            const run = (time) => {
                if (!pending.has(id)) return
                if (hidden) {
                    pending.set(id, request(run))
                    return
                }
                pending.delete(id)
                callback(time)
            }
            pending.set(id, request(run))
            return id
        }
        window.cancelAnimationFrame = (id) => {
            const handle = pending.get(id)
            pending.delete(id)
            if (handle) cancel(handle)
        }
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
        window.__setMainWindowHidden = (value) => {
            hidden = value
            document.dispatchEvent(new Event('visibilitychange'))
        }
    })

    await page.goto('/')
    await expect(page.locator('#toast')).toContainText('ready', { timeout: 30_000 * SCALE })
    await page.evaluate(() => {
        window.__mainFrames = 0
        window.__visualize.compositor.onFrame(() => { window.__mainFrames++ })
    })

    const popupOpened = page.waitForEvent('popup')
    await page.click('#output-window')
    const popup = await popupOpened
    await popup.waitForFunction(() => !!window._visualizeOutput)
    // Record which main frame the output window drew last, and how often it drew.
    await popup.evaluate(() => {
        window.__draws = 0
        window.__drawnFrame = -1
        const draw = window._visualizeOutput.draw
        window._visualizeOutput.draw = function (source) {
            draw.call(this, source)
            window.__draws++
            window.__drawnFrame = window.opener.__mainFrames
        }
    })
    const drawnFrame = () => popup.evaluate(() => window.__drawnFrame)
    const mainFrames = () => page.evaluate(() => window.__mainFrames)
    await expect.poll(drawnFrame, { timeout: 10_000 * SCALE }).toBeGreaterThan(10)

    await page.evaluate(() => window.__setMainWindowHidden(true))
    const hiddenAt = await mainFrames()
    const drawsAt = await popup.evaluate(() => window.__draws)
    await expect.poll(drawnFrame, { timeout: 10_000 * SCALE }).toBeGreaterThan(hiddenAt + 30)
    // One main frame per output frame: the hidden main window runs on the
    // output window's frames, never twice per frame.
    const frames = (await mainFrames()) - hiddenAt
    const draws = (await popup.evaluate(() => window.__draws)) - drawsAt
    expect(frames).toBeLessThanOrEqual(draws + 2)

    // Shown again, the main window runs on its own frames.
    await page.evaluate(() => window.__setMainWindowHidden(false))
    const shownAt = await mainFrames()
    await expect.poll(drawnFrame, { timeout: 10_000 * SCALE }).toBeGreaterThan(shownAt + 30)
    await popup.close()
    const closedAt = await mainFrames()
    await expect.poll(mainFrames, { timeout: 10_000 * SCALE }).toBeGreaterThan(closedAt + 30)
})
