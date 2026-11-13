// SPDX-License-Identifier: MIT
//
// Regression tests for how the vendored audio SDK snapshot classifies daemon
// `audio_unavailable` errors. Sync 933b158 (current daemon source) answers
// openAudioSource contention, hotplug and capture failure with the bounded
// `audio_unavailable` error and tears the capture down on the worker thread;
// the SDK contract classifies that code as SyncUnavailableError, the same
// transient class visualize's selection retry (retryUnavailable) recovers.
// The client under test is imported through js/sync/audio.js, so these tests
// always exercise the exact immutable snapshot bytes the app loads.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncBridgeClient } from '../js/sync/audio.js'
import { SyncUnavailableError } from '../js/sync/sdk/0.3.3/browser/index.js'
import { retryUnavailable } from '../js/sync/audioInput.js'

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

// Minimal control-connection daemon speaking the real JSON control protocol
// (browser/client.js: hello -> welcome, then one response per request).
class FakeControlSocket {
    constructor(respond) {
        this.readyState = 0
        this.respond = respond
        this.listeners = new Map()
        queueMicrotask(() => {
            this.readyState = 1
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
        const request = JSON.parse(data)
        const response = this.respond(request)
        if (response !== undefined) {
            queueMicrotask(() => this.emit('message', { data: JSON.stringify(response) }))
        }
    }
    close() {
        this.readyState = 3
        queueMicrotask(() => this.emit('close', {}))
    }
}

function harness(requests) {
    const socketClass = class {
        constructor() { return new FakeControlSocket(request => {
            requests.push(request)
            if (request.type === 'hello') return WELCOME
            if (request.type === 'openAudioSource') {
                return {
                    type: 'error',
                    code: 'audio_unavailable',
                    message: 'Audio source unavailable, busy, disconnected, or permission denied'
                }
            }
            return undefined
        }) }
    }
    return new SyncBridgeClient({
        endpoint: 'http://127.0.0.1:53979',
        token: 'classification-test-token',
        WebSocket: socketClass,
        permissions: { query: async () => ({ state: 'granted' }) },
        timeoutMs: 2000
    })
}

test('daemon audio_unavailable decodes as SyncUnavailableError with its daemon code', async () => {
    const requests = []
    const client = harness(requests)
    try {
        await client.connect()
        const open = client.openAudioSource('audio_busy')
        await assert.rejects(open, error => {
            assert.equal(error.name, 'SyncUnavailableError')
            assert.equal(error.daemonCode, 'audio_unavailable')
            assert.match(error.message, /busy/)
            return true
        })
    } finally {
        client.close()
    }
    assert.equal(requests.filter(request => request.type === 'openAudioSource').length, 1)
})

test('contention on selection is retried as transient unavailability before failing', async () => {
    const requests = []
    const client = harness(requests)
    try {
        await client.connect()
        await assert.rejects(
            retryUnavailable(() => client.openAudioSource('audio_busy'), { attempts: 3, delay: 1 }),
            error => error.name === 'SyncUnavailableError' && error.daemonCode === 'audio_unavailable'
        )
    } finally {
        client.close()
    }
    assert.equal(requests.filter(request => request.type === 'openAudioSource').length, 3,
        'a contended open must consume the full bounded retry budget')
})
