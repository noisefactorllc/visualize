import test from 'node:test'
import assert from 'node:assert/strict'
import { SyncOutputController, createDefaultSyncConnectionProvider } from '../js/syncOutput.js'

// Regression: the frame export queue reports readback failures through its
// onError handler. The controller must surface repeated failures through the
// existing error state instead of holding the sending state with no traffic.
test('repeated frame export failures surface SYNC_EXPORT_UNAVAILABLE', async () => {
    const closedQueues = []
    const queueOptionsSeen = []
    let exportOnError = null
    const fakeQueue = {
        configure() {},
        get available() { return true },
        enqueue() { return true },
        poll() {},
        close() { closedQueues.push('export-queue') }
    }
    const sinkRemovals = []
    const senderClosures = []
    const canvas = { width: 640, height: 360 }
    const renderer = {
        pipeline: {},
        addSink() { return () => sinkRemovals.push('removed') },
        createFrameExportQueue(options) {
            queueOptionsSeen.push(options)
            exportOnError = options.onError
            return fakeQueue
        }
    }
    const sender = {
        id: 'sender-1',
        configure() {},
        submit() {},
        deferRender() { return false },
        close() { senderClosures.push('sender') },
        closed: new Promise(() => {}),
        stats: { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 }
    }
    const clients = []
    const connectionProvider = {
        credentialStore: {
            current: () => ({ token: 't' }),
            publish: (credential) => credential,
            clear: () => {}
        },
        createClient() {
            const client = {
                async connect() {
                    return { version: '0.3.3', capabilities: { providers: [{
                        id: 'test', direction: 'send', available: true, selected: true
                    }] } }
                },
                async createSender() { return sender },
                close() { clients.push('closed') }
            }
            return client
        }
    }

    const controller = new SyncOutputController({
        renderer,
        getCanvas: () => canvas,
        connectionProvider,
        setInterval() { return 0 },
        clearInterval() {},
        setTimeout() { return 0 },
        clearTimeout() {}
    })

    await controller.connect()
    await controller.start('Visualize native receiver')
    assert.equal(controller.state.status, 'sending')
    assert.equal(typeof exportOnError, 'function', 'queue must receive an onError handler')

    exportOnError(new Error('Failed to execute mapAsync: readback failed'))
    exportOnError(new Error('Failed to execute mapAsync: readback failed'))
    assert.equal(controller.state.status, 'sending',
        'a single failed readback must not end the output')

    exportOnError(new Error('Failed to execute mapAsync: readback failed'))
    assert.equal(controller.state.status, 'error')
    assert.equal(controller.state.error?.code, 'SYNC_EXPORT_UNAVAILABLE')
    assert.equal(controller.state.error?.message,
        'The active graphics backend cannot export frames for Sync: Failed to execute mapAsync: readback failed')
    assert.equal(clients.includes('closed'), true, 'the client must be released')
    assert.equal(sinkRemovals.length, 1, 'the sink must be removed')
    assert.deepEqual(senderClosures, ['sender'], 'the live sender must be closed on the terminal export failure')
    assert.deepEqual(closedQueues, ['export-queue'], 'the live export queue must be closed on the terminal export failure')
})

// A burst of completed frames between isolated failures must keep the
// output sending: the streak only counts failures with no traffic between.
test('completed sends reset the export failure streak', async () => {
    let exportOnError = null
    const fakeQueue = {
        configure() {},
        get available() { return true },
        enqueue() { return true },
        poll() {},
        close() {}
    }
    const canvas = { width: 640, height: 360 }
    const sender = {
        id: 'sender-1',
        configure() {},
        submit() {},
        deferRender() { return false },
        close() {},
        closed: new Promise(() => {}),
        stats: { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 }
    }
    const controller = new SyncOutputController({
        renderer: {
            pipeline: {},
            addSink: () => () => {},
            createFrameExportQueue(options) { exportOnError = options.onError; return fakeQueue }
        },
        getCanvas: () => canvas,
        connectionProvider: createDefaultSyncConnectionProvider({
            credentialStore: {
                current: () => ({ token: 't' }), publish: (c) => c, clear: () => {}
            },
            transport: {}
        }),
        setInterval() { return 0 },
        clearInterval() {},
        setTimeout() { return 0 },
        clearTimeout() {}
    })
    // Replace the real SDK client with a fake that never fails.
    controller._connectionProvider = {
        credentialStore: controller._connectionProvider.credentialStore,
        createClient: () => ({
            async connect() {
                return { version: '0.3.3', capabilities: { providers: [{
                    id: 'test', direction: 'send', available: true, selected: true
                }] } }
            },
            async createSender() { return sender },
            close() {}
        })
    }

    await controller.connect()
    await controller.start('Visualize native receiver')
    assert.equal(controller.state.status, 'sending')

    exportOnError(new Error('readback failed'))
    exportOnError(new Error('readback failed'))
    // Traffic resumed: the stats refresh sees sent advance and clears the streak.
    sender.stats.sent = 1
    controller._refreshStats(controller._liveGeneration)
    exportOnError(new Error('readback failed'))
    assert.equal(controller.state.status, 'sending')

    exportOnError(new Error('readback failed'))
    exportOnError(new Error('readback failed'))
    assert.equal(controller.state.status, 'error')
    assert.equal(controller.state.error?.code, 'SYNC_EXPORT_UNAVAILABLE')
})

// Failures that interleave with continuing traffic inside one stats interval
// must never end a healthy output: the error handler itself must observe the
// completed frames, not wait for the next 250 ms tick.
test('errors between completed sends inside one stats interval keep the output sending', async () => {
    let exportOnError = null
    const fakeQueue = {
        configure() {},
        get available() { return true },
        enqueue() { return true },
        poll() {},
        close() {}
    }
    const canvas = { width: 640, height: 360 }
    const sender = {
        id: 'sender-1',
        configure() {},
        submit() {},
        deferRender() { return false },
        close() {},
        closed: new Promise(() => {}),
        stats: { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 }
    }
    const controller = new SyncOutputController({
        renderer: {
            pipeline: {},
            addSink: () => () => {},
            createFrameExportQueue(options) { exportOnError = options.onError; return fakeQueue }
        },
        getCanvas: () => canvas,
        connectionProvider: createDefaultSyncConnectionProvider({
            credentialStore: {
                current: () => ({ token: 't' }), publish: (c) => c, clear: () => {}
            },
            transport: {}
        }),
        // The stats tick never fires in this test: every reset must come
        // from the error handler observing completed sends.
        setInterval() { return 0 },
        clearInterval() {},
        setTimeout() { return 0 },
        clearTimeout() {}
    })
    controller._connectionProvider = {
        credentialStore: controller._connectionProvider.credentialStore,
        createClient: () => ({
            async connect() {
                return { version: '0.3.3', capabilities: { providers: [{
                    id: 'test', direction: 'send', available: true, selected: true
                }] } }
            },
            async createSender() { return sender },
            close() {}
        })
    }

    await controller.connect()
    await controller.start('Visualize native receiver')
    assert.equal(controller.state.status, 'sending')

    // Errors and completed frames alternate within one stats interval.
    exportOnError(new Error('readback failed'))
    sender.stats.sent = 1
    exportOnError(new Error('readback failed'))
    sender.stats.sent = 2
    exportOnError(new Error('readback failed'))
    sender.stats.sent = 3
    exportOnError(new Error('readback failed'))
    sender.stats.sent = 4
    exportOnError(new Error('readback failed'))
    assert.equal(controller.state.status, 'sending',
        'errors interleaved with completed frames must never end the output')

    // A real stall: repeated errors with no completed frame between them.
    exportOnError(new Error('readback failed'))
    exportOnError(new Error('readback failed'))
    assert.equal(controller.state.status, 'error')
    assert.equal(controller.state.error?.code, 'SYNC_EXPORT_UNAVAILABLE')
})
