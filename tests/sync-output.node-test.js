import assert from 'node:assert/strict'
import { test } from 'node:test'

const syncOutput = await import('../js/syncOutput.js')

function deferred() {
    let resolve
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
    return { promise, resolve }
}

function welcome(providerIds = ['syphon']) {
    return {
        type: 'welcome',
        protocolVersion: 1,
        version: '0.2.19',
        instanceId: 'sync-test',
        capabilities: {
            send: true,
            receive: false,
            providers: providerIds.map((id) => ({
                id,
                direction: 'send',
                available: true,
                selected: true
            }))
        }
    }
}

function createFixture() {
    const events = []
    const closed = deferred()
    const sender = {
        closed: closed.promise,
        stats: {
            accepted: 2,
            droppedBusy: 1,
            droppedBackpressure: 3,
            sent: 1,
            failed: 0
        },
        configure(descriptor) { events.push(['configure', descriptor]) },
        submit(textureId, timestamp) {
            events.push(['submit', textureId, timestamp])
            return true
        },
        close() {
            events.push('sender close')
            closed.resolve()
        }
    }
    const queue = { close() { events.push('queue close') } }
    let attachedSink
    const renderer = {
        pipeline: { id: 'mixer-pipeline' },
        createFrameExportQueue(options) {
            events.push(['queue', options])
            return queue
        },
        addSink(sink) {
            attachedSink = sink
            sink.configure({
                width: 1280,
                height: 720,
                format: 'rgba8unorm',
                colorSpace: 'srgb',
                alphaMode: 'premultiplied',
                fps: 60
            })
            events.push('sink attached')
            let removed = false
            return () => {
                if (removed) return
                removed = true
                events.push('sink removed')
                sink.close()
            }
        }
    }
    const token = 'a'.repeat(64)
    let clientIndex = 0
    const clients = [
        {
            async pair(name) {
                events.push(['pair', name])
                return { protocolVersion: 1, token }
            },
            close() { events.push('pairing close') }
        },
        {
            async connect() {
                events.push('connect')
                return welcome()
            },
            async createSender(name, options) {
                events.push(['createSender', name, options])
                return sender
            },
            close() { events.push('client close') }
        }
    ]
    const connectionProvider = {
        createClient(options) {
            events.push(['createClient', options])
            return clients[clientIndex++]
        }
    }
    return {
        connectionProvider,
        events,
        get attachedSink() { return attachedSink },
        queue,
        renderer,
        sender
    }
}

test('publishes the Visualize mixer renderer through a bounded Sync sender sink', async () => {
    assert.equal(typeof syncOutput.SyncOutputController, 'function')
    const fixture = createFixture()
    const canvas = { width: 1280, height: 720 }
    const controller = new syncOutput.SyncOutputController({
        renderer: fixture.renderer,
        getCanvas: () => canvas,
        connectionProvider: fixture.connectionProvider,
        clock: { timeOrigin: 1_700_000_000_000 },
        setInterval: () => 1,
        clearInterval: () => {},
        setTimeout: () => 2,
        clearTimeout: () => {}
    })

    await controller.connect()
    await controller.start('Visualize Main')

    assert.equal(controller.state.status, 'sending')
    assert.equal(controller.state.connected, true)
    assert.deepEqual(controller.state.providerIds, ['syphon'])
    assert.equal(controller.state.senderName, 'Visualize Main')
    assert.deepEqual(
        [controller.state.width, controller.state.height, controller.state.fps],
        [1280, 720, 60]
    )
    assert.deepEqual(controller.state.stats, {
        accepted: 2,
        droppedBusy: 1,
        droppedBackpressure: 3,
        sent: 1,
        failed: 0
    })
    assert.deepEqual(fixture.events.find((event) => event[0] === 'pair'), ['pair', 'Visualize'])
    const createSender = fixture.events.find((event) => event[0] === 'createSender')
    assert.equal(createSender[1], 'Visualize Main')
    assert.equal(createSender[2].exportQueue, fixture.queue)
    assert.equal(createSender[2].maxBufferedFrames, 1)
    assert.deepEqual(
        fixture.events.find((event) => event[0] === 'queue'),
        ['queue', { slots: 3 }]
    )

    assert.equal(fixture.attachedSink.submit('mixer-texture', 42), true)
    assert.deepEqual(
        fixture.events.find((event) => event[0] === 'submit'),
        ['submit', 'mixer-texture', 42]
    )

    await controller.stop()
    assert.equal(controller.state.status, 'ready')
    assert.equal(controller.state.connected, false)
    assert.ok(fixture.events.includes('sink removed'))
    assert.ok(fixture.events.includes('sender close'))
    assert.ok(fixture.events.includes('client close'))
})

test('rejects an invalid Sync sender name before allocating renderer resources', async () => {
    assert.equal(typeof syncOutput.SyncOutputController, 'function')
    const fixture = createFixture()
    const controller = new syncOutput.SyncOutputController({
        renderer: fixture.renderer,
        getCanvas: () => ({ width: 1280, height: 720 }),
        connectionProvider: fixture.connectionProvider
    })
    await controller.connect()

    for (const invalidName of [
        'line\nbreak',
        'zero\u200bwidth',
        'right\u202eto-left'
    ]) {
        await assert.rejects(controller.start(invalidName), {
            code: 'SYNC_INVALID_SENDER_NAME'
        })
    }
    assert.equal(controller.state.status, 'error')
    assert.equal(fixture.events.some((event) => event[0] === 'queue'), false)
    assert.equal(fixture.events.some((event) => event[0] === 'createSender'), false)
})

test('connects when the operator acts as passive discovery becomes ready', async () => {
    const events = []
    const clients = [
        {
            async probe() { return { available: true, health: welcome() } },
            close() { events.push('passive close') }
        },
        {
            async pair(name) {
                events.push(['pair', name])
                return { protocolVersion: 1, token: 'c'.repeat(64) }
            },
            close() { events.push('pairing close') }
        },
        {
            async connect() { return welcome() },
            close() { events.push('client close') }
        }
    ]
    const controller = new syncOutput.SyncOutputController({
        connectionProvider: { createClient: () => clients.shift() }
    })
    let connectPromise
    controller.subscribe((state) => {
        if (state.status === 'ready' && !state.connected && !connectPromise) {
            connectPromise = controller.connect()
        }
    })

    await controller.checkAvailability()
    await connectPromise

    assert.equal(controller.state.connected, true)
    assert.deepEqual(events.find((event) => event[0] === 'pair'), ['pair', 'Visualize'])
})

test('derives actionable target UI for disconnected, connected, and sending states', () => {
    assert.equal(typeof syncOutput.deriveSyncOutputView, 'function')

    assert.deepEqual(syncOutput.deriveSyncOutputView({ status: 'idle' }).action, {
        kind: 'check',
        label: 'Check again',
        disabled: false
    })
    assert.deepEqual(syncOutput.deriveSyncOutputView({
        status: 'unavailable',
        error: {
            code: 'SYNC_PERMISSION_REQUIRED',
            message: 'Loopback network permission requires a user action'
        }
    }).action, {
        kind: 'connect',
        label: 'Connect Sync',
        disabled: false
    })
    const connected = syncOutput.deriveSyncOutputView({
        status: 'ready',
        connected: true,
        providerIds: ['ndi', 'spout']
    })
    assert.deepEqual(connected.action, {
        kind: 'start',
        label: 'Start sending',
        disabled: false
    })
    assert.equal(connected.status, 'Connected to Sync. Start sending when ready.')

    const sending = syncOutput.deriveSyncOutputView({
        status: 'sending',
        connected: true,
        providerIds: ['ndi', 'spout'],
        width: 1920,
        height: 1080,
        fps: 60,
        stats: { sent: 12, droppedBusy: 2, droppedBackpressure: 4, failed: 1 }
    })
    assert.deepEqual(sending.action, {
        kind: 'stop',
        label: 'Stop sending',
        disabled: false
    })
    assert.equal(sending.provider, 'NDI, Spout')
    assert.equal(sending.format, '1920×1080 · 60 fps')
    assert.deepEqual(sending.counters, { sent: 12, gpuBusy: 2, network: 4, failed: 1 })

    const authenticationError = syncOutput.deriveSyncOutputView({
        status: 'error',
        error: {
            code: 'SYNC_AUTHENTICATION',
            message: 'rejected token super-secret-sentinel'
        }
    })
    assert.equal(authenticationError.status, 'Sync rejected this pairing. Connect again to pair this origin.')
    assert.equal(authenticationError.status.includes('super-secret-sentinel'), false)

    const unknownError = syncOutput.deriveSyncOutputView({
        status: 'error',
        error: {
            code: 'SYNC_FUTURE_ERROR',
            message: 'future secret super-secret-sentinel'
        }
    })
    assert.equal(unknownError.status, 'Sync could not continue. Check the companion and try again.')
    assert.equal(unknownError.status.includes('super-secret-sentinel'), false)
})

test('delegates packaged Visualize origin trust to the Sync companion', () => {
    assert.equal(typeof syncOutput.createSyncOutputConnectionProvider, 'function')
    const provider = syncOutput.createSyncOutputConnectionProvider({
        location: { protocol: 'app:', hostname: 'visualize' }
    })
    const client = provider.createClient()
    assert.equal(typeof client.probe, 'function')
    assert.equal(typeof client.connect, 'function')
    client.close()
})
