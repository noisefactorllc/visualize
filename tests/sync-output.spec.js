// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'

test('Noisedeck Sync target sends real SDK-framed mixer pixels and disposes on pagehide', async ({ page }) => {
    test.slow()
    await page.addInitScript(() => {
        const calls = []
        const frames = []
        const sockets = []
        const token = 'b'.repeat(64)
        const senderId = 'visualize-main'
        const ticket = `ticket.${'c'.repeat(32)}`
        const capabilities = {
            send: true,
            receive: false,
            providers: [
                { id: 'ndi', direction: 'send', available: true, selected: true },
                { id: 'spout', direction: 'send', available: true, selected: true }
            ]
        }
        const health = {
            product: 'Sync',
            status: 'ok',
            version: '0.2.19',
            protocolVersions: [1],
            instanceId: 'sync-browser-test',
            capabilities
        }
        const welcome = {
            type: 'welcome',
            protocolVersion: 1,
            version: health.version,
            instanceId: health.instanceId,
            capabilities
        }

        function summarizeFrame(value) {
            const bytes = value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            let rgbNonZero = false
            let checksum = 2166136261
            for (let offset = 64; offset < bytes.length; offset++) {
                if ((offset - 64) % 4 !== 3 && bytes[offset] !== 0) rgbNonZero = true
                checksum = Math.imul(checksum ^ bytes[offset], 16777619) >>> 0
            }
            return {
                byteLength: bytes.byteLength,
                magic: view.getUint32(0, true),
                version: view.getUint16(4, true),
                headerBytes: view.getUint16(6, true),
                width: view.getUint32(20, true),
                height: view.getUint32(24, true),
                rowStride: view.getUint32(28, true),
                payloadBytes: view.getUint32(32, true),
                sequence: Number(view.getBigUint64(36, true)),
                presentationTimeUs: Number(view.getBigUint64(44, true)),
                rgbNonZero,
                checksum
            }
        }

        class SyncTransportSocket extends EventTarget {
            static CONNECTING = 0
            static OPEN = 1
            static CLOSING = 2
            static CLOSED = 3

            constructor(url, protocol) {
                super()
                this.url = String(url)
                this.path = new URL(this.url).pathname
                this.protocol = typeof protocol === 'string' ? protocol : ''
                this.readyState = SyncTransportSocket.CONNECTING
                this.bufferedAmount = 0
                this.binaryType = 'blob'
                sockets.push(this)
                calls.push(['socket-create', this.path, this.protocol])
                queueMicrotask(() => {
                    if (this.readyState !== SyncTransportSocket.CONNECTING) return
                    this.readyState = SyncTransportSocket.OPEN
                    this.dispatchEvent(new Event('open'))
                })
            }

            send(value) {
                if (this.readyState !== SyncTransportSocket.OPEN) {
                    throw new DOMException('socket is not open', 'InvalidStateError')
                }
                if (this.path === '/pair') {
                    const request = JSON.parse(value)
                    calls.push(['pair', request.name, request.protocolVersions])
                    this._reply({ type: 'paired', protocolVersion: 1, token })
                    queueMicrotask(() => this.close(1000, 'paired'))
                    return
                }
                if (this.path === '/control') {
                    const request = JSON.parse(value)
                    if (request.type === 'hello') {
                        calls.push(['hello', request.token, request.protocolVersions])
                        this._reply(welcome)
                        return
                    }
                    if (request.type === 'createSender') {
                        calls.push(['create-sender', request.name])
                        this._reply({
                            type: 'senderCreated',
                            id: senderId,
                            name: request.name,
                            path: `/senders/${senderId}`,
                            ticket
                        })
                        return
                    }
                    if (request.type === 'closeSender') {
                        calls.push(['close-sender', request.senderId])
                        this._reply({ type: 'senderClosed', id: request.senderId })
                        return
                    }
                    throw new Error(`unexpected control request: ${request.type}`)
                }
                if (this.path === `/senders/${senderId}`) {
                    if (frames.length < 2) frames.push(summarizeFrame(value))
                    calls.push(['frame', frames.at(-1)?.sequence ?? null])
                    return
                }
                throw new Error(`unexpected Sync socket path: ${this.path}`)
            }

            close(code = 1000, reason = '') {
                if (this.readyState >= SyncTransportSocket.CLOSING) return
                this.readyState = SyncTransportSocket.CLOSING
                queueMicrotask(() => {
                    this.readyState = SyncTransportSocket.CLOSED
                    calls.push(['socket-close', this.path])
                    this.dispatchEvent(new CloseEvent('close', {
                        code,
                        reason,
                        wasClean: code === 1000
                    }))
                })
            }

            _reply(value) {
                queueMicrotask(() => {
                    if (this.readyState !== SyncTransportSocket.OPEN) return
                    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
                })
            }
        }

        async function syncFetch(url, options) {
            calls.push(['health', String(url), options?.credentials, options?.targetAddressSpace])
            return new Response(JSON.stringify(health), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }

        window.__visualizeSyncTest = { calls, frames, sockets }
        window.__VISUALIZE_SYNC_TRANSPORT__ = {
            fetch: syncFetch,
            WebSocket: SyncTransportSocket,
            permissions: null
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
    await page.waitForFunction(() => window.__visualizeSyncTest.frames.length >= 2)

    const transport = await page.evaluate(() => ({
        calls: window.__visualizeSyncTest.calls,
        frames: window.__visualizeSyncTest.frames
    }))
    expect(transport.calls).toContainEqual(['pair', 'Visualize', [1]])
    expect(transport.calls).toContainEqual(['create-sender', 'Visualize Main'])
    expect(transport.frames).toHaveLength(2)
    for (const frame of transport.frames) {
        expect(frame).toMatchObject({
            magic: 0x434e5953,
            version: 1,
            headerBytes: 64,
            width: 1280,
            height: 720,
            rowStride: 1280 * 4,
            payloadBytes: 1280 * 720 * 4,
            byteLength: 64 + 1280 * 720 * 4,
            rgbNonZero: true
        })
        expect(frame.presentationTimeUs).toBeGreaterThan(0)
    }
    expect(transport.frames[0].sequence).toBeGreaterThan(0)
    expect(transport.frames[1].sequence).toBeGreaterThan(transport.frames[0].sequence)

    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Ready')
    await page.waitForFunction(() => (
        window.__visualizeSyncTest.calls.some((entry) => entry[0] === 'close-sender')
    ))

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

    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Connected')
    await page.click('#sync-output-action')
    await expect(page.locator('#sync-output-state')).toHaveText('Sending')
    const closesBeforePagehide = await page.evaluate(() => (
        window.__visualizeSyncTest.calls.filter((entry) => entry[0] === 'socket-close').length
    ))
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', {
        persisted: true
    })))
    await page.waitForTimeout(100)
    const closesAfterPersistedPagehide = await page.evaluate(() => (
        window.__visualizeSyncTest.calls.filter((entry) => entry[0] === 'socket-close').length
    ))
    expect(closesAfterPersistedPagehide).toBe(closesBeforePagehide)
    await expect(page.locator('#sync-output-state')).toHaveText('Sending')

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))
    await page.waitForFunction((before) => (
        window.__visualizeSyncTest.calls.filter((entry) => entry[0] === 'socket-close').length >= before + 2
    ), closesBeforePagehide, { timeout: 5_000 })
})
