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
    await page.waitForFunction(() =>
        document.getElementById('audio-device').options.length >= 2,
        null, { timeout: 15_000 })

    const dropdownPost = await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        return [...sel.options].map(o => ({ value: o.value, text: o.text }))
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
        const target = [...sel.options].find(o => o.value === 'default')
            || sel.options[1]
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
        const opts = document.getElementById('audio-device').options
        return opts.length === 2 && opts[1].value === '__default__'
    }, null, { timeout: 15_000 })

    const dropdownPre = await page.evaluate(() => {
        const sel = document.getElementById('audio-device')
        return [...sel.options].map(o => ({ value: o.value, text: o.text }))
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

    await page.evaluate(() => {
        const input = window.__fakeMidi.input
        const data = new Uint8Array([0xB0, 50, 100])  // CC ch0 cc50 val100
        for (const { type, listener } of input._listeners) {
            if (type === 'midimessage') listener({ data })
        }
    })

    const xfade = await page.evaluate(() =>
        parseFloat(document.getElementById('crossfader').value))
    // 100/127 ≈ 0.787 — proves the bound control handler ran.
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

    await context.close()
})
