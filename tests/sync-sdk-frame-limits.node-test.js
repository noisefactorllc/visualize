// SPDX-License-Identifier: MIT
//
// Regression tests for the vendored Sync SDK snapshot's v1 frame limits and
// explicit-connect permission ordering.
//
// Sync 4cb0553 (GAP-005) makes encodeFrameV1()/decodeFrameHeaderV1() refuse the
// frames the v1 receiver refuses (width or height above 4096, RGBA or NV12
// payload above 64 MiB) and SyncFrameSink.configure() refuse such a descriptor.
// Sync 3ef1ca5 (GAP-007) opens the control socket first in connect(), so a
// loopback-served page whose loopback permission state reads "prompt" can show
// the browser's local-network prompt instead of stopping with
// SyncPermissionRequiredError on every click. Both tests import through the
// app's shared loaders (js/sync/bundle.js and js/sync/audio.js), so they always
// exercise the exact immutable snapshot bytes the app loads.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
    ALPHA_MODE,
    COLOR_SPACE,
    PIXEL_FORMAT,
    SyncFrameSink,
    decodeFrameHeaderV1,
    encodeFrameV1,
} from '../js/sync/bundle.js'
import { SyncBridgeClient } from '../js/sync/audio.js'

const RGBA = Object.freeze({
    width: 2, height: 1, rowStride: 8,
    sequence: 1, presentationTimeUs: 0,
    pixelFormat: PIXEL_FORMAT.RGBA8_UNORM, colorSpace: COLOR_SPACE.SRGB,
    alphaMode: ALPHA_MODE.OPAQUE,
})

test('encodeFrameV1 accepts the largest v1 RGBA frame and refuses frames above its limits', () => {
    // A 4096 by 4096 RGBA frame with a packed stride fills the 64 MiB limit exactly.
    const largest = encodeFrameV1(
        { ...RGBA, width: 4096, height: 4096, rowStride: 16384 },
        new Uint8Array(64 * 1024 * 1024),
    )
    assert.equal(decodeFrameHeaderV1(largest).payloadBytes, 64 * 1024 * 1024)

    assert.throws(() => encodeFrameV1(
        { ...RGBA, width: 4097, height: 1, rowStride: 16388 }, new Uint8Array(16388),
    ), RangeError)
    assert.throws(() => encodeFrameV1(
        { ...RGBA, width: 1, height: 4097, rowStride: 4 }, new Uint8Array(4),
    ), RangeError)
    assert.throws(() => encodeFrameV1(
        { ...RGBA, width: 4096, height: 4096, rowStride: 16388 }, new Uint8Array(4),
    ), /protocol v1 limits/)
})

test('decodeFrameHeaderV1 refuses headers above the v1 limits', () => {
    const header = (mutate) => {
        const bytes = new Uint8Array(
            encodeFrameV1(RGBA, new Uint8Array(8)),
        ).slice(0, 64)
        const view = new DataView(bytes.buffer)
        mutate(view)
        return bytes
    }
    assert.equal(decodeFrameHeaderV1(header(view => {
        view.setUint32(20, 4096, true)
        view.setUint32(28, 16384, true)
        view.setUint32(32, 16384, true)
    })).width, 4096)
    assert.throws(() => decodeFrameHeaderV1(header(view => view.setUint32(20, 4097, true))), RangeError)
    assert.throws(() => decodeFrameHeaderV1(header(view => view.setUint32(24, 4097, true))), RangeError)
    assert.throws(() => decodeFrameHeaderV1(header(view => {
        view.setUint32(24, 4096, true)
        view.setUint32(28, 16388, true)
        view.setUint32(32, 67125248, true)
    })), /protocol v1 limits/)
})

const DESCRIPTOR = Object.freeze({
    width: 2, height: 1, format: 'rgba8unorm',
    colorSpace: 'srgb', alphaMode: 'premultiplied', fps: 60,
})

test('SyncFrameSink.configure refuses a descriptor above the v1 limits and accepts 4096', () => {
    const socket = {
        readyState: 1, bufferedAmount: 0, send() {}, close() { this.readyState = 3 },
    }
    const queue = {
        get available() { return true },
        configure() {}, enqueue() { return true }, poll() {}, close() {},
    }
    const sink = new SyncFrameSink({
        socket, exportQueue: queue, maxBufferedFrames: 1, clock: { timeOrigin: 1000 },
    })
    try {
        assert.throws(() => sink.configure({ ...DESCRIPTOR, width: 4097 }), RangeError)
        assert.throws(() => sink.configure({ ...DESCRIPTOR, height: 4097 }), RangeError)
        assert.equal(sink.configure({ ...DESCRIPTOR, width: 4096, height: 4096 }), undefined)
    } finally { sink.close() }
})

const WELCOME = {
    type: 'welcome',
    protocolVersion: 1,
    version: '0.2.115',
    instanceId: '0123456789abcdef0123456789abcdef',
    capabilities: {
        send: false,
        receive: true,
        providers: [{ id: 'audio', direction: 'receive', available: true, selected: true }]
    }
}

class FakeControlSocket {
    constructor(respond, opened) {
        this.readyState = 0
        this.respond = respond
        this.opened = opened
        this.listeners = new Map()
        queueMicrotask(() => {
            this.readyState = 1
            this.opened.push(this)
            this.emit('open', {})
        })
    }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event) }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, [])
        this.listeners.get(type).push(listener)
    }
    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener))
    }
    send(data) {
        const response = this.respond(JSON.parse(data))
        if (response !== undefined) {
            queueMicrotask(() => this.emit('message', { data: JSON.stringify(response) }))
        }
    }
    close() {
        this.readyState = 3
        queueMicrotask(() => this.emit('close', {}))
    }
}

test('connect() opens the control socket while the loopback permission reads prompt', async () => {
    const requests = []
    const opened = []
    const client = new SyncBridgeClient({
        endpoint: 'http://127.0.0.1:53979',
        token: 'frame-limit-test-token',
        WebSocket: class {
            constructor() { return new FakeControlSocket(request => {
                requests.push(request)
                if (request.type === 'hello') return WELCOME
                return undefined
            }, opened) }
        },
        permissions: { query: async () => ({ state: 'prompt' }) },
        timeoutMs: 2000
    })
    try {
        // GAP-007: the socket must open before the permission state is read, so
        // the browser can show its local-network prompt from a user action.
        await client.connect()
        assert.equal(opened.length, 1)
        assert.ok(requests.some(request => request.type === 'hello'))
    } finally {
        client.close()
    }
    assert.deepEqual(requests.filter(request => request.type === 'hello').length, 1)
})
