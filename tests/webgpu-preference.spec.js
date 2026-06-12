// SPDX-License-Identifier: MIT
/**
 * WebGPU preference is a startup hint to the Noisemaker renderer. It
 * must be restored before Deck instances are constructed, otherwise the
 * settings switch looks active but every deck still boots WebGL2-only.
 */
import { test, expect } from '@playwright/test'

const RENDERER_STORAGE_KEY = 'visualize.renderer.v1'

async function bootApp(page) {
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 30_000 })
}

test('restores WebGPU preference before deck construction, persists and survives reload', async ({ page }) => {
    // Seed only when absent: the init script re-runs on reload, and an
    // unconditional write would clobber what the app persisted below.
    await page.addInitScript((key) => {
        if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ preferWebGPU: true }))
        }
    }, RENDERER_STORAGE_KEY)

    await page.goto('/')
    await bootApp(page)

    const restored = await page.evaluate(() => ({
        state: window.__visualize.state.preferWebGPU,
        deckA: window.__visualize.decks.A.preferWebGPU,
        deckB: window.__visualize.decks.B.preferWebGPU,
        toggle: document.getElementById('prefer-webgpu').checked,
    }))
    expect(restored).toEqual({
        state: true,
        deckA: true,
        deckB: true,
        toggle: true,
    })

    // Flip it through the real control so the Handfish toggle's own
    // click-to-change path is exercised, not a synthetic event.
    await page.click('#settings-toggle')
    await page.click('#prefer-webgpu')

    const persisted = await page.evaluate((key) => ({
        state: window.__visualize.state.preferWebGPU,
        stored: JSON.parse(localStorage.getItem(key)),
    }), RENDERER_STORAGE_KEY)
    expect(persisted).toEqual({
        state: false,
        stored: { preferWebGPU: false },
    })

    await page.reload()
    await bootApp(page)

    const roundTrip = await page.evaluate(() => ({
        state: window.__visualize.state.preferWebGPU,
        toggle: document.getElementById('prefer-webgpu').checked,
    }))
    expect(roundTrip).toEqual({ state: false, toggle: false })
})

test('defaults to WebGL2 when no preference is stored', async ({ page }) => {
    await page.goto('/')
    await bootApp(page)

    const defaults = await page.evaluate((key) => ({
        state: window.__visualize.state.preferWebGPU,
        toggle: document.getElementById('prefer-webgpu').checked,
        stored: localStorage.getItem(key),
    }), RENDERER_STORAGE_KEY)
    expect(defaults).toEqual({ state: false, toggle: false, stored: null })
})
