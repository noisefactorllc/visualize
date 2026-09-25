// SPDX-License-Identifier: MIT
// Node-level unit tests (no browser page) for SharedMidi pure helpers.
import { test, expect } from '@playwright/test'
import {
    normalizeCcValue, computeEdgeToggle, computePickup, findConflicts
} from '../js/midi.js'

test('normalizeCcValue: scales raw into 0..1 across [min,max]', () => {
    expect(normalizeCcValue(0, 0, 127, false)).toBeCloseTo(0, 5)
    expect(normalizeCcValue(127, 0, 127, false)).toBeCloseTo(1, 5)
    expect(normalizeCcValue(64, 0, 127, false)).toBeCloseTo(64 / 127, 5)
})

test('normalizeCcValue: sub-range maps min→0, max→1 and clamps outside', () => {
    expect(normalizeCcValue(40, 40, 80, false)).toBeCloseTo(0, 5)
    expect(normalizeCcValue(80, 40, 80, false)).toBeCloseTo(1, 5)
    expect(normalizeCcValue(20, 40, 80, false)).toBeCloseTo(0, 5) // clamped
    expect(normalizeCcValue(120, 40, 80, false)).toBeCloseTo(1, 5) // clamped
})

test('normalizeCcValue: invert mirrors the result', () => {
    expect(normalizeCcValue(0, 0, 127, true)).toBeCloseTo(1, 5)
    expect(normalizeCcValue(127, 0, 127, true)).toBeCloseTo(0, 5)
})

test('normalizeCcValue: min===max never divides by zero', () => {
    const v = normalizeCcValue(64, 50, 50, false)
    expect(Number.isFinite(v)).toBe(true)
})

test('computeEdgeToggle: fires only on the rising (off→on) edge', () => {
    expect(computeEdgeToggle(false, true)).toEqual({ fire: true, nextOn: true })
    expect(computeEdgeToggle(true, true)).toEqual({ fire: false, nextOn: true })  // held high
    expect(computeEdgeToggle(true, false)).toEqual({ fire: false, nextOn: false }) // release
    expect(computeEdgeToggle(false, false)).toEqual({ fire: false, nextOn: false })
})

test('computePickup: engaged passes the value straight through', () => {
    const r = computePickup({ engaged: true, armSide: null, incoming: 0.8, current: 0.1, eps: 0.02 })
    expect(r).toEqual({ engaged: true, apply: true, value: 0.8, armSide: null })
})

test('computePickup: within eps of current catches immediately', () => {
    const r = computePickup({ engaged: false, armSide: null, incoming: 0.105, current: 0.1, eps: 0.02 })
    expect(r.engaged).toBe(true)
    expect(r.apply).toBe(true)
})

test('computePickup: first armed message records side, does not apply', () => {
    const r = computePickup({ engaged: false, armSide: null, incoming: 0.8, current: 0.1, eps: 0.02 })
    expect(r).toEqual({ engaged: false, apply: false, value: null, armSide: 1 })
})

test('computePickup: chasing on the same side keeps not applying', () => {
    const r = computePickup({ engaged: false, armSide: 1, incoming: 0.6, current: 0.1, eps: 0.02 })
    expect(r.apply).toBe(false)
    expect(r.engaged).toBe(false)
})

test('computePickup: crossing to the other side engages and applies', () => {
    // armed above (armSide 1); fader swept down past current → catch
    const r = computePickup({ engaged: false, armSide: 1, incoming: 0.05, current: 0.1, eps: 0.02 })
    expect(r.engaged).toBe(true)
    expect(r.apply).toBe(true)
    expect(r.value).toBeCloseTo(0.05, 5)
})

test('findConflicts: flags controls sharing a CC on the same channel', () => {
    const c = findConflicts({
        crossfader: { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 },
        fxInvert:   { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 },
        speedA:     { kind: 'cc', ch: 0, cc: 12, min: 0, max: 127 },
    })
    expect(c.crossfader.others).toEqual(['fxInvert'])
    expect(c.fxInvert.others).toEqual(['crossfader'])
    expect(c.speedA).toBeUndefined()
})

test('findConflicts: cc and note with the same number do NOT collide', () => {
    const c = findConflicts({
        a: { kind: 'cc', ch: 0, cc: 36, min: 0, max: 127 },
        b: { kind: 'note', ch: 0, note: 36, min: 0, max: 127 },
    })
    expect(c.a).toBeUndefined()
    expect(c.b).toBeUndefined()
})

test('findConflicts: legacy assignment with no kind is treated as cc', () => {
    const c = findConflicts({
        a: { ch: 1, cc: 7, min: 0, max: 127 },
        b: { kind: 'cc', ch: 1, cc: 7, min: 0, max: 127 },
    })
    expect(c.a.others).toEqual(['b'])
    expect(c.a.key).toBe('cc:1:7')
    expect(c.a.ch).toBe(1)
    expect(c.a.num).toBe(7)
})

test('findConflicts: channel isolation ensures identical CC numbers on different channels do not collide', () => {
    const c = findConflicts({
        crossfader: { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 },
        speedA:     { kind: 'cc', ch: 1, cc: 50, min: 0, max: 127 },
        speedB:     { kind: 'cc', ch: 2, cc: 50, min: 0, max: 127 },
    })
    expect(c.crossfader).toBeUndefined()
    expect(c.speedA).toBeUndefined()
    expect(c.speedB).toBeUndefined()
})

test('browser: MIDI learn drawer highlights CC conflict and resolves via channel edit', async ({ browser }) => {
    const context = await browser.newContext()
    await context.addInitScript(() => {
        localStorage.setItem(
            'visualize.midi.learn.v1',
            JSON.stringify({
                crossfader: { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 },
                speedA: { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127 }
            })
        )
    })

    const page = await context.newPage()
    await page.goto('/')
    await page.click('#boot-start')

    // Wait for boot to finish initializing
    await page.waitForFunction(() => !!window.__visualize?.midi)

    // Open settings drawer
    await page.click('#settings-toggle')
    const conflictsBanner = page.locator('#midi-learn-conflicts')

    // Conflict banner should be populated and visible
    await expect(conflictsBanner).toBeVisible()
    await expect(conflictsBanner).toContainText('2 assignments conflict on CC/channel')
    expect(await conflictsBanner.getAttribute('data-count')).toBe('2')

    // Both conflicting rows should be marked with .conflict and aria-invalid="true"
    const conflictRows = page.locator('.midi-learn-row.conflict')
    await expect(conflictRows).toHaveCount(2)
    const invalidRows = page.locator('.midi-learn-row[aria-invalid="true"]')
    await expect(invalidRows).toHaveCount(2)

    // Conflict badge should be rendered with warning sign and role="img"
    const badge = conflictRows.first().locator('.ml-conflict')
    await expect(badge).toHaveText('⚠')
    expect(await badge.getAttribute('role')).toBe('img')
    expect(await badge.getAttribute('aria-label')).toContain('Conflict: shares CC 50 · ch 1')

    // Open edit panel on the second row (speedA)
    const editBtn = page.locator('.midi-learn-row').filter({ hasText: 'speed A' }).locator('.ml-btn-edit')
    await editBtn.click()

    // Find channel input for speedA and change it from 1 to 2
    const chInput = page.locator('input[type="number"][aria-label="speed A ch"]')
    await expect(chInput).toBeVisible()
    await chInput.fill('2')
    await chInput.dispatchEvent('change')

    // Conflict should immediately clear!
    await expect(conflictsBanner).toBeEmpty()
    await expect(page.locator('.midi-learn-row.conflict')).toHaveCount(0)
    await expect(page.locator('.midi-learn-row[aria-invalid="true"]')).toHaveCount(0)

    await context.close()
})
