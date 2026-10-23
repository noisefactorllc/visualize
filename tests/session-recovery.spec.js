import { routeLegacyPrograms } from './legacyPrograms.js'
// SPDX-License-Identifier: MIT
/**
 * Session recovery — the live working set survives a reload.
 *
 * Regression spec for the silent state loss: a reload used to drop both
 * deck programs, the crossfader position, per-deck speeds and every main
 * FX back to boot defaults (random pair, xfade 0, FX off) with no
 * warning. The app now persists a snapshot of the live set continuously
 * and re-applies it when the app boots after a reload.
 *
 * Drives the real UI paths: a library card's deck-A load button, the
 * crossfader input, an FX toggle — then reloads and asserts the same
 * program, crossfader value and FX state come back.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

const WORKING_SET_KEY = 'visualize.workingSet.v1'
const PROGRAM_TITLE = 'Color Flow'

test.describe.configure({ mode: 'serial', retries: 1 })

// Serve the local handfish build (with <tempo-bar> + industrial.css) when
// HANDFISH_LOCAL is set; otherwise hit the real CDN. No machine path committed.
installHandfishLocal(test)

test('the live set is restored after a reload', async ({ page }) => {
    test.slow()
    const consoleMessages = []
    const pageErrors = []
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleMessages.push(`[${msg.type()}] ${msg.text()}`)
    })
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await routeLegacyPrograms(page)
    await page.goto('/')

    // Wait until both decks have a program loaded
    await page.waitForFunction(() => {
        const a = document.getElementById('deck-a-name')?.textContent
        const b = document.getElementById('deck-b-name')?.textContent
        return a && a !== '—' && b && b !== '—'
    }, { timeout: 30_000 * SCALE })

    // Load a known program into deck A via the library card's real
    // deck-A load button.
    await page.locator(`.program-card[data-title="${PROGRAM_TITLE}"] .pc-load[data-deck="A"]`).click()
    await expect(page.locator('#deck-a-name')).toHaveText(PROGRAM_TITLE, { timeout: 30_000 * SCALE })

    // Set the crossfader to a non-zero value through a real input event.
    await page.evaluate(() => {
        const s = document.getElementById('crossfader')
        s.value = '0.7'
        s.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Toggle a main FX through its real button.
    await page.click('.fx-button[data-fx="invert"]')
    await expect(page.locator('#main-canvas')).toHaveClass(/invert/, { timeout: 5_000 * SCALE })

    // The working set must actually be persisted — the silent-loss
    // reproduction stored nothing at all. Wait for the debounced save to
    // capture exactly the state built above.
    await page.waitForFunction(({ key, title }) => {
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null')
            return !!saved
                && saved.decks?.A?.title === title
                && typeof saved.decks?.A?.dsl === 'string'
                && saved.decks.A.dsl.length > 0
                && saved.xfade === 0.7
                && saved.fx?.invert === true
        } catch {
            return false
        }
    }, { key: WORKING_SET_KEY, title: PROGRAM_TITLE }, { timeout: 20_000 * SCALE })

    // ── Reload ───────────────────────────────────────────────────────────
    await page.reload()

    // No boot card on a desktop screen: boot re-applies the saved set
    // instead of a random pair without any click.
    await expect(page.locator('#boot-overlay')).toBeHidden()

    // Deck A compiles its restored program and shows its saved title.
    await expect(page.locator('#deck-a-name')).toHaveText(PROGRAM_TITLE, { timeout: 30_000 * SCALE })

    // Crossfader and FX state came back with it.
    const restored = await page.evaluate(() => ({
        xfade: parseFloat(document.getElementById('crossfader').value),
        invert: document.getElementById('main-canvas').classList.contains('invert')
    }))
    expect(restored.xfade).toBeCloseTo(0.7, 5)
    expect(restored.invert).toBe(true)

    // No page errors and no console.error()s the whole time.
    expect(pageErrors).toEqual([])
    const unexpectedErrors = consoleMessages.filter(m =>
        !m.includes('GPU stall') && !m.includes('willReadFrequently'))
    expect(unexpectedErrors, unexpectedErrors.join('\n')).toEqual([])
})

test('the main resolution survives a reload', async ({ page }) => {
    test.slow()
    const booted = () => page.waitForFunction(() => !!window.__visualize?.scenes,
        null, { timeout: 30_000 * SCALE })
    const output = () => page.evaluate(() => {
        const canvas = document.getElementById('main-canvas')
        return {
            dropdown: document.getElementById('main-resolution').value,
            canvas: `${canvas.width}x${canvas.height}`,
            label: document.getElementById('main-res').textContent,
        }
    })

    await routeLegacyPrograms(page)
    await page.goto('/')
    await booted()
    expect(await output()).toEqual({ dropdown: '1280x720', canvas: '1280x720', label: '1280×720' })

    // Pick a non-default resolution through the real settings dropdown.
    await page.click('#settings-toggle')
    await page.click('#main-resolution .select-trigger')
    await page.getByRole('option', { name: '1920×1080 (full HD)' }).click()
    await expect.poll(output).toEqual({ dropdown: '1920x1080', canvas: '1920x1080', label: '1920×1080' })

    await page.reload()
    await booted()
    expect(await output()).toEqual({ dropdown: '1920x1080', canvas: '1920x1080', label: '1920×1080' })
})
