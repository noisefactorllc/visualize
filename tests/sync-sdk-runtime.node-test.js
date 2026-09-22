import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncFrameSink, decodeFrameHeaderV1 } from '../js/sync/bundle.js'

const DESCRIPTOR = Object.freeze({
    width: 2, height: 1, format: 'rgba8unorm',
    colorSpace: 'srgb', alphaMode: 'premultiplied', fps: 60,
})
const FRAME = Object.freeze({
    width: 2, height: 1, rowStride: 8,
    data: new Uint8Array([255, 0, 0, 255, 0, 128, 0, 128]),
})

// GPU completion is deferred to poll; socket bytes drain only between tasks.
// These two boundaries reproduce the browser ordering that caused half-rate
// output. Both web and desktop consume the real shared loader above.
function createHarness({ completeOnPoll = true } = {}) {
    const pending = []
    const messages = []
    const buffers = []
    let peakBufferedAmount = 0
    const socket = {
        readyState: 1,
        bufferedAmount: 0,
        send(message) {
            const bytes = message instanceof ArrayBuffer
                ? new Uint8Array(message)
                : new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
            buffers.push(bytes.buffer)
            messages.push(bytes.slice()) // WebSocket.send copies bytes synchronously.
            this.bufferedAmount += bytes.byteLength
            peakBufferedAmount = Math.max(peakBufferedAmount, this.bufferedAmount)
        },
        close() { this.readyState = 3 },
    }
    function complete() {
        const entry = pending.shift()
        if (entry) entry.callback(FRAME, entry.timestamp, entry.sequence)
    }
    const queue = {
        get available() { return pending.length < 3 },
        configure() {},
        enqueue(textureId, timestamp, callback, sequence) {
            if (!this.available) return false
            pending.push({ textureId, timestamp, callback, sequence })
            return true
        },
        poll() { if (completeOnPoll) complete() },
        close() { pending.length = 0 },
    }
    const sink = new SyncFrameSink({
        socket, exportQueue: queue, maxBufferedFrames: 1, clock: { timeOrigin: 1000 },
    })
    sink.configure(DESCRIPTOR)
    return { sink, socket, complete, messages, buffers, get peak() { return peakBufferedAmount } }
}

test('shared loader admits the next readback after poll sends within a one-frame budget', {
    timeout: 5_000,
}, () => {
    const harness = createHarness()
    const { sink, socket, complete, messages } = harness
    try {
        for (let frame = 0; frame < 60; frame++) {
            socket.bufferedAmount = 0
            assert.strictEqual(sink.submit('o0', frame * 1000 / 60), true, `render task ${frame}`)
        }
        socket.bufferedAmount = 0
        complete()
        assert.strictEqual(messages.length, 60)
        assert.strictEqual(harness.peak, 72)
        assert.deepStrictEqual(sink.stats, {
            accepted: 60, droppedBusy: 0, droppedBackpressure: 0, sent: 60, failed: 0,
        })
        for (let frame = 0; frame < messages.length; frame++) {
            const header = decodeFrameHeaderV1(messages[frame])
            assert.strictEqual(header.sequence, frame + 1)
            assert.strictEqual(header.presentationTimeUs, Math.round((1000 + frame * 1000 / 60) * 1000))
            assert.deepStrictEqual(messages[frame].subarray(64), FRAME.data)
        }
    } finally { sink.close() }
})

test('shared loader reuses framing storage while sent frame bytes remain independent', {
    timeout: 5_000,
}, () => {
    const { sink, socket, complete, messages, buffers } = createHarness({ completeOnPoll: false })
    try {
        for (let frame = 0; frame < 3; frame++) {
            socket.bufferedAmount = 0
            assert.strictEqual(sink.submit('o0', frame), true)
            complete()
        }
        assert.strictEqual(messages.length, 3)
        assert.strictEqual(buffers[1], buffers[0])
        assert.strictEqual(buffers[2], buffers[0])
        assert.deepStrictEqual(messages.map(message => decodeFrameHeaderV1(message).sequence), [1, 2, 3])
        for (const message of messages) assert.deepStrictEqual(message.subarray(64), FRAME.data)
    } finally { sink.close() }
})

test('shared loader still rejects readback when socket pressure survives a task boundary', {
    timeout: 5_000,
}, () => {
    const { sink, socket, messages } = createHarness()
    try {
        assert.strictEqual(sink.submit('o0', 0), true)
        socket.bufferedAmount = 72
        assert.strictEqual(sink.submit('o0', 1000 / 60), false)
        assert.strictEqual(messages.length, 0)
        assert.strictEqual(sink.stats.accepted, 1)
        assert.ok(sink.stats.droppedBackpressure > 0)
        socket.bufferedAmount = 0
        assert.strictEqual(sink.submit('o0', 2000 / 60), true)
    } finally { sink.close() }
})
