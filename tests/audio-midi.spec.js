// SPDX-License-Identifier: MIT
/**
 * Audio + MIDI integration verification. Runs the full app once, then
 * exercises three scenarios against it:
 *
 *   1. post-permission: dropdown shows real device labels (Chrome fake
 *      mic flag short-circuits the permission gate). Picking one wires
 *      the Analyser to the fake stream and meters climb off zero.
 *
 *   2. pre-permission: enumerateDevices returns devices with empty
 *      deviceId+label. Pre-fix this collapsed every <option> onto
 *      value="" and silently suppressed the change event — the "device
 *      pick does nothing" bug. We monkey-patch listDevices to mimic
 *      that state and confirm the sentinel "Enable audio" entry appears
 *      and enables on click.
 *
 *   3. MIDI: with a fake MIDIAccess + a pre-seeded CC→crossfader
 *      assignment, sending a CC actually moves the crossfader.
 *
 * Single boot, single context: the shader bundle ships from a CDN and
 * cold-cache compiles in headless Chromium are slow and occasionally
 * race. One boot keeps the suite under 90s.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'

test.describe.configure({ timeout: 120_000, retries: 1 })

async function bootWithFakeMidi(browser) {
    const context = await browser.newContext()
    // Seed a learn assignment so CC ch0 cc50 drives the crossfader. We
    // could script the learn UI flow but that adds 2-3s and an extra
    // failure surface for no extra coverage of the dispatch path.
    await context.addInitScript(() => {
        localStorage.setItem(
            'visualize.midi.learn.v1',
            JSON.stringify({ crossfader: { ch: 0, cc: 50, min: 0, max: 127 } })
        )

        const inputs = new Map()
        const input = {
            id: 'fake-1',
            name: 'Fake MIDI Input',
            manufacturer: 'Test',
            state: 'connected',
            connection: 'closed',
            _listeners: [],
            addEventListener(type, listener) {
                this._listeners.push({ type, listener })
            },
            removeEventListener(type, listener) {
                this._listeners = this._listeners.filter(
                    l => !(l.type === type && l.listener === listener))
            },
            open() { this.connection = 'open' },
        }
        inputs.set(input.id, input)
        window.__fakeMidi = { input, inputs }

        navigator.requestMIDIAccess = async function () {
            return { inputs, outputs: new Map(), onstatechange: null }
        }
    })

    const page = await context.newPage()
    await routeHandfishLocal(page)
    await page.goto('/')
    await page.click('#boot-start')
    // Audio/MIDI is wired up before the initial library random-load
    // kicks off, so we only need __visualize exposed — we don't have
    // to wait for the (slower, CDN-bound) shader compile path.
    await page.waitForFunction(() =>
        !!window.__visualize?.audio && !!window.__visualize?.midi,
        null, { timeout: 30_000 })

    return { context, page }
}

test('audio + MIDI: end-to-end verification', async ({ browser }) => {
    const { context, page } = await bootWithFakeMidi(browser)

    // ─── Scenario 1: post-permission audio ──────────────────────────────
    await page.click('#settings-toggle')
    // <select-dropdown> exposes getOptions() instead of .options.
    await page.waitForFunction(() => {
        const sel = document.getElementById('audio-device')
        return sel?.getOptions && sel.getOptions().length >= 2
    }, null, { timeout: 15_000 })

    const dropdownPost = await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        return sel.getOptions()
    })
    expect(dropdownPost[0].value).toBe('')
    // First real device must have a non-empty value, otherwise picking
    // it doesn't fire 'change' (the bug we're regression-testing).
    expect(dropdownPost[1].value).not.toBe('')
    expect(dropdownPost[1].value).not.toBe('__default__')

    // Pick "Fake Default Audio Input" specifically — the other fake
    // inputs the chromium flag exposes don't always produce signal in
    // headless mode.
    await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        const opts = sel.getOptions()
        const target = opts.find(o => o.value === 'default') || opts[1]
        sel.value = target.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Chrome fake mic + smoothing = 0.8 takes ~1s to ramp off zero,
    // but the fake source's startup time is jittery in headless mode —
    // give it 20s. The actual prod path completes in well under a
    // second on a real mic.
    await page.waitForFunction(() => {
        const a = window.__visualize?.audio
        return a?.enabled
            && a?._audioContext?.state === 'running'
            && (a.meters.low > 0 || a.meters.mid > 0 || a.meters.high > 0)
    }, null, { timeout: 20_000 })

    const meters = await page.evaluate(() => ({ ...window.__visualize.audio.meters }))
    expect(meters.vol).toBeGreaterThan(0.1)

    const pillText = await page.textContent('#audio-status .status-text')
    expect(pillText).toMatch(/^audio: /)

    const lowWidth = await page.evaluate(() =>
        document.getElementById('meter-low').firstElementChild.style.width)
    expect(parseFloat(lowWidth)).toBeGreaterThan(0)

    // ─── Scenario 2: pre-permission dropdown ────────────────────────────
    // Disable audio and monkey-patch listDevices to mimic the no-perm
    // state Chrome shows on a first-time visit. Re-opening settings
    // re-renders the dropdown and should show the sentinel entry, not
    // a parade of empty <option value=""> items.
    await page.evaluate(() => window.__visualize.audio.disable())
    await page.evaluate(() => {
        const a = window.__visualize.audio
        a.listDevices = async () => [
            { kind: 'audioinput', deviceId: '', label: '', groupId: '' },
            { kind: 'audioinput', deviceId: '', label: '', groupId: '' },
            { kind: 'audioinput', deviceId: '', label: '', groupId: '' },
        ]
    })
    // Close and re-open settings to trigger refreshAudioDevices.
    await page.click('#settings-close')
    await page.click('#settings-toggle')
    await page.waitForFunction(() => {
        const sel = document.getElementById('audio-device')
        const opts = sel?.getOptions ? sel.getOptions() : []
        return opts.length === 2 && opts[1].value === '__default__'
    }, null, { timeout: 15_000 })

    const dropdownPre = await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        return sel.getOptions()
    })
    expect(dropdownPre).toHaveLength(2)
    expect(dropdownPre[1].value).toBe('__default__')
    expect(dropdownPre[1].text).toMatch(/enable/i)

    // Picking the sentinel must actually enable audio (it can't be
    // collapsed to value="" — the bug we're guarding against).
    // Restore real listDevices first so getUserMedia gets a real device.
    await page.evaluate(() => {
        const a = window.__visualize.audio
        delete a.listDevices
    })
    await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        sel.value = '__default__'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() =>
        window.__visualize?.audio?.enabled === true,
        null, { timeout: 10_000 })

    // ─── Scenario 3: MIDI CC dispatch ──────────────────────────────────
    await page.click('#midi-enable')
    await page.waitForFunction(() =>
        window.__visualize?.midi?.enabled === true
            && window.__visualize.midi.inputCount === 1,
        null, { timeout: 15_000 })

    // Start crossfader at zero so a CC of 100 moves it visibly.
    await page.evaluate(() => {
        const xf = document.getElementById('crossfader')
        xf.value = '0'
        xf.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Takeover: crossfader starts at 0 (armed). A CC near 0 "catches"
    // (engages pickup); a following CC of 100 then drives it.
    await page.evaluate(() => {
        const send = (v) => {
            const data = new Uint8Array([0xB0, 50, v])
            for (const { type, listener } of window.__fakeMidi.input._listeners) {
                if (type === 'midimessage') listener({ data })
            }
        }
        send(0)    // within eps of current 0 → engage
        send(100)  // engaged → drives crossfader
    })

    const xfade = await page.evaluate(() =>
        parseFloat(document.getElementById('crossfader').value))
    expect(xfade).toBeGreaterThan(0.7)
    expect(xfade).toBeLessThan(0.85)

    // Confirm CC also mirrored into each deck's midiState (audio-reactive
    // DSL programs read from there).
    const ccInDecks = await page.evaluate(() => {
        const decks = window.__visualize.decks
        const probe = (state) => {
            if (!state) return null
            if (typeof state.getCc === 'function') return state.getCc(0, 50)
            const channels = state._channels || state.channels
            if (!channels) return null
            const ch = channels[0] || channels['0']
            const bag = ch?._cc || ch?.cc
            return bag?.[50] ?? null
        }
        return {
            A: probe(decks.A.ensureMidiState()),
            B: probe(decks.B.ensureMidiState()),
        }
    })
    if (ccInDecks.A != null) expect(ccInDecks.A).toBeCloseTo(100 / 127, 2)
    if (ccInDecks.B != null) expect(ccInDecks.B).toBeCloseTo(100 / 127, 2)

    // FX latch via Note-On: seed a note binding for invert, then a
    // Note-On toggles it exactly once; Note-Off does not toggle back.
    await page.evaluate(() => {
        window.__visualize.midi._assignments.fxInvert = { kind: 'note', ch: 0, note: 36, min: 0, max: 127, invert: false }
    })
    const before = await page.evaluate(() => !!window.__visualize.compositor.invert)
    await page.evaluate(() => {
        const send = (status, d1, d2) => {
            const data = new Uint8Array([status, d1, d2])
            for (const { type, listener } of window.__fakeMidi.input._listeners) {
                if (type === 'midimessage') listener({ data })
            }
        }
        send(0x90, 36, 100) // Note-On  → toggle once
        send(0x80, 36, 0)   // Note-Off → no toggle
    })
    const after = await page.evaluate(() => !!window.__visualize.compositor.invert)
    expect(after).toBe(!before)

    // Two controls on the same CC → getLearnView marks both conflicting.
    const conflicts = await page.evaluate(() => {
        const midi = window.__visualize.midi
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127, invert: false }
        midi._assignments.speedA = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127, invert: false }
        const view = midi.getLearnView()
        const find = (id) => view.find(r => r.controlId === id)
        return { xf: !!find('crossfader').conflict, spd: !!find('speedA').conflict }
    })
    expect(conflicts.xf).toBe(true)
    expect(conflicts.spd).toBe(true)

    // Live bar: sending a CC updates the ml-bar-fill width in the DOM.
    // Re-establish a clean single crossfader assignment (no conflict), set
    // crossfader to 0 so pickup arms, then send CC 0 to catch and CC 100
    // to engage and drive. The learn row must reflect ~79 % width.
    await page.evaluate(() => {
        const midi = window.__visualize.midi
        delete midi._assignments.speedA   // remove the conflict introduced above
        midi._assignments.crossfader = { kind: 'cc', ch: 0, cc: 50, min: 0, max: 127, invert: false }
        // Reset runtime so arm fires fresh
        midi._controlRuntime?.delete?.('crossfader')
        // Reset crossfader to 0 so pickup has to catch
        const xf = document.getElementById('crossfader')
        if (xf) {
            xf.value = 0
            xf.dispatchEvent(new Event('input', { bubbles: true }))
        }
    })
    await page.evaluate(() => {
        const send = (d1, d2) => {
            const data = new Uint8Array([0xB0, d1, d2])
            for (const { type, listener } of window.__fakeMidi.input._listeners) {
                if (type === 'midimessage') listener({ data })
            }
        }
        send(50, 0)    // CC 50 value 0 → catch at bottom (engages pickup)
        send(50, 100)  // CC 50 = 100 → engaged, drives crossfader to ~79 %
    })
    // Allow rAF to flush the DOM update
    await page.waitForTimeout(100)
    const barWidth = await page.evaluate(() => {
        const row = document.querySelector('#midi-learn-rows .midi-learn-row')
        if (!row) return null
        // Walk rows to find the crossfader row by label text
        const rows = document.querySelectorAll('#midi-learn-rows .midi-learn-row')
        for (const r of rows) {
            if (r.querySelector('.ml-target')?.textContent?.toLowerCase().includes('crossfader') ||
                r.querySelector('.ml-target')?.textContent?.toLowerCase().includes('cross')) {
                return r.querySelector('.ml-bar-fill')?.style?.width || null
            }
        }
        // fallback: first row's fill
        return rows[0]?.querySelector('.ml-bar-fill')?.style?.width || null
    })
    expect(barWidth).not.toBeNull()
    expect(parseFloat(barWidth)).toBeGreaterThan(60)

    await context.close()
})
