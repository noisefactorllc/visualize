// SPDX-License-Identifier: MIT
//
// Local Network Access permission denial and recovery, in real browser
// controls and without any launch bypass. sync-audio.spec.js runs with
// --disable-features=LocalNetworkAccessChecks because its daemon traffic is
// loopback; this spec launches with the browser's real checks and drives the
// SDK's documented permission path instead: a failed daemon health check is
// followed by a loopback permission query, whose denial surfaces as
// SyncPermissionDeniedError and whose grant lets pairing proceed past the
// permission gate. Both phases use a closed loopback port, so they are
// deterministic and never depend on the check actually firing.
import { test, expect } from '@playwright/test'
import net from 'node:net'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { routeSeanceSdkLocal, routePortableImagesLocal } from './seanceLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
const fixtureDsl = 'search synth, render\nnoise(seed: 7).write(o0)\nrender(o0)'

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

// Reserve a loopback port, then release it: the pairing health check must
// fail for the SDK's permission query to run, and a refused connection fails
// it deterministically.
//
// Sandboxed runners may forbid listening on ephemeral loopback ports
// (listen EPERM). There the helper falls back to the broker's permitted
// loopback range and picks a port verified closed by a refused connection —
// the same "closed port" contract, without binding it.
async function closedLoopbackPort() {
    const server = net.createServer()
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', resolve)
        })
        const port = server.address().port
        await new Promise(resolve => server.close(resolve))
        return port
    } catch (err) {
        if (!err || err.code !== 'EPERM') throw err
    }

    const configured = (process.env.PW_TEST_LOOPBACK_PORTS || '43117-43126')
        .split(',').flatMap(s => {
            const m = s.trim().match(/^(\d+)-(\d+)$/)
            return m ? range(+m[1], +m[2]) : (+s ? [+s] : [])
        })
    const own = Number(process.env.PW_PORT || 0)
    for (const port of configured.filter(p => p !== own)) {
        const closed = await new Promise(resolve => {
            const probe = net.connect(port, '127.0.0.1')
            probe.once('connect', () => { probe.destroy(); resolve(false) })
            probe.once('error', () => resolve(true))
        })
        if (closed) return port
    }
    throw new Error('no closed permitted loopback port found')
}

function range(lo, hi) {
    const out = []
    for (let p = Math.min(lo, hi); p <= Math.max(lo, hi); p++) out.push(p)
    return out
}

test('Sync loopback permission denial surfaces an error and the grant path recovers', async ({ page }) => {
    const port = await closedLoopbackPort()
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routeSeanceSdkLocal(page)
    await routePortableImagesLocal(page)
    await page.route('**/data/programs.json', route => route.fulfill({
        json: [{ title: 'Sync permission fixture', tagline: '', tags: ['abstract'], category: 'abstract', dsl: fixtureDsl }]
    }))
    // The endpoint and the permission state are read at client construction,
    // so each phase can flip them without reloading the page.
    await page.route('**/js/sync/audio.js', route => route.fulfill({
        contentType: 'text/javascript',
        body: `import { SyncBridgeClient as Base } from '/js/sync/sdk/0.3.0/browser/index.js';
            export class SyncBridgeClient extends Base {
                constructor(options) {
                    super({ timeoutMs: 15000, ...options, endpoint: window.__syncEndpoint,
                        permissions: { query: async () => ({ state: window.__syncPermissionState }) } });
                }
            }`
    }))

    await page.goto('/')
    await page.evaluate(endpoint => {
        navigator.mediaDevices.getUserMedia = async () => { throw new Error('Sync must not fall back to the microphone') }
        window.__syncEndpoint = endpoint
        window.__syncPermissionState = 'denied'
    }, `http://127.0.0.1:${port}`)
    await page.click('#boot-start')
    await page.waitForFunction(() => window.__visualize?.audio, null, { timeout: 45_000 * SCALE })

    await page.click('#settings-toggle')
    await page.click('#sync-audio-connect')
    await expect(page.locator('#sync-audio-status'), 'a denied loopback permission must surface as an error')
        .toHaveText('Loopback network permission was denied', { timeout: 30_000 * SCALE })
    await expect.poll(() => page.evaluate(() => window.__visualize.audio.enabled)).toBe(false)

    // Recovery: the user approves the permission. Pairing now proceeds past
    // the permission gate; the closed port still refuses the daemon, so the
    // surfaced failure moves on from the permission error to the daemon
    // itself — and the input stays selectable for the next attempt.
    await page.evaluate(() => { window.__syncPermissionState = 'granted' })
    await page.click('#sync-audio-connect')
    await expect(page.locator('#sync-audio-status'), 'a granted permission must proceed past the permission gate')
        .toHaveText('Sync daemon did not answer', { timeout: 30_000 * SCALE })
    await expect.poll(() => page.evaluate(() => document.getElementById('audio-device').value)).toBe('')
})