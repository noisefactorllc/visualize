// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

test.describe.configure({ timeout: 60_000 * SCALE })

// Every button that connects to Sync or opens its dialog.
const SYNC_BUTTONS = ['#sync-output-open', '#sync-audio-connect', '#sync-output-action']

// The mark's place in its button, its computed mask image and its rendered box.
const markOf = (page, selector) => page.locator(selector).evaluate((button) => {
    const mark = button.querySelector(':scope > .sync-mark')
    if (!mark) return null
    const style = getComputedStyle(mark)
    const image = style.maskImage && style.maskImage !== 'none' ? style.maskImage : style.webkitMaskImage
    const box = mark.getBoundingClientRect()
    return {
        first: button.firstElementChild === mark,
        hidden: mark.getAttribute('aria-hidden'),
        url: /^url\("(.+)"\)$/.exec(image || '')?.[1] ?? null,
        width: box.width,
        height: box.height,
    }
})

test('every Sync button shows the official Sync mark', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
        await routeHandfishLocal(page)
        await page.addInitScript(() => {
            // No Sync companion answers, so the dialog's action reads "Check again".
            window.__VISUALIZE_SYNC_TRANSPORT__ = {
                fetch: () => Promise.reject(new TypeError('Failed to fetch')),
                WebSocket: class { constructor() { throw new Error('Sync is not running') } },
                permissions: null,
            }
        })
        await page.goto('/')
        await page.waitForFunction(() => !!window.__visualize?.scenes,
            null, { timeout: 30_000 * SCALE })
        await page.click('#sync-output-open')
        await expect(page.locator('#sync-output-action')).toHaveText('Check again')
        // Measure once the dialog has finished opening.
        await page.locator('#sync-output-dialog').evaluate((dialog) => Promise.all(
            dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)))

        const urls = new Set()
        for (const selector of SYNC_BUTTONS) {
            const mark = await markOf(page, selector)
            expect(mark, `${selector} has a .sync-mark`).not.toBeNull()
            expect(mark.first, `${selector} shows the mark before its label`).toBe(true)
            expect(mark.hidden).toBe('true')
            expect(mark.url, `${selector} mask image`).toMatch(/\/css\/sync-mark\.svg$/)
            urls.add(mark.url)
        }
        // The open button and the dialog's action are on screen: the mark renders square.
        for (const selector of ['#sync-output-open', '#sync-output-action']) {
            const { width, height } = await markOf(page, selector)
            expect(width, `${selector} mark width`).toBeGreaterThan(0)
            expect(height).toBeCloseTo(width, 2)
        }

        for (const url of urls) {
            const response = await page.request.get(url)
            expect(response.status(), url).toBe(200)
            expect(response.headers()['content-type']).toContain('image/svg+xml')
            expect(await response.text()).toContain('data-sync-mark="overpass"')
        }
    } finally {
        await context.close()
    }
})
