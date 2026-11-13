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
// - the bridge buffer reset must follow Sync's documented discontinuity
//   contract: reset queued audio when firstFrame stops following the
//   preceding cursor or droppedFrames changes. The worklet pairs this with
//   a prompt resume (no re-prefill after a reset) so a sustained run of
//   drops under renderer load cannot starve playback and meters.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncLifecycleError, SyncUnavailableError } from '../js/sync/sdk/0.3.3/browser/index.js'
import {
    isTransientConnectLoss,
    retryUnavailable,
    syncAudioNeedsReset,
    createSyncAudioInput
} from '../js/sync/audioInput.js'

// Real worklet harness: load the worklet module the way an AudioWorklet
// global scope would, so tests below can drive actual bridge processors.
const processors = new Map()
globalThis.AudioWorkletProcessor = class {
    constructor() {
        this.port = { onmessage: null, postMessage: () => {} }
    }
}
globalThis.registerProcessor = (name, ctor) => processors.set(name, ctor)
await import('../js/sync/audioWorklet.js')

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

test('bridge buffer reset follows the Sync discontinuity contract', () => {
    const start = { firstFrame: 1000n, frameCount: 480, droppedFrames: 0 }
    // First packet: nothing to reset.
    assert.equal(syncAudioNeedsReset(null, null, start), false)
    // Continuous stream: same cursor, same drop count.
    assert.equal(syncAudioNeedsReset(1480n, 0, { firstFrame: 1480n, frameCount: 480, droppedFrames: 0 }), false)
    // Forward jump: the daemon ring dropped frames while the reader stalled;
    // the queued prefix is no longer contiguous with the cursor.
    assert.equal(syncAudioNeedsReset(1480n, 0, { firstFrame: 2440n, frameCount: 480, droppedFrames: 480 }), true)
    // Drop count advance without a cursor change.
    assert.equal(syncAudioNeedsReset(1960n, 0, { firstFrame: 1960n, frameCount: 480, droppedFrames: 5 }), true)
    // Stream restart (firstFrame moves backward): reset.
    assert.equal(syncAudioNeedsReset(1480n, 0, { firstFrame: 480n, frameCount: 480, droppedFrames: 0 }), true)
})

test('a sustained run of drops keeps audio and meters flowing through the real worklet', { timeout: 1000 }, () => {
    // Drive the documented read-loop protocol (reset on any discontinuity,
    // then the fresh packet) into the real sync-audio-bridge processor while
    // the daemon ring drops frames on every exchange, as happens in a
    // renderer-stalled container. The bridge must keep emitting fresh frames
    // (meters rise) and must never replay frames from before a discontinuity.
    const Bridge = processors.get('sync-audio-bridge')
    const readExchange = (bridge, cursor, firstFrame, drops) => {
        const packet = { firstFrame, frameCount: 480, droppedFrames: drops }
        const reset = syncAudioNeedsReset(cursor.nextFrame, cursor.droppedFrames, packet)
        if (reset) bridge.port.onmessage({ data: { reset: true } })
        cursor.nextFrame = firstFrame + 480n
        cursor.droppedFrames = drops
        bridge.enqueue([Float32Array.from({ length: 480 }, (_, index) => Number(firstFrame) + index)])
        const output = new Float32Array(128)
        bridge.process([], [[output]])
        return { reset, output }
    }

    // The stream primes normally (one 480-frame exchange and one 128-frame
    // render quantum per tick), then the reader stalls and every exchange
    // arrives with a forward gap and an advanced drop count.
    const bridge = new Bridge({
        processorOptions: { channelCount: 1, capacity: 16384, prefill: 5760, maxQueuedFrames: 8640 }
    })
    const cursor = { nextFrame: null, droppedFrames: null, resets: 0 }
    for (let packet = 0; packet < 12; packet++) {
        const { reset, output } = readExchange(bridge, cursor, BigInt(packet * 480), 0)
        cursor.resets += reset ? 1 : 0
        if (packet < 11) {
            assert.deepEqual([...output], new Array(128).fill(0), 'start-up prefill must still gate the first frames')
            continue
        }
        // 12 exchanges * 480 frames = 5760 = the prefill: the first released
        // frames are the oldest queued ones, in order.
        assert.deepEqual([...output], Array.from({ length: 128 }, (_, index) => 128 * (packet - 11) + index))
    }
    assert.equal(cursor.resets, 0, 'a continuous prefix must never reset')

    for (let packet = 0; packet < 8; packet++) {
        const firstFrame = BigInt(12 * 480 + packet * 960) // a 480-frame gap per exchange
        const { reset, output } = readExchange(bridge, cursor, firstFrame, 480 * (packet + 1))
        assert.equal(reset, true, 'a forward gap with new drops must reset per the Sync contract')
        // Every rendered frame belongs to the fresh packet, in order — no
        // stale pre-gap sample and no re-prefill silence.
        assert.deepEqual([...output], Array.from({ length: 128 }, (_, index) => Number(firstFrame) + index))
    }

    // The drop storm can also begin before the prefill was ever reached; the
    // first discontinuity still releases the bridge so meters rise.
    const early = new Bridge({
        processorOptions: { channelCount: 1, capacity: 16384, prefill: 5760, maxQueuedFrames: 8640 }
    })
    const earlyCursor = { nextFrame: null, droppedFrames: null, resets: 0 }
    for (let packet = 0; packet < 2; packet++) {
        const { reset, output } = readExchange(early, earlyCursor, BigInt(packet * 480), 0)
        earlyCursor.resets += reset ? 1 : 0
        assert.deepEqual([...output], new Array(128).fill(0))
    }
    assert.equal(earlyCursor.resets, 0)
    const { reset, output } = readExchange(early, earlyCursor, BigInt(2 * 480 + 960), 960)
    assert.equal(reset, true)
    assert.deepEqual([...output], Array.from({ length: 128 }, (_, index) => 1920 + index))
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
            return { capabilities: { providers: RECEIVE_AUDIO_PROVIDERS } }
        },
        async listAudioSources() {
            return [{ id: 'audio_1', name: 'Device 1', channelCount: 2, sampleRate: 48000 }]
        }
    }
}

const RECEIVE_AUDIO_PROVIDERS = [{ id: 'audio', direction: 'receive', available: true, selected: true }]

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
                    return { capabilities: { providers: RECEIVE_AUDIO_PROVIDERS } }
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

test('a send-direction audio provider is not offered as an input device', async () => {
    const store = fakeCredentialStore()
    let listed = 0
    const syncAudio = createSyncAudioInput({
        Client: class {
            constructor() { this.inner = fakeClient({
                async connect() {
                    return { capabilities: { providers: [{ id: 'audio', direction: 'send', available: true, selected: true }] } }
                },
                async listAudioSources() { listed++; return [] }
            }) }
            close() { this.inner.close() }
            pair(name) { return this.inner.pair(name) }
            connect() { return this.inner.connect() }
            listAudioSources() { return this.inner.listAudioSources() }
        },
        credentialStore: store,
        appName: 'Test'
    })
    await assert.rejects(syncAudio.connectSyncAudio(), /supports audio input/)
    assert.equal(listed, 0, 'a send-direction audio provider must not be enumerated as input')
})
