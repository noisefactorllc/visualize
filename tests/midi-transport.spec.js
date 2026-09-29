// SPDX-License-Identifier: MIT
/**
 * MIDI transport → scheduler integration coverage.
 *
 * Exercises the app-level wiring in js/app.js (`midi.onTransport` →
 * `transportAction` → scheduler.resetPhase/start/stop) end-to-end in the
 * browser: fake MIDI input drives System Real-Time Start/Continue/Stop
 * bytes through the real midimessage listener, and the live tempo-bar
 * scheduler's running state + beat position are asserted.
 *
 * The regression this pins: transport events must never re-anchor a
 * RUNNING scheduler's beat grid (AutoXfade oscillator phase and AutoMix
 * bar cadence would snap mid-fade). Start repositions to bar zero only
 * from a stopped scheduler; Continue resumes without re-anchoring.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

test.describe.configure({ timeout: 120_000 * SCALE, retries: 1 })

async function bootWithFakeMidi(browser) {
    const context = await browser.newContext()
    await context.addInitScript(() => {
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
    await page.waitForFunction(() =>
        !!window.__visualize?.midi && !!window.__visualize?.scheduler,
        null, { timeout: 30_000 * SCALE })

    return { context, page }
}

test('MIDI transport Start/Continue/Stop drive the scheduler without re-anchoring a running grid', async ({ browser }) => {
    const { context, page } = await bootWithFakeMidi(browser)

    // Enable MIDI, then clock follow, through the real UI toggles
    // (both live in the settings drawer).
    await page.click('#settings-toggle')
    await page.waitForFunction(() =>
        document.getElementById('midi-enable')?.offsetParent !== null,
        null, { timeout: 15_000 * SCALE })
    await page.click('#midi-enable')
    await page.waitForFunction(() =>
        window.__visualize?.midi?.enabled === true
            && window.__visualize.midi.inputCount === 1,
        null, { timeout: 15_000 * SCALE })
    await page.click('#midi-clock-enable')
    await page.waitForFunction(() => window.__visualize.midi.followClock === true,
        null, { timeout: 10_000 * SCALE })

    // Park the scheduler in a deterministic stopped state.
    const parked = await page.evaluate(() => {
        const data = new Uint8Array([0xFC]) // Stop
        for (const { type, listener } of window.__fakeMidi.input._listeners) {
            if (type === 'midimessage') listener({ data })
        }
        return window.__visualize.scheduler.running
    })
    expect(parked).toBe(false)

    // Start from stopped: restart — reset to bar zero and run. Read the
    // scheduler state in the same tick as the dispatch: the app handler
    // is synchronous, so resetPhase() has already applied (pre-fix
    // behavior is identical here; this pins the restart contract).
    const started = await page.evaluate(() => {
        const data = new Uint8Array([0xFA]) // Start
        for (const { type, listener } of window.__fakeMidi.input._listeners) {
            if (type === 'midimessage') listener({ data })
        }
        const s = window.__visualize.scheduler
        return { running: s.running, beatIndex: s.beatIndex }
    })
    expect(started.running).toBe(true)
    expect(started.beatIndex).toBe(0) // grid re-anchored to bar zero

    // Let the grid run forward, then Continue while running: the beat
    // position must NOT reset (pre-fix, Continue called resetPhase()).
    await page.waitForFunction(() => window.__visualize.scheduler.beatIndex >= 2,
        null, { timeout: 20_000 * SCALE })
    const continued = await page.evaluate(() => {
        const data = new Uint8Array([0xFB]) // Continue
        for (const { type, listener } of window.__fakeMidi.input._listeners) {
            if (type === 'midimessage') listener({ data })
        }
        const s = window.__visualize.scheduler
        return { running: s.running, beatIndex: s.beatIndex }
    })
    expect(continued.running).toBe(true)
    expect(continued.beatIndex).toBeGreaterThanOrEqual(2) // grid not re-anchored

    // Start while running: also must NOT re-anchor (pre-fix it reset
    // phase unconditionally — an audible stutter mid-fade).
    const redundant = await page.evaluate(() => {
        const data = new Uint8Array([0xFA]) // Start (redundant)
        for (const { type, listener } of window.__fakeMidi.input._listeners) {
            if (type === 'midimessage') listener({ data })
        }
        const s = window.__visualize.scheduler
        return { running: s.running, beatIndex: s.beatIndex }
    })
    expect(redundant.running).toBe(true)
    expect(redundant.beatIndex).toBeGreaterThanOrEqual(2) // no mid-fade snap

    // Stop while running: pause. Continue from stopped: resume without
    // re-anchoring (beat position preserved across stop/continue).
    const pausedAndResumed = await page.evaluate(() => {
        const send = (b) => {
            const data = new Uint8Array([b])
            for (const { type, listener } of window.__fakeMidi.input._listeners) {
                if (type === 'midimessage') listener({ data })
            }
        }
        const s = window.__visualize.scheduler
        const beatBeforeStop = s.beatIndex
        send(0xFC) // Stop
        const stoppedRunning = s.running
        send(0xFB) // Continue
        return {
            beatBeforeStop,
            stoppedRunning,
            resumedRunning: s.running,
            beatAfterResume: s.beatIndex,
        }
    })
    expect(pausedAndResumed.stoppedRunning).toBe(false)
    expect(pausedAndResumed.resumedRunning).toBe(true)
    expect(pausedAndResumed.beatAfterResume).toBeGreaterThanOrEqual(
        pausedAndResumed.beatBeforeStop) // resume, not restart

    await context.close()
})
