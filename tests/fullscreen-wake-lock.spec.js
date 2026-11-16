// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

test.describe.configure({ timeout: 60_000 * SCALE })

// Replaces navigator.wakeLock with a recorder, in the main window and in
// each window it opens. uaRelease() does what the browser does when the page
// is hidden: it releases every held lock.
function recordWakeLocks() {
    const record = (win) => {
        const requests = []
        const sentinels = []
        Object.defineProperty(win.navigator, 'wakeLock', {
            configurable: true,
            value: {
                async request(type) {
                    requests.push(type)
                    const sentinel = new EventTarget()
                    let released = false
                    sentinel.type = type
                    Object.defineProperty(sentinel, 'released', { get: () => released })
                    sentinel.drop = () => {
                        if (released) return
                        released = true
                        sentinel.dispatchEvent(new Event('release'))
                    }
                    sentinel.release = async () => sentinel.drop()
                    sentinels.push(sentinel)
                    return sentinel
                },
            },
        })
        return {
            requests,
            held: () => sentinels.filter(s => !s.released).map(s => s.type),
            uaRelease: () => sentinels.forEach(s => s.drop()),
        }
    }
    window.__wakeLocks = record(window)
    const open = window.open
    window.open = function (...args) {
        const opened = open.apply(this, args)
        if (opened) window.__outputWakeLocks = record(opened)
        return opened
    }
}

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await routeHandfishLocal(page)
    await page.addInitScript(recordWakeLocks)
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.waitForFunction(() => !!window.__visualize?.scenes,
        null, { timeout: 30_000 * SCALE })
    return { context, page }
}

const wakeLocks = (page, log = '__wakeLocks') => page.evaluate(name => ({
    requests: window[name].requests.length,
    held: window[name].held(),
}), log)
const outputWakeLocks = page => wakeLocks(page, '__outputWakeLocks')

test('the main view holds a screen wake lock only while it is fullscreen', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        expect(await wakeLocks(page)).toEqual({ requests: 0, held: [] })

        await page.keyboard.press('f')
        await page.waitForFunction(() => !!document.fullscreenElement)
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 1, held: ['screen'] })

        await page.keyboard.press('f')
        await page.waitForFunction(() => !document.fullscreenElement)
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 1, held: [] })
    } finally {
        await context.close()
    }
})

test('fullscreen requests the wake lock again when the page is visible again', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        await page.keyboard.press('f')
        await page.waitForFunction(() => !!document.fullscreenElement)
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 1, held: ['screen'] })

        await page.evaluate(() => {
            let state = 'hidden'
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
            window.__setVisibility = next => {
                state = next
                document.dispatchEvent(new Event('visibilitychange'))
            }
            window.__wakeLocks.uaRelease()
            document.dispatchEvent(new Event('visibilitychange'))
        })
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 1, held: [] })

        await page.evaluate(() => window.__setVisibility('visible'))
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 2, held: ['screen'] })

        await page.keyboard.press('f')
        await page.waitForFunction(() => !document.fullscreenElement)
        await expect.poll(() => wakeLocks(page)).toEqual({ requests: 2, held: [] })
    } finally {
        await context.close()
    }
})

test('the output window holds its own screen wake lock only while it is fullscreen', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const opened = page.waitForEvent('popup')
        await page.click('#output-window')
        const output = await opened
        await output.waitForFunction(() => !!window._visualizeOutput)
        expect(await outputWakeLocks(page)).toEqual({ requests: 0, held: [] })

        await output.keyboard.press('f')
        await output.waitForFunction(() => !!document.fullscreenElement)
        await expect.poll(() => outputWakeLocks(page)).toEqual({ requests: 1, held: ['screen'] })
        // The lock is the output window's own: the main window asked for none.
        expect(await wakeLocks(page)).toEqual({ requests: 0, held: [] })

        // A hidden main window does not release the output window's lock.
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
            document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(await outputWakeLocks(page)).toEqual({ requests: 1, held: ['screen'] })
        await page.evaluate(() => {
            delete document.visibilityState
            document.dispatchEvent(new Event('visibilitychange'))
        })

        await output.keyboard.press('f')
        await output.waitForFunction(() => !document.fullscreenElement)
        await expect.poll(() => outputWakeLocks(page)).toEqual({ requests: 1, held: [] })

        await output.keyboard.press('f')
        await output.waitForFunction(() => !!document.fullscreenElement)
        await expect.poll(() => outputWakeLocks(page)).toEqual({ requests: 2, held: ['screen'] })

        // Closing the output window from the main window releases its lock.
        const closed = output.waitForEvent('close')
        await page.click('#output-window')
        await closed
        await expect.poll(() => outputWakeLocks(page)).toEqual({ requests: 2, held: [] })
    } finally {
        await context.close()
    }
})
