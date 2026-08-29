import assert from 'node:assert/strict'
import { test } from 'node:test'

const syncOutput = await import('../js/syncOutput.js')

function deferred() {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

async function flushMicrotasks(turns = 4) {
    for (let turn = 0; turn < turns; turn++) await Promise.resolve()
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

function health(providerIds = ['syphon']) {
    return {
        product: 'Sync',
        status: 'ok',
        version: '0.2.19',
        protocolVersions: [1],
        instanceId: 'sync-test',
        capabilities: welcome(providerIds).capabilities
    }
}

function manualTimers() {
    let nextId = 1
    const intervals = new Map()
    const timeouts = new Map()
    return {
        intervals,
        timeouts,
        setInterval(callback, delay) {
            const id = nextId++
            intervals.set(id, { callback, delay })
            return id
        },
        clearInterval(id) { intervals.delete(id) },
        setTimeout(callback, delay) {
            const id = nextId++
            timeouts.set(id, { callback, delay })
            return id
        },
        clearTimeout(id) { timeouts.delete(id) },
        fireTimeout(delay) {
            const entry = [...timeouts.entries()].find(([, timer]) => timer.delay === delay)
            assert.ok(entry, `expected a ${delay}ms timeout`)
            const [id, timer] = entry
            timeouts.delete(id)
            timer.callback()
        }
    }
}

function senderFixture() {
    const completion = deferred()
    let closeCalls = 0
    let closed = false
    const sender = {
        closed: completion.promise,
        stats: { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 },
        configure() {},
        submit() { return true },
        close() {
            if (closed) return
            closed = true
            closeCalls++
            completion.resolve()
        }
    }
    return {
        sender,
        completion,
        get closeCalls() { return closeCalls }
    }
}

function senderLoss(closeCode, closeReason = '') {
    return Object.assign(new Error('private transport detail'), {
        code: 'SYNC_SENDER_LOST',
        closeCode,
        closeReason
    })
}

function recoveryProbe(result, counters = {}) {
    return {
        async probe() {
            counters.probes = (counters.probes || 0) + 1
            return result
        },
        close() { counters.closes = (counters.closes || 0) + 1 }
    }
}

function recoveryConnection({ sender, providerIds = ['syphon'], pendingConnect, counters = {} }) {
    return {
        async connect() {
            counters.connects = (counters.connects || 0) + 1
            return pendingConnect ? pendingConnect.promise : welcome(providerIds)
        },
        async createSender() {
            counters.senderCreations = (counters.senderCreations || 0) + 1
            return sender
        },
        close() { counters.closes = (counters.closes || 0) + 1 }
    }
}

async function connectedRecoveryFixture({
    renderer,
    canvas = { width: 1280, height: 720 },
    initial = senderFixture(),
    providerIds = ['syphon'],
    recoveryClients = [],
    timers = manualTimers()
} = {}) {
    const stableRenderer = renderer || {
        pipeline: {},
        createFrameExportQueue: () => ({ close() {} }),
        addSink: (sink) => () => sink.close()
    }
    const token = '9'.repeat(64)
    const clients = [
        {
            async pair() { return { protocolVersion: 1, token } },
            close() {}
        },
        {
            async connect() { return welcome(providerIds) },
            async createSender() { return initial.sender },
            close() {}
        },
        ...recoveryClients
    ]
    const calls = []
    const controller = new syncOutput.SyncOutputController({
        renderer: stableRenderer,
        getCanvas: () => canvas,
        connectionProvider: {
            createClient(options) {
                calls.push(options)
                const client = clients.shift()
                if (!client) throw new Error('unexpected Sync client creation')
                return client
            }
        },
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    })
    await controller.connect()
    await controller.start('Recovery source')
    return { controller, initial, calls, renderer: stableRenderer, timers }
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
        'right\u202eto-left',
        'arabic\u061cmark',
        'soft\u00adhyphen',
        'interlinear\ufff9annotation',
        'language\u{e0001}tag'
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

test('dispose closes an in-flight pairing client and prevents a late token from connecting', async () => {
    const pendingPair = deferred()
    let pairingCloses = 0
    let authenticatedCreations = 0
    const controller = new syncOutput.SyncOutputController({
        connectionProvider: {
            createClient(options) {
                if (Object.hasOwn(options, 'token')) {
                    authenticatedCreations++
                    throw new Error('late pairing must not create an authenticated client')
                }
                return {
                    pair: () => pendingPair.promise,
                    close() { pairingCloses++ }
                }
            }
        }
    })

    const connecting = controller.connect()
    await flushMicrotasks()
    controller.dispose()
    controller.dispose()

    assert.equal(pairingCloses, 1)
    pendingPair.resolve({ protocolVersion: 1, token: 'd'.repeat(64) })
    await assert.rejects(connecting, { code: 'SYNC_LIFECYCLE' })
    assert.equal(authenticatedCreations, 0)
    assert.equal(controller.state.connected, false)
})

test('dispose closes an in-flight authenticated client and ignores its late welcome', async () => {
    const pendingWelcome = deferred()
    let authenticatedCloses = 0
    const clients = [
        {
            async pair() { return { protocolVersion: 1, token: 'e'.repeat(64) } },
            close() {}
        },
        {
            connect: () => pendingWelcome.promise,
            close() { authenticatedCloses++ }
        }
    ]
    const controller = new syncOutput.SyncOutputController({
        connectionProvider: { createClient: () => clients.shift() }
    })

    const connecting = controller.connect()
    await flushMicrotasks(8)
    controller.dispose()

    assert.equal(authenticatedCloses, 1)
    pendingWelcome.resolve(welcome())
    await assert.rejects(connecting, { code: 'SYNC_LIFECYCLE' })
    assert.equal(controller.state.connected, false)
})

test('dispose releases a pending start queue and closes the late sender exactly once', async () => {
    const pendingSender = deferred()
    const senderClosed = deferred()
    const canvas = { width: 1280, height: 720 }
    let queueCloses = 0
    let senderCloses = 0
    let clientCloses = 0
    let sinkAttachments = 0
    const sender = {
        closed: senderClosed.promise,
        stats: { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 },
        configure() {},
        submit() { return true },
        close() {
            senderCloses++
            senderClosed.resolve()
        }
    }
    const clients = [
        {
            async pair() { return { protocolVersion: 1, token: 'f'.repeat(64) } },
            close() {}
        },
        {
            async connect() { return welcome() },
            createSender: () => pendingSender.promise,
            close() { clientCloses++ }
        }
    ]
    const controller = new syncOutput.SyncOutputController({
        renderer: {
            pipeline: {},
            createFrameExportQueue: () => ({ close() { queueCloses++ } }),
            addSink() {
                sinkAttachments++
                return () => {}
            }
        },
        getCanvas: () => canvas,
        connectionProvider: { createClient: () => clients.shift() }
    })
    await controller.connect()

    const starting = controller.start('Pending sender')
    await flushMicrotasks()
    controller.dispose()

    assert.equal(queueCloses, 1)
    assert.equal(clientCloses, 1)
    pendingSender.resolve(sender)
    await assert.rejects(starting, { code: 'SYNC_LIFECYCLE' })
    assert.equal(senderCloses, 1)
    assert.equal(sinkAttachments, 0)
    assert.notEqual(controller.state.status, 'sending')
})

test('dispose tears down a live sender once and is idempotent', async () => {
    const fixture = createFixture()
    const canvas = { width: 1280, height: 720 }
    const controller = new syncOutput.SyncOutputController({
        renderer: fixture.renderer,
        getCanvas: () => canvas,
        connectionProvider: fixture.connectionProvider
    })
    await controller.connect()
    await controller.start('Live sender')

    controller.dispose()
    controller.dispose()

    assert.equal(fixture.events.filter((event) => event === 'sink removed').length, 1)
    assert.equal(fixture.events.filter((event) => event === 'sender close').length, 1)
    assert.equal(fixture.events.filter((event) => event === 'client close').length, 1)
    assert.equal(controller.state.connected, false)
    assert.equal(controller.state.senderName, null)
})

test('recovery uses exactly the bounded 250ms, 1000ms, and 4000ms retry budget', async () => {
    const unavailable = () => recoveryProbe({
        available: false,
        code: 'SYNC_UNAVAILABLE',
        message: 'private recovery detail'
    })
    const fixture = await connectedRecoveryFixture({
        recoveryClients: [unavailable(), unavailable(), unavailable()]
    })

    fixture.initial.completion.reject(senderLoss(1006))
    await flushMicrotasks()
    for (const delay of [250, 1000, 4000]) {
        assert.deepEqual([...fixture.timers.timeouts.values()].map((timer) => timer.delay), [delay])
        fixture.timers.fireTimeout(delay)
        await flushMicrotasks(12)
    }

    assert.equal(fixture.controller.state.status, 'error')
    assert.equal(fixture.controller.state.error.code, 'SYNC_RECOVERY_EXHAUSTED')
    assert.equal(fixture.controller.state.error.message.includes('private'), false)
    assert.equal(fixture.calls.length, 5)
    assert.equal(fixture.timers.timeouts.size, 0)
    assert.equal(fixture.timers.intervals.size, 0)
})

test('recovery retains attempts during probation and resets the budget after 60 seconds', async () => {
    const firstReplacement = senderFixture()
    const secondReplacement = senderFixture()
    const fixture = await connectedRecoveryFixture({
        recoveryClients: [
            recoveryProbe({ available: true, health: health() }),
            recoveryConnection({ sender: firstReplacement.sender }),
            recoveryProbe({ available: true, health: health() }),
            recoveryConnection({ sender: secondReplacement.sender })
        ]
    })

    fixture.initial.completion.reject(senderLoss(1006))
    await flushMicrotasks()
    fixture.timers.fireTimeout(250)
    await flushMicrotasks(12)
    assert.deepEqual([...fixture.timers.timeouts.values()].map((timer) => timer.delay), [60_000])

    firstReplacement.completion.reject(senderLoss(1011))
    await flushMicrotasks()
    assert.deepEqual([...fixture.timers.timeouts.values()].map((timer) => timer.delay), [1000])
    fixture.timers.fireTimeout(1000)
    await flushMicrotasks(12)

    fixture.timers.fireTimeout(60_000)
    await flushMicrotasks()
    secondReplacement.completion.reject(senderLoss(1013))
    await flushMicrotasks()
    assert.deepEqual([...fixture.timers.timeouts.values()].map((timer) => timer.delay), [250])
    await fixture.controller.stop()
})

test('recovery rejects provider and renderer replacement without acquiring later resources', async (t) => {
    await t.test('provider replacement', async () => {
        const counters = {}
        const fixture = await connectedRecoveryFixture({
            recoveryClients: [
                recoveryProbe({ available: true, health: health(['ndi', 'syphon']) }, counters)
            ]
        })

        fixture.initial.completion.reject(senderLoss(1006))
        await flushMicrotasks()
        fixture.timers.fireTimeout(250)
        await flushMicrotasks(12)

        assert.equal(fixture.controller.state.status, 'error')
        assert.equal(fixture.controller.state.error.code, 'SYNC_PROVIDER_REPLACED')
        assert.deepEqual(counters, { probes: 1, closes: 1 })
        assert.equal(fixture.calls.length, 3)
    })

    await t.test('renderer replacement', async () => {
        const renderer = {
            pipeline: { id: 'initial' },
            createFrameExportQueue: () => ({ close() {} }),
            addSink: (sink) => () => sink.close()
        }
        const fixture = await connectedRecoveryFixture({
            renderer,
            recoveryClients: [recoveryProbe({ available: true, health: health() })]
        })

        fixture.initial.completion.reject(senderLoss(1006))
        await flushMicrotasks()
        renderer.pipeline = { id: 'replacement' }
        fixture.timers.fireTimeout(250)
        await flushMicrotasks(12)

        assert.equal(fixture.controller.state.status, 'error')
        assert.equal(fixture.controller.state.error.code, 'SYNC_RENDERER_REPLACED')
        assert.equal(fixture.calls.length, 2)
    })
})

test('stopping recovery closes an in-flight connection and late sender resources exactly once', async () => {
    const pendingSender = deferred()
    const replacement = senderFixture()
    let queueNumber = 0
    let recoveryQueueCloses = 0
    let connectionCloses = 0
    const renderer = {
        pipeline: {},
        createFrameExportQueue() {
            queueNumber++
            const number = queueNumber
            return {
                close() {
                    if (number === 2) recoveryQueueCloses++
                }
            }
        },
        addSink: (sink) => () => sink.close()
    }
    const connection = {
        async connect() { return welcome() },
        createSender: () => pendingSender.promise,
        close() { connectionCloses++ }
    }
    const fixture = await connectedRecoveryFixture({
        renderer,
        recoveryClients: [
            recoveryProbe({ available: true, health: health() }),
            connection
        ]
    })

    fixture.initial.completion.reject(senderLoss(1006))
    await flushMicrotasks()
    fixture.timers.fireTimeout(250)
    await flushMicrotasks(12)
    await fixture.controller.stop()

    assert.equal(recoveryQueueCloses, 1)
    assert.equal(connectionCloses, 1)
    pendingSender.resolve(replacement.sender)
    await flushMicrotasks(12)
    assert.equal(replacement.closeCalls, 1)
    assert.equal(fixture.controller.state.status, 'ready')
    assert.equal(fixture.timers.timeouts.size, 0)
    assert.equal(fixture.timers.intervals.size, 0)
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

test('default connection provider injects only external transport beneath each real client', () => {
    const constructions = []
    class RecordingClient {
        constructor(options) { constructions.push(options) }
    }
    const transport = {
        fetch: async () => {},
        WebSocket: class {},
        permissions: null
    }
    const provider = syncOutput.createDefaultSyncConnectionProvider({
        Client: RecordingClient,
        transport
    })
    const token = '7'.repeat(64)

    provider.createClient({ token })

    assert.deepEqual(constructions, [{ ...transport, token }])
})
