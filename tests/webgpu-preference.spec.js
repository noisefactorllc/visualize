// SPDX-License-Identifier: MIT
/**
 * WebGPU preference is a startup hint to the Noisemaker renderer. It
 * must be restored before Deck instances are constructed, otherwise the
 * settings switch looks active but every deck still boots WebGL2-only.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

const RENDERER_STORAGE_KEY = 'visualize.renderer.v1'

// Serve the local handfish build (with <tempo-bar> + industrial.css) when
// HANDFISH_LOCAL is set; otherwise hit the real CDN. No machine path committed.
installHandfishLocal(test)

async function bootApp(page) {
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 30_000 * SCALE })
}

test('restores WebGPU preference before deck construction, persists and survives reload', async ({ page }) => {
    // Two full boots in one test (boot → reload → boot). Each boot fetches
    // the shader core + effects from the live CDN and compiles both decks,
    // so on a slow-CDN day the pair overruns the default 120s budget. Give
    // it headroom — this is the only spec that boots twice.
    test.slow()
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

test('settings surfaces the ACTIVE renderer and flags a silent WebGPU→WebGL2 fallback', async ({ page }) => {
    // Boot with WebGPU PREFERRED so the fallback-detection path runs.
    // Headless Chromium usually has no WebGPU, so the decks fall back to
    // WebGL2 — and the indicator must read WebGL2, NOT parrot the
    // preference. (The underlying bug this guards: renderer.backend
    // mirrors the preference flag, not the pipeline, so an indicator
    // wired to it would wrongly claim WebGPU here.) If the runner *does*
    // expose WebGPU, the indicator must read WebGPU with no warning.
    // Either way it must agree with the deck's real pipeline backend.
    await page.addInitScript((key) => {
        if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ preferWebGPU: true }))
        }
    }, RENDERER_STORAGE_KEY)

    await page.goto('/')
    await bootApp(page)
    // Wait for a compiled, running deck so activeBackend reads from the
    // live pipeline backend, not the pre-compile preference fallback.
    await page.waitForFunction(() => window.__visualize?.decks?.A?.isRunning,
        null, { timeout: 30_000 * SCALE })

    // Open settings — the indicator repaints on drawer open. Wait until
    // the placeholder is replaced so we read the resolved value.
    await page.click('#settings-toggle')
    await page.waitForFunction(() => {
        const t = document.getElementById('active-renderer')?.textContent || ''
        return t.includes('active:') && !t.includes('…')
    }, null, { timeout: 5_000 * SCALE })

    const info = await page.evaluate(() => ({
        active: window.__visualize.decks.A.activeBackend,
        requested: window.__visualize.decks.A.preferWebGPU,
        text: document.getElementById('active-renderer').textContent.trim(),
    }))

    // Parity: the label names the backend the pipeline actually built.
    const expectedLabel = info.active === 'webgpu' ? 'WebGPU' : 'WebGL2'
    expect(info.text).toContain(`active: ${expectedLabel}`)
    // Honest fallback: preferred WebGPU but got WebGL2 ⇒ show the flag;
    // otherwise never imply unavailability.
    if (info.requested && info.active !== 'webgpu') {
        expect(info.text).toContain('WebGPU unavailable')
    } else {
        expect(info.text).not.toContain('unavailable')
    }
})

test('the mixer output renderer honors the persisted renderer preference', async ({ page }) => {
    // Sync output, the compositor and the recorder all render from the
    // mixer's renderer, so the operator's "Prefer WebGPU renderer" control
    // must reach it too — not just the two decks. Regression: the mixer
    // constructor never received the preference and silently stayed WebGL2.
    await page.addInitScript((key) => {
        if (!localStorage.getItem(key)) {
            localStorage.setItem(key, JSON.stringify({ preferWebGPU: true }))
        }
    }, RENDERER_STORAGE_KEY)

    await page.goto('/')
    await bootApp(page)

    const mixerBackend = await page.evaluate(() => ({
        requested: window.__visualize.mixer.preferWebGPU,
        // Same normalization the decks expose for the requested flag.
        requestedViaRenderer: window.__visualize.mixer.renderer.backend === 'wgsl',
    }))
    expect(mixerBackend).toEqual({ requested: true, requestedViaRenderer: true })

    // After the mixer's pipeline compiles, the active backend must agree
    // with what actually runs: WebGPU where available, an honest WebGL2
    // fallback otherwise — never a silent third state.
    await page.waitForFunction(() => window.__visualize?.mixer?.ready,
        null, { timeout: 60_000 * SCALE })
    const active = await page.evaluate(() => window.__visualize.mixer.activeBackend)
    expect(['webgpu', 'webgl2']).toContain(active)
})
