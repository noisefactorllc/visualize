import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { decodeFrameHeaderV1, PIXEL_FORMAT } from '../js/sync/bundle.js'
import { SyncH264CanvasSender, supportsH264CanvasOutput } from '../js/syncH264CanvasSender.js'

const originalEncoder = globalThis.VideoEncoder
const originalFrame = globalThis.VideoFrame
const originalWorker = globalThis.Worker
const originalWebSocketStream = globalThis.WebSocketStream

afterEach(() => {
    globalThis.VideoEncoder = originalEncoder
    globalThis.VideoFrame = originalFrame
    globalThis.Worker = originalWorker
    globalThis.WebSocketStream = originalWebSocketStream
})

function installEncoder() {
    class Frame {
        constructor(_canvas, { timestamp }) { this.timestamp = timestamp }
        close() {}
    }
    class Encoder {
        static async isConfigSupported(config) { return { supported: config.width === 1920 } }
    }
    class Worker {
        postMessage(message) {
            if (message.type === 'configure') {
                queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }))
            } else if (message.type === 'warm') {
                this.warmFrames = (this.warmFrames || 0) + 1
            } else if (message.type === 'finishWarmup') {
                queueMicrotask(() => this.onmessage({ data: {
                    type: 'warmReady', frames: this.warmFrames
                } }))
            } else if (message.type === 'flush') {
                queueMicrotask(() => this.onmessage({ data: { type: 'flushed' } }))
            } else if (message.type === 'frame') {
                const timestamp = message.frame.timestamp
                queueMicrotask(() => this.onmessage({ data: {
                    type: 'encoded', timestamp, payload: new Uint8Array([0, 0, 0, 1]).buffer
                } }))
            }
        }
        terminate() {}
    }
    globalThis.VideoFrame = Frame
    globalThis.VideoEncoder = Encoder
    globalThis.Worker = Worker
    globalThis.WebSocketStream = class WebSocketStream {}
}

function transportFixture() {
    let resolveClosed
    const closed = new Promise(resolve => { resolveClosed = resolve })
    const writes = []
    return {
        writes,
        closed,
        async writeFrame(frame, options) { writes.push({ frame, options, at: performance.now() }) },
        close() { resolveClosed() }
    }
}

test('selects compressed output only for capable macOS companions', { timeout: 5000 }, () => {
    installEncoder()
    const welcome = version => ({ version, capabilities: { providers: [
        { id: 'syphon', direction: 'send', available: true, selected: true }
    ] } })
    assert.equal(supportsH264CanvasOutput(welcome('0.2.83')), false)
    assert.equal(supportsH264CanvasOutput(welcome('0.2.84')), true)
    assert.equal(supportsH264CanvasOutput({ version: '0.2.84', capabilities: { providers: [] } }), false)
})

test('spaces catch-up writes so the receiver does not see a frame burst', {
    timeout: 5000
}, async () => {
    installEncoder()
    const transport = transportFixture()
    const sender = await SyncH264CanvasSender.create({
        client: { createH264StreamSender: async () => transport },
        name: 'Paced', canvas: { width: 1920, height: 1080 },
        descriptor: { width: 1920, height: 1080, fps: 60 }, clock: performance
    })
    const now = performance.now()
    assert.equal(sender.submit(1, now), true)
    assert.equal(sender.submit(2, now + 0.1), true)
    assert.equal(sender.submit(3, now + 0.2), true)
    sender.close()
    await sender.closed
    assert.deepEqual(transport.writes.map(({ frame }) => decodeFrameHeaderV1(frame).sequence), [1, 2, 3])
    assert.ok(transport.writes[1].at - transport.writes[0].at >= 15)
    assert.ok(transport.writes[2].at - transport.writes[1].at >= 15)
})

test('encodes presented canvas frames as paced, ordered H.264 protocol frames', {
    timeout: 5000
}, async () => {
    installEncoder()
    const transport = transportFixture()
    const client = { createH264StreamSender: async () => transport }
    const now = performance.now()
    const sender = await SyncH264CanvasSender.create({
        client, name: 'Visualize', canvas: { width: 1920, height: 1080 },
        descriptor: { width: 1920, height: 1080, fps: 60 }, clock: performance
    })
    assert.equal(sender.submit(5, now), true)
    assert.equal(sender.submit(6, now + 16.67), true)
    const stoppingAt = performance.now()
    sender.close()
    await sender.closed
    assert.ok(performance.now() - stoppingAt >= 45)
    assert.equal(transport.writes.length, 2)
    assert.deepEqual(transport.writes.map(({ frame }) => decodeFrameHeaderV1(frame).sequence), [1, 2])
    assert.ok(transport.writes.every(({ frame, options }) =>
        decodeFrameHeaderV1(frame).pixelFormat === PIXEL_FORMAT.H264_ANNEXB &&
        options.copy === false))
    assert.deepEqual(sender.stats, {
        accepted: 2, droppedBusy: 0, droppedBackpressure: 0, sent: 2, failed: 0
    })
})
