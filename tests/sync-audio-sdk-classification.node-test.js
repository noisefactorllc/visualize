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
import { SyncUnavailableError } from '../js/sync/sdk/0.3.5/browser/index.js'
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

// Sync af9d038: a full bounded credential worker answers the hello with
// `authority_saturated` instead of checking the token. The token was never
// checked, so this is transient unavailability (SyncUnavailableError, kept
// token, retried by visualize's bounded connect retry), not an
// authentication failure (which would clear the stored credential).
test('a saturated credential hello decodes as SyncUnavailableError with the token kept', async () => {
    const hellos = []
    let saturated = true
    const socketClass = class {
        constructor() {
            return new FakeControlSocket(request => {
                if (request.type === 'hello') {
                    hellos.push(request.token)
                    if (saturated) {
                        saturated = false
                        return { type: 'error', code: 'authority_saturated', message: 'Credential worker is busy' }
                    }
                    return WELCOME
                }
                return undefined
            })
        }
    }
    const client = new SyncBridgeClient({
        endpoint: 'http://127.0.0.1:53979',
        token: 'saturated-hello-token',
        WebSocket: socketClass,
        permissions: { query: async () => ({ state: 'granted' }) },
        timeoutMs: 2000
    })
    try {
        await assert.rejects(client.connect(), error => {
            assert.equal(error.name, 'SyncUnavailableError')
            assert.equal(error.daemonCode, 'authority_saturated')
            return true
        })
        assert.deepEqual(hellos, ['saturated-hello-token'])
        // The token was never checked, so a retry reuses it and connects.
        const welcome = await client.connect()
        assert.equal(welcome.type, 'welcome')
        assert.deepEqual(hellos, ['saturated-hello-token', 'saturated-hello-token'])
    } finally {
        client.close()
    }
})

test('a saturated credential hello is retried as transient connect loss', async () => {
    let attempts = 0
    const socketClass = class {
        constructor() {
            return new FakeControlSocket(request => {
                if (request.type === 'hello') {
                    attempts++
                    if (attempts < 3) {
                        return { type: 'error', code: 'authority_saturated', message: 'Credential worker is busy' }
                    }
                    return WELCOME
                }
                return undefined
            })
        }
    }
    const client = new SyncBridgeClient({
        endpoint: 'http://127.0.0.1:53979',
        token: 'saturated-retry-token',
        WebSocket: socketClass,
        permissions: { query: async () => ({ state: 'granted' }) },
        timeoutMs: 2000
    })
    try {
        const welcome = await retryUnavailable(() => client.connect(), { attempts: 3, delay: 1 })
        assert.equal(welcome.type, 'welcome')
        assert.equal(attempts, 3, 'a saturated hello must consume the bounded retry budget, not fail at once')
    } finally {
        client.close()
    }
})
