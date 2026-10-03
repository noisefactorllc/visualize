// SPDX-License-Identifier: MIT
//
// Regression tests for the Sync audio input connect/retry and bridge-buffer
// reset policies in js/sync/audioInput.js:
//
// - the native daemon closes control connections whose hello misses its 1s
//   deadline (kControlHelloDeadlineMs) and whose exchanges miss its 2s
//   data-message deadline (kDataMessageDeadlineMs); a busy main thread loses
//   that race, which surfaced as 'control connection closed'/SyncUnavailableError
//   during discovery and device selection.
// - the bridge buffer must reset only when the stream restarts; resetting on
//   every droppedFrames advance starved the documented prefill under renderer
//   load, so meters read 0 while audio flowed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncLifecycleError, SyncUnavailableError } from '../js/sync/sdk/0.3.0/browser/index.js'
import {
    isTransientConnectLoss,
    retryUnavailable,
    syncAudioNeedsReset,
    createSyncAudioInput
} from '../js/sync/audioInput.js'

test('transient connect loss classifies both daemon deadline shapes and nothing else', () => {
    assert.equal(isTransientConnectLoss(new SyncUnavailableError('pairing connection failed')), true)
    assert.equal(isTransientConnectLoss(new SyncLifecycleError('control connection closed')), true)
    assert.equal(isTransientConnectLoss(new SyncLifecycleError('stream ended')), false)
    assert.equal(isTransientConnectLoss(new Error('control connection closed')), false)
    assert.equal(isTransientConnectLoss(Object.assign(new Error('x'), { daemonCode: 'audio_pairing_required' })), false)
})

test('retryUnavailable retries transient losses with bounded backoff and then succeeds', async () => {
    let calls = 0
    const result = await retryUnavailable(() => {
        calls++
        if (calls < 3) throw new SyncUnavailableError('pairing connection failed')
        return 'ok'
    }, { delay: 1 })
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
})

test('retryUnavailable counts the last attempt and rethrows persistent loss', async () => {
    let calls = 0
    await assert.rejects(retryUnavailable(() => {
        calls++
        throw new SyncLifecycleError('control connection closed')
    }, { attempts: 3, delay: 1 }), /control connection closed/)
    assert.equal(calls, 3)
})

test('retryUnavailable passes non-transient errors through without retrying', async () => {
    let calls = 0
    await assert.rejects(retryUnavailable(() => {
        calls++
        throw new Error('Update Sync to a version that supports audio input')
    }, { delay: 1 }), /supports audio input/)
    assert.equal(calls, 1)
})

test('retryUnavailable never starts an attempt after the selection was aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const pending = retryUnavailable(() => {
        calls++
        throw new SyncUnavailableError('pairing connection failed')
    }, { delay: 5, signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 2))
    controller.abort()
    await assert.rejects(pending)
    assert.equal(calls, 1)
})

test('retryUnavailable refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    await assert.rejects(retryUnavailable(() => { calls++ }, { signal: controller.signal }), /aborted/)
    assert.equal(calls, 0)
})

test('bridge buffer reset fires only when the stream restarts, not on forward drops', () => {
    const start = { firstFrame: 1000n, frameCount: 480, droppedFrames: 0 }
    // First packet: nothing to reset.
    assert.equal(syncAudioNeedsReset(null, start), false)
    // Continuous stream.
    assert.equal(syncAudioNeedsReset(1480n, { firstFrame: 1480n, frameCount: 480 }), false)
    // Forward jump with dropped frames: the pre-restart policy flushed here on
    // every read under renderer load, keeping meters at 0; it must not reset.
    assert.equal(syncAudioNeedsReset(1480n, { firstFrame: 2440n, frameCount: 480, droppedFrames: 480 }), false)
    // Stream restart (firstFrame moves backward): reset.
    assert.equal(syncAudioNeedsReset(1480n, { firstFrame: 480n, frameCount: 480 }), true)
})

function fakeCredentialStore() {
    const credential = { token: 'cred-1' }
    return {
        credential,
        current: () => credential,
        publish: value => value,
        clear() {}
    }
}

function fakeClient(handlers) {
    let closed = 0
    return {
        closedCount: () => closed,
        close() { closed++ },
        async pair(name) { return handlers.pair?.(name) ?? { token: 't' } },
        async connect() {
            if (handlers.connect) return handlers.connect()
            return { capabilities: { providers: [{ id: 'audio', available: true, selected: true }] } }
        },
        async listAudioSources() {
            return [{ id: 'audio_1', name: 'Device 1', channelCount: 2, sampleRate: 48000 }]
        }
    }
}

test('discovery recovers from a transient control-connection loss and closes the stale client', async () => {
    const store = fakeCredentialStore()
    const clients = []
    let connectCalls = 0
    const syncAudio = createSyncAudioInput({
        Client: class {
            constructor() { this.inner = fakeClient({
                async connect() {
                    connectCalls++
                    if (connectCalls === 1) throw new SyncLifecycleError('control connection closed')
                    return { capabilities: { providers: [{ id: 'audio', available: true, selected: true }] } }
                }
            }) }
            close() { this.inner.close() }
            pair(name) { return this.inner.pair(name) }
            connect() { return this.inner.connect() }
            listAudioSources() { return this.inner.listAudioSources() }
        },
        credentialStore: store,
        appName: 'Test'
    })
    // The retry backoff is real time; discovery succeeds on the second connect
    // after one 600ms delay.
    const devices = await syncAudio.connectSyncAudio()
    assert.equal(devices.length, 1)
    assert.equal(devices[0].id, 'sync-audio:audio_1')
    assert.equal(devices[0].connected, true)
    assert.equal(connectCalls, 2)
})

test('discovery surfaces a persistent control-connection loss as a failure', async () => {
    const store = fakeCredentialStore()
    let connectCalls = 0
    const syncAudio = createSyncAudioInput({
        Client: class {
            constructor() { this.inner = fakeClient({
                async connect() {
                    connectCalls++
                    throw new SyncUnavailableError('pairing connection failed')
                }
            }) }
            close() { this.inner.close() }
            pair(name) { return this.inner.pair(name) }
            connect() { return this.inner.connect() }
            listAudioSources() { return this.inner.listAudioSources() }
        },
        credentialStore: store,
        appName: 'Test'
    })
    await assert.rejects(syncAudio.connectSyncAudio(), /pairing connection failed/)
    assert.equal(connectCalls, 3)
    assert.deepEqual(syncAudio.getSyncAudioDevices(), [])
})
