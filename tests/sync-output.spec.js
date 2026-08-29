// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'

test('Noisedeck Sync target discovers, pairs, sends mixer frames, and stops', async ({ page }) => {
    test.slow()
    await page.addInitScript(() => {
        const calls = []
        let resolveClosed
        const closed = new Promise((resolve) => { resolveClosed = resolve })
        const health = {
            product: 'Sync',
            status: 'ok',
            version: '0.2.19',
            protocolVersions: [1],
            instanceId: 'sync-browser-test',
            capabilities: {
                send: true,
                receive: false,
                providers: [
                    { id: 'ndi', direction: 'send', available: true, selected: true },
                    { id: 'spout', direction: 'send', available: true, selected: true }
                ]
            }
        }
        const sender = {
            closed,
            stats: {
                accepted: 0,
                droppedBusy: 0,
                droppedBackpressure: 0,
                sent: 0,
                failed: 0
            },
            configure(descriptor) { calls.push(['configure', descriptor]) },
            submit(textureId, timestamp) {
                this.stats.accepted++
                this.stats.sent++
                calls.push(['submit', typeof textureId, timestamp])
                return true
            },
            close() {
                calls.push(['sender-close'])
                resolveClosed()
            }
        }
        const clients = [
            {
                async probe() {
                    calls.push(['probe'])
                    return { available: true, health }
                },
                close() { calls.push(['passive-close']) }
            },
            {
                async pair(name) {
                    calls.push(['pair', name])
                    return { protocolVersion: 1, token: 'b'.repeat(64) }
                },
                close() { calls.push(['pairing-close']) }
            },
            {
                async connect() {
                    calls.push(['connect'])
                    return { type: 'welcome', protocolVersion: 1, ...health }
                },
                async createSender(name, options) {
                    calls.push(['create-sender', name, options.maxBufferedFrames])
                    return sender
                },
                close() { calls.push(['client-close']) }
            }
        ]
        window.__visualizeSyncTest = { calls }
        window.__VISUALIZE_SYNC_CONNECTION_PROVIDER__ = {
            createClient(options) {
                calls.push(['create-client', Object.keys(options)])
                const client = clients.shift()
                if (!client) throw new Error('unexpected Sync client creation')
                return client
            }
        }
    })

    await page.goto('/')
    await expect(page.locator('#sync-output-open')).toHaveCount(1)
    await page.click('#boot-start')
    await page.waitForFunction(() => window.__visualize?.mixer?.ready === true, null, {
        timeout: 45_000
    })

    await page.click('#sync-output-open')
    const dialog = page.locator('#sync-output-dialog')
    await expect(dialog).toBeVisible()
    const centered = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) < 2 &&
            Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2) < 2
    })
    expect(centered).toBe(true)
    await expect(page.locator('#sync-output-name')).toHaveValue('Visualize')
    await expect(page.locator('#sync-output-state')).toHaveText('Ready')
    await expect(page.locator('#sync-output-action')).toHaveText('Connect Sync')

    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Connected')
    await expect(page.locator('#sync-output-provider')).toHaveText('NDI, Spout')

    await page.fill('#sync-output-name', 'Visualize Main')
    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Sending')
    await expect(page.locator('#sync-output-live')).toBeVisible()
    await expect(page.locator('#sync-output-format')).toHaveText('1280×720 · 60 fps')
    await page.waitForFunction(() => (
        window.__visualizeSyncTest.calls.some((entry) => entry[0] === 'submit')
    ))

    const liveCalls = await page.evaluate(() => window.__visualizeSyncTest.calls)
    expect(liveCalls).toContainEqual(['pair', 'Visualize'])
    expect(liveCalls).toContainEqual(['create-sender', 'Visualize Main', 1])

    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Ready')
    const stoppedCalls = await page.evaluate(() => window.__visualizeSyncTest.calls)
    expect(stoppedCalls).toContainEqual(['sender-close'])
    expect(stoppedCalls).toContainEqual(['client-close'])

    await page.setViewportSize({ width: 700, height: 480 })
    const shortViewportLayout = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return {
            contained: rect.top >= 0 && rect.bottom <= window.innerHeight,
            overflowY: getComputedStyle(element).overflowY
        }
    })
    expect(shortViewportLayout.contained).toBe(true)
    expect(shortViewportLayout.overflowY).toBe('auto')
})
