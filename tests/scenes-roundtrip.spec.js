// SPDX-License-Identifier: MIT
/**
 * DIAGNOSTIC: scene save → reload-app-state → recall round-trip.
 *
 * The user reports: "loaded scenes do not fully resemble the programs
 * they were saved from." This spec drives the actual app paths
 * (Scenes.snapshot + Scenes.apply via window.__visualize.takeSnapshot
 * / applySnapshot) and reports every field that diverges between
 * captured state and post-recall state.
 *
 * It's intentionally pure-observation: prints a diff but doesn't
 * assert specific values until we know which field is wrong.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'

test.describe.configure({ timeout: 120_000, retries: 0 })

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await routeHandfishLocal(page)
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.takeSnapshot, null, { timeout: 30_000 })
    return { context, page }
}

async function loadProgramByTitle(page, deckId, title) {
    await page.evaluate(async ({ id, t }) => {
        const resp = await fetch('data/programs.json', { cache: 'no-cache' })
        const programs = await resp.json()
        const p = programs.find(x => x.title === t)
        if (!p) throw new Error(`no program titled ${t}`)
        const r = await window.__visualize.decks[id].load(p.dsl, p.title)
        if (!r.success) throw new Error(`load failed: ${r.error}`)
    }, { id: deckId, t: title })
}

/** Capture every field we'd want round-tripped. */
async function captureLiveState(page) {
    return page.evaluate(() => {
        const decks = window.__visualize.decks
        const state = window.__visualize.state
        return {
            A: {
                currentDsl: decks.A._currentDsl,
                currentName: decks.A.currentName,
                speed: decks.A._speed,
                pixelDensity: decks.A.pixelDensity,
                densityMode: state.deckDensity.A.mode,
                rebindOriginal: decks.A.rebind.originalDsl,
                rebindBandpass: decks.A.rebind.bandpass,
                rebindOverrides: JSON.parse(JSON.stringify(decks.A.rebind.overrides))
            },
            B: {
                currentDsl: decks.B._currentDsl,
                currentName: decks.B.currentName,
                speed: decks.B._speed,
                pixelDensity: decks.B.pixelDensity,
                densityMode: state.deckDensity.B.mode,
                rebindOriginal: decks.B.rebind.originalDsl,
                rebindBandpass: decks.B.rebind.bandpass,
                rebindOverrides: JSON.parse(JSON.stringify(decks.B.rebind.overrides))
            },
            xfade: state.crossfade,
            curve: state.curve
        }
    })
}

function diffStates(before, after, label) {
    const lines = []
    const cmp = (path, a, b) => {
        const aj = JSON.stringify(a)
        const bj = JSON.stringify(b)
        if (aj !== bj) {
            lines.push(`  ${path}:`)
            lines.push(`    saved:    ${aj?.slice(0, 200)}`)
            lines.push(`    recalled: ${bj?.slice(0, 200)}`)
        }
    }
    for (const id of ['A', 'B']) {
        cmp(`decks.${id}.currentDsl`, before[id].currentDsl, after[id].currentDsl)
        cmp(`decks.${id}.currentName`, before[id].currentName, after[id].currentName)
        cmp(`decks.${id}.speed`, before[id].speed, after[id].speed)
        cmp(`decks.${id}.pixelDensity`, before[id].pixelDensity, after[id].pixelDensity)
        cmp(`decks.${id}.densityMode`, before[id].densityMode, after[id].densityMode)
        cmp(`decks.${id}.rebindOriginal`, before[id].rebindOriginal, after[id].rebindOriginal)
        cmp(`decks.${id}.rebindBandpass`, before[id].rebindBandpass, after[id].rebindBandpass)
        cmp(`decks.${id}.rebindOverrides`, before[id].rebindOverrides, after[id].rebindOverrides)
    }
    cmp('xfade', before.xfade, after.xfade)
    cmp('curve', before.curve, after.curve)
    if (lines.length === 0) return `[${label}] CLEAN — no divergence`
    return `[${label}] DIVERGENCE:\n` + lines.join('\n')
}

test('scenes round-trip: vanilla load, no rebind', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // Set up: deck A = Bass Bloom, deck B = Mid Mirror
        await loadProgramByTitle(page, 'A', 'Bass Bloom')
        await loadProgramByTitle(page, 'B', 'Mid Mirror')
        // Mutate some misc state
        await page.evaluate(() => {
            window.__visualize.decks.A.setSpeed(1.5)
            window.__visualize.decks.B.setSpeed(0.7)
            window.__visualize.state.crossfade = 0.25
        })

        const saved = await captureLiveState(page)
        const snap = await page.evaluate(() => window.__visualize.takeSnapshot())

        // Disturb state: load different programs + change xfade
        await loadProgramByTitle(page, 'A', 'Full Spectrum')
        await loadProgramByTitle(page, 'B', 'Full Spectrum')
        await page.evaluate(() => {
            window.__visualize.decks.A.setSpeed(0.5)
            window.__visualize.decks.B.setSpeed(2.0)
            window.__visualize.state.crossfade = 0.8
        })

        // Recall
        await page.evaluate(async (s) => {
            await window.__visualize.applySnapshot(s)
        }, snap)

        const after = await captureLiveState(page)
        const diff = diffStates(saved, after, 'no-rebind')
        console.log(diff)
        expect(diff).toContain('CLEAN')
    } finally {
        await context.close()
    }
})

test('scenes round-trip: with rebind active on deck A', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        await loadProgramByTitle(page, 'A', 'Bass Bloom')
        await loadProgramByTitle(page, 'B', 'Mid Mirror')
        // Roll a rebind on deck A
        await page.evaluate(async () => {
            const resp = await fetch('data/programs.json', { cache: 'no-cache' })
            const programs = await resp.json()
            const p = programs.find(x => x.title === 'Bass Bloom')
            await window.__visualize.rebind.rebindEq(window.__visualize.decks.A, p)
        })

        const saved = await captureLiveState(page)
        const snap = await page.evaluate(() => window.__visualize.takeSnapshot())

        // Disturb
        await loadProgramByTitle(page, 'A', 'Full Spectrum')
        await loadProgramByTitle(page, 'B', 'Full Spectrum')

        // Recall
        await page.evaluate(async (s) => {
            await window.__visualize.applySnapshot(s)
        }, snap)

        const after = await captureLiveState(page)
        const diff = diffStates(saved, after, 'rebind-active')
        console.log(diff)
        expect(diff).toContain('CLEAN')
    } finally {
        await context.close()
    }
})

test('editor updates when rebindEq fires', async ({ browser }) => {
    // Bug repro: user opens deck editor, hits rebind EQ; the editor
    // should refresh with the regenerated DSL (audio() automations on
    // new params) instead of staying on the pristine DSL.
    const { context, page } = await boot(browser)
    try {
        await loadProgramByTitle(page, 'A', 'Bass Bloom')
        // Open the deck A editor
        await page.click('.deck.deck-a .deck-edit-toggle')
        await page.waitForFunction(() =>
            !document.querySelector('.deck.deck-a .deck-editor')?.hidden,
            null, { timeout: 5_000 })

        const beforeEditor = await page.locator('.deck.deck-a code-editor').evaluate(el => el.value)
        expect(beforeEditor).toContain('search')

        // Fire rebind EQ via the button (matches the real UX)
        await page.click('.deck.deck-a .deck-rebind-eq')
        // Allow the await chain in the click handler to complete
        await page.waitForTimeout(300)

        const afterEditor = await page.locator('.deck.deck-a code-editor').evaluate(el => el.value)
        // After rebind the editor should show the regenerated DSL,
        // which differs from the pristine in at least one place.
        expect(afterEditor).not.toBe(beforeEditor)
        // And it should match the deck's actual current DSL.
        const currentDsl = await page.evaluate(() => window.__visualize.decks.A._currentDsl)
        expect(afterEditor).toBe(currentDsl)
    } finally {
        await context.close()
    }
})

test('scenes round-trip: mixer effect and pixel density survive', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        await loadProgramByTitle(page, 'A', 'Bass Bloom')
        await loadProgramByTitle(page, 'B', 'Mid Mirror')

        // Wait for the mixer to come online (asynchronously initialized
        // in boot). The takeSnapshot helper already exists; we use the
        // window.__visualize hook to discover when the mixer is ready
        // via the picker being populated. The picker is now a
        // <select-dropdown>, which exposes getOptions() instead of
        // .options.
        await page.waitForFunction(() => {
            const sel = document.getElementById('mixer-effect')
            return sel && typeof sel.getOptions === 'function' && sel.getOptions().length > 1
        }, null, { timeout: 30_000 })

        // Pick the second mixer effect (whatever it is) and manually
        // pin deck A to 50% density.
        const savedMixerId = await page.evaluate(() => {
            const sel = document.getElementById('mixer-effect')
            const opts = sel.getOptions()
            const candidate = opts.map(o => o.value).find(v => v !== sel.value)
            sel.value = candidate
            sel.dispatchEvent(new Event('change'))
            return candidate
        })
        await page.click('.deck.deck-a .deck-density')   // auto → manual 100%
        await page.click('.deck.deck-a .deck-density')   // manual 100 → 75
        await page.click('.deck.deck-a .deck-density')   // 75 → 50
        await page.waitForTimeout(500)
        const savedDensity = await page.evaluate(() => ({
            mode: window.__visualize.state.deckDensity.A.mode,
            value: window.__visualize.state.deckDensity.A.value
        }))

        const snap = await page.evaluate(() => window.__visualize.takeSnapshot())

        // Disturb: flip mixer back to the original, density back to auto
        await page.evaluate(async (origId) => {
            const sel = document.getElementById('mixer-effect')
            const opts = sel.getOptions()
            const other = opts.map(o => o.value).find(v => v !== origId)
            sel.value = other
            sel.dispatchEvent(new Event('change'))
        }, savedMixerId)
        // Density: cycle back to auto by clicking through the rest
        for (let i = 0; i < 5; i++) {
            await page.click('.deck.deck-a .deck-density')
        }
        await page.waitForTimeout(500)

        // Recall
        await page.evaluate(async (s) => {
            await window.__visualize.applySnapshot(s)
        }, snap)
        await page.waitForTimeout(800)

        const after = await page.evaluate(() => ({
            mixerId: window.__visualize.state ? document.getElementById('mixer-effect').value : null,
            density: {
                mode: window.__visualize.state.deckDensity.A.mode,
                value: window.__visualize.state.deckDensity.A.value
            }
        }))

        expect(after.mixerId).toBe(savedMixerId)
        expect(after.density.mode).toBe(savedDensity.mode)
        expect(after.density.value).toBeCloseTo(savedDensity.value, 5)
    } finally {
        await context.close()
    }
})

test('mixer enum control: shows the active choice + persists/restores it across reload', async ({ browser }) => {
    // Two regressions in one path:
    //  (1) enum dropdowns showed blank/first because the widget was set to
    //      the choice *name* while option values are stringified *numbers*;
    //  (2) controls-panel tweaks were never persisted (only the effect-
    //      switch persisted, after clearing overrides), so a reload lost them.
    const sel = '#mixer-controls .mixer-control-row[data-param-key="mode"] select-dropdown'
    const { context, page } = await boot(browser)
    try {
        // Default mixer is blend; wait for its `mode` enum row to render.
        await page.waitForFunction((q) => {
            const el = document.querySelector(q)
            return el && typeof el.getOptions === 'function' && el.getOptions().length > 1
        }, sel, { timeout: 30_000 })

        // (1) The dropdown must DISPLAY the active selection — its value
        //     must be a real option value (not the bare name) and resolve
        //     to the default 'mix'.
        const initial = await page.evaluate((q) => {
            const el = document.querySelector(q)
            const opts = el.getOptions()
            return {
                value: el.value,
                selectedText: opts.find(o => o.value === el.value)?.text ?? null,
                optionValues: opts.map(o => o.value)
            }
        }, sel)
        expect(initial.optionValues).toContain(initial.value)   // not the raw choice name
        expect(initial.selectedText).toBe('mix')

        // Change mode via the panel dropdown, like a user, then let the
        // 250ms persist debounce fire.
        const chosen = await page.evaluate((q) => {
            const el = document.querySelector(q)
            const opts = el.getOptions()
            const target = opts.find(o => o.text === 'add') || opts.find(o => o.value !== el.value)
            el.value = target.value
            el.dispatchEvent(new Event('change'))
            return target.text
        }, sel)
        // (2) The override is persisted as the choice NAME (existing schema).
        //     The write is debounced (~250ms) and can be delayed further by
        //     the concurrent mixer recompile, so poll rather than fixed-wait.
        await page.waitForFunction((expected) => {
            try {
                const m = JSON.parse(localStorage.getItem('visualize.mixer.v1') || 'null')
                return m?.overrides?.mode === expected
            } catch { return false }
        }, chosen, { timeout: 10_000 })
        const persisted = await page.evaluate(() => {
            try { return JSON.parse(localStorage.getItem('visualize.mixer.v1') || 'null') } catch { return null }
        })
        expect(persisted?.overrides?.mode).toBe(chosen)

        // Reload → boot-restore must rebuild the panel showing the restored
        // choice (exercises persistence + the name→value display mapping).
        await page.reload()
        await page.click('#boot-start')
        await page.waitForFunction(() => !!window.__visualize?.takeSnapshot, null, { timeout: 30_000 })
        await page.waitForFunction((q) => {
            const el = document.querySelector(q)
            return el && typeof el.getOptions === 'function' && el.getOptions().length > 1
        }, sel, { timeout: 30_000 })

        const restored = await page.evaluate((q) => {
            const el = document.querySelector(q)
            const opts = el.getOptions()
            return {
                value: el.value,
                selectedText: opts.find(o => o.value === el.value)?.text ?? null,
                optionValues: opts.map(o => o.value)
            }
        }, sel)
        expect(restored.optionValues).toContain(restored.value)
        expect(restored.selectedText).toBe(chosen)
    } finally {
        await context.close()
    }
})

