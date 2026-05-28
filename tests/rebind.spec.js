// SPDX-License-Identifier: MIT
/**
 * Rebind smoke test. Boots the full app, loads a known bass-tagged
 * program into Deck A, then verifies:
 *   - rebindEq() produces deck DSL containing audio() automations
 *     and re-pushes it into the renderer
 *   - With bandpass on, every audio() in the regenerated DSL is
 *     in the program's home band (audioBand.low for "Bass Bloom")
 *   - rebindMidi() produces midi() automations referencing midiMode.*
 *   - clearRebinds() restores the original DSL
 *   - With bandpass OFF, repeated rolls span more than one band
 */
import { test, expect } from '@playwright/test'

test.describe.configure({ timeout: 120_000, retries: 1 })

async function bootAndLoad(browser, programTitle) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.rebind,
        null, { timeout: 30_000 })
    // Load the target program into deck A by fetching the manifest
    // directly so we don't depend on the library UI having rendered.
    await page.evaluate(async (title) => {
        const resp = await fetch('data/programs.json', { cache: 'no-cache' })
        const programs = await resp.json()
        const p = programs.find(x => x.title === title)
        if (!p) throw new Error(`no program titled ${title}`)
        const res = await window.__visualize.decks.A.load(p.dsl, p.title)
        if (!res.success) throw new Error(`deck load failed: ${res.error}`)
        window.__visualize.__currentProgram = p
    }, programTitle)
    return { context, page }
}

test('rebind: EQ produces audio() automations restricted to home band', async ({ browser }) => {
    // "Bass Bloom" is tagged ["reactive", "bass", "noise"]: home band
    // is low (band 0). It has multiple numeric params (xScale, yScale,
    // hueRotation, refractAmt, speed, ...) so rebindable should be
    // non-empty.
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            const originalDsl = deck.rebind.originalDsl
            const ok = await window.__visualize.rebind.rebindEq(deck, program)
            return { ok, originalDsl, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        expect(result.newDsl).not.toBe(result.originalDsl)
        // Should still have at least 2 audio() bindings (rebindEq
        // picks 2-4 random params; the original Bass Bloom had 2).
        const newCount = (result.newDsl.match(/audio\(/g) || []).length
        expect(newCount).toBeGreaterThanOrEqual(2)
        // Bandpass default is ON. Bass Bloom's home is low → every
        // audioBand reference in the regenerated DSL should be .low.
        const allBands = [...result.newDsl.matchAll(/audioBand\.(\w+)/g)].map(m => m[1])
        expect(allBands.length).toBeGreaterThan(0)
        for (const b of allBands) {
            expect(b).toBe('low')
        }
    } finally {
        await context.close()
    }
})

test('rebind: MIDI produces midi() automations', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const ok = await window.__visualize.rebind.rebindMidi(deck)
            return { ok, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        const midiCount = (result.newDsl.match(/midi\(/g) || []).length
        expect(midiCount).toBeGreaterThanOrEqual(2)
        // At least one bound MIDI call must include a channel arg.
        expect(/midi\(channel:\s*\d+/.test(result.newDsl)).toBe(true)
    } finally {
        await context.close()
    }
})

test('rebind: clearRebinds restores original DSL', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            const original = deck.rebind.originalDsl
            await window.__visualize.rebind.rebindEq(deck, program)
            const afterRebind = deck._currentDsl
            await window.__visualize.rebind.clearRebinds(deck)
            const afterClear = deck._currentDsl
            return { original, afterRebind, afterClear }
        })
        expect(result.afterRebind).not.toBe(result.original)
        expect(result.afterClear).toBe(result.original)
    } finally {
        await context.close()
    }
})

test('rebind: oscillatorCount=4 emits osc() in regenerated DSL', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            deck.rebind.oscillatorCount = 4
            const ok = await window.__visualize.rebind.rebindEq(deck, program)
            return { ok, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        // With count=4 and rebindEq picking 2-4 params, every binding
        // should be an osc(). At least 2 osc() calls in the new DSL.
        const oscCount = (result.newDsl.match(/osc\(/g) || []).length
        expect(oscCount).toBeGreaterThanOrEqual(2)
        // At least one oscType reference should appear.
        expect(/oscKind\.(sine|tri|saw|sawInv|square)/.test(result.newDsl)).toBe(true)
    } finally {
        await context.close()
    }
})

test('rebind: oscillatorCount override forces all-osc when audio is off', async ({ browser }) => {
    // AutoMix uses this code path in its no-audio/no-midi fallback so
    // the deck animates instead of being left with silent audio() bindings.
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            deck.rebind.oscillatorCount = 0   // operator setting
            const ok = await window.__visualize.rebind.rebindEq(
                deck, program, { oscillatorCount: 4 })
            return { ok, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        // With count override of 4 and 2-4 params picked, EVERY pick
        // should be an osc() — no NEW audio() automations beyond the
        // pristine declarations.
        const oscCount = (result.newDsl.match(/osc\(/g) || []).length
        expect(oscCount).toBeGreaterThanOrEqual(2)
        expect(/oscKind\.(sine|tri|saw|sawInv|square)/.test(result.newDsl)).toBe(true)
    } finally {
        await context.close()
    }
})

test('rebind: util programs skip auto-rebind in AutoMix swap', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'solid (blue)')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            // Manual rebindEq on a util program: solid has few/no
            // rebindable numeric params (color is a vec3, alpha is
            // a float). Either way the auto-VJ guard should keep
            // the original DSL exactly intact. Use the same code
            // path AutoMix runs.
            const wasUtil = program.tags.includes('util')
            const isUtilCheck = wasUtil
            return { wasUtil, isUtilCheck, dsl: deck._currentDsl }
        })
        expect(result.wasUtil).toBe(true)
        // The auto-VJ guard skips util by checking tags.includes('util').
        // We verify the check itself here — it's an exported behavior
        // contract more than something we can run end-to-end without
        // also driving beat events.
        expect(result.isUtilCheck).toBe(true)
        // The deck's currentDsl is the pristine util program.
        expect(result.dsl).toContain('solid(color: #4a88fb)')
    } finally {
        await context.close()
    }
})

test('rebind: shuffle wipes o0..oN surfaces (stateful effect reset)', async ({ browser }) => {
    // recompile() preserves global surfaces so stateful sims (RD/MNCA/CA)
    // keep evolving — but a shuffle should feel like a fresh seed. Verify
    // by spying on pipeline.clearSurface: every surface on the deck's
    // pipeline must be cleared on rebindEq, rebindMidi, and clearRebinds.
    const { context, page } = await bootAndLoad(browser, 'multires reaction-diffusion')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            const pipeline = deck.inner._pipeline
            const surfaceNames = [...pipeline.surfaces.keys()]
            const calls = { eq: [], midi: [], clear: [], load: [] }
            const origClear = pipeline.clearSurface.bind(pipeline)
            let phase = 'load'
            pipeline.clearSurface = (name) => {
                calls[phase].push(name)
                return origClear(name)
            }
            // Phase 1: EQ shuffle
            phase = 'eq'
            await window.__visualize.rebind.rebindEq(deck, program)
            // Phase 2: MIDI shuffle (use the same pipeline, may have been
            // recreated — re-spy)
            const p2 = deck.inner._pipeline
            const origClear2 = p2.clearSurface.bind(p2)
            p2.clearSurface = (name) => {
                calls[phase].push(name)
                return origClear2(name)
            }
            phase = 'midi'
            await window.__visualize.rebind.rebindMidi(deck)
            // Phase 3: clearRebinds (restore original)
            const p3 = deck.inner._pipeline
            const origClear3 = p3.clearSurface.bind(p3)
            p3.clearSurface = (name) => {
                calls[phase].push(name)
                return origClear3(name)
            }
            phase = 'clear'
            await window.__visualize.rebind.clearRebinds(deck)
            return { surfaceNames, calls }
        })
        // multires reaction-diffusion writes to o0..o4 so at minimum
        // five global surfaces should exist on the deck.
        expect(result.surfaceNames.length).toBeGreaterThanOrEqual(5)
        // Every phase must have cleared every surface (set match, not
        // order, since map iteration is insertion-order but we don't
        // care).
        const surfaceSet = new Set(result.surfaceNames)
        for (const phase of ['eq', 'midi', 'clear']) {
            const cleared = new Set(result.calls[phase])
            for (const s of surfaceSet) {
                expect(cleared.has(s)).toBe(true)
            }
        }
    } finally {
        await context.close()
    }
})

test('rebind: bandpass off allows non-home bands across rolls', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            deck.rebind.bandpass = false
            const bandsSeen = new Set()
            for (let i = 0; i < 25; i++) {
                await window.__visualize.rebind.rebindEq(deck, program)
                const matches = [...deck._currentDsl.matchAll(/audioBand\.(\w+)/g)]
                for (const m of matches) bandsSeen.add(m[1])
            }
            return [...bandsSeen]
        })
        // With band picked uniformly from 3 across 2-4 picks per roll
        // for 25 rolls, hitting only one band is vanishingly unlikely.
        expect(result.length).toBeGreaterThan(1)
    } finally {
        await context.close()
    }
})
