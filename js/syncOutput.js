import { SyncBridgeClient } from './sync/bundle.js'

const MAX_SENDER_NAME_BYTES = 64
const RGBA8_BYTES_PER_PIXEL = 4
const MAX_V1_PAYLOAD_BYTES = 0xffffffff
const STATS_INTERVAL_MS = 250
const STOP_TIMEOUT_MS = 3000
const RECOVERY_DELAYS_MS = Object.freeze([250, 1000, 4000])
const RECOVERY_PROBATION_MS = 60_000
const RECOVERY_CANCELLED = Symbol('sync recovery cancelled')
const textEncoder = new TextEncoder()
const FORMATTING_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u
const EMPTY_STATS = Object.freeze({
    accepted: 0,
    droppedBusy: 0,
    droppedBackpressure: 0,
    sent: 0,
    failed: 0
})
const EMPTY_PROVIDER_IDS = Object.freeze([])
const INITIAL_STATE = Object.freeze({
    status: 'idle',
    available: null,
    connected: false,
    providerIds: EMPTY_PROVIDER_IDS,
    senderName: null,
    width: null,
    height: null,
    fps: 60,
    stats: EMPTY_STATS,
    error: null
})

export function createDefaultSyncConnectionProvider({ Client = SyncBridgeClient } = {}) {
    if (typeof Client !== 'function') {
        throw new TypeError('Client must be a constructor')
    }
    return Object.freeze({
        createClient(options = {}) {
            return new Client(options)
        }
    })
}

export function createSyncOutputConnectionProvider({
    connectionProvider
} = {}) {
    if (connectionProvider !== undefined) return connectionProvider
    return createDefaultSyncConnectionProvider()
}

function publicError(code, message) {
    return Object.freeze({
        code: typeof code === 'string' && code ? code : 'SYNC_UNAVAILABLE',
        message: typeof message === 'string' && message ? message : 'Sync is unavailable'
    })
}

function outputError(code, message, options = {}) {
    const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause })
    error.name = 'SyncOutputError'
    error.code = code
    return error
}

function rendererReplacedError(options = {}) {
    return outputError(
        'SYNC_RENDERER_REPLACED',
        'Renderer backend or context was replaced; start Sync output again',
        options
    )
}

function isWellFormedUnicode(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++index)
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false
        }
    }
    return true
}

function hasControlCharacter(value) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
    }
    return false
}

function validateSenderName(name) {
    if (typeof name !== 'string' || name.length === 0 || !isWellFormedUnicode(name) ||
        textEncoder.encode(name).byteLength > MAX_SENDER_NAME_BYTES ||
        hasControlCharacter(name) || FORMATTING_CHARACTERS.test(name)) {
        throw outputError(
            'SYNC_INVALID_SENDER_NAME',
            'Sender name must be 1-64 UTF-8 bytes without control or formatting characters'
        )
    }
}

function validateDescriptor(descriptor) {
    if (!descriptor || !Number.isSafeInteger(descriptor.width) || descriptor.width <= 0 ||
        !Number.isSafeInteger(descriptor.height) || descriptor.height <= 0 ||
        typeof descriptor.fps !== 'number' || !Number.isFinite(descriptor.fps) ||
        descriptor.fps <= 0) {
        throw outputError('SYNC_RENDERER_UNAVAILABLE', 'Renderer output dimensions are unavailable')
    }
    const payloadBytes = descriptor.width * descriptor.height * RGBA8_BYTES_PER_PIXEL
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > MAX_V1_PAYLOAD_BYTES) {
        throw outputError('SYNC_RENDERER_UNAVAILABLE', 'Renderer output dimensions exceed Sync v1 limits')
    }
    return Object.freeze({ ...descriptor })
}

function validateSender(sender) {
    if (!sender || typeof sender.configure !== 'function' ||
        typeof sender.submit !== 'function' || typeof sender.close !== 'function' ||
        !sender.closed || typeof sender.closed.then !== 'function' ||
        !sender.stats || typeof sender.stats !== 'object') {
        throw outputError('SYNC_SENDER_INVALID', 'Sync returned an invalid sender sink')
    }
}

function createConfiguredSink(sender, onConfigured) {
    return Object.freeze({
        configure(descriptor) {
            const configuredDescriptor = validateDescriptor(descriptor)
            const result = sender.configure(configuredDescriptor)
            onConfigured(configuredDescriptor)
            return result
        },
        submit(texture, timestamp) {
            return sender.submit(texture, timestamp)
        },
        close(options) {
            return sender.close(options)
        }
    })
}

/**
 * Every selected, available send provider id, in a stable (sorted) order so
 * set equality and display are deterministic. Windows can report more than
 * one at once (e.g. Spout and NDI publishing the same output); macOS today
 * reports at most one (Syphon). Returns an empty array when none qualify.
 */
function selectedSendProviderIds(health) {
    const providers = health?.capabilities?.providers
    if (!Array.isArray(providers)) return EMPTY_PROVIDER_IDS
    const ids = providers
        .filter((provider) => (
            provider?.direction === 'send' &&
            provider.available === true &&
            provider.selected === true &&
            typeof provider.id === 'string' &&
            provider.id.length > 0
        ))
        .map((provider) => provider.id)
        .sort()
    return Object.freeze(ids)
}

function sameProviderIdSet(left, right) {
    return Array.isArray(left) && Array.isArray(right) &&
        left.length === right.length &&
        left.every((id, index) => id === right[index])
}

function descriptorsMatch(left, right) {
    if (!left || !right) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index] && Object.is(left[key], right[key]))
}

function isRetryableRecoveryError(error) {
    if (error?.code === 'SYNC_UNAVAILABLE' || error?.code === 'SYNC_TIMEOUT' ||
        error?.code === 'SYNC_LIFECYCLE') {
        return true
    }
    if (error?.code !== 'SYNC_SENDER_LOST') return false
    const closeCode = Number.isInteger(error.closeCode) ? error.closeCode : null
    return closeCode === null || closeCode === 1005 || closeCode === 1006 || closeCode === 1011 ||
        closeCode === 1013 ||
        (closeCode === 1008 && error.closeReason === 'incomplete_frame_timeout')
}

function fixedRecoveryError(error) {
    const messages = Object.freeze({
        SYNC_AUTHENTICATION: 'Sync authentication failed; connect again to pair',
        SYNC_PERMISSION_REQUIRED: 'Loopback permission requires an explicit reconnect',
        SYNC_PERMISSION_DENIED: 'Loopback permission was denied; reconnect after allowing access',
        SYNC_PROVIDER_UNAVAILABLE: 'Sync has no selected available send providers',
        SYNC_PROVIDER_REPLACED: 'The set of selected Sync providers changed; connect and start again',
        SYNC_PROTOCOL: 'Sync returned an invalid recovery response; connect and start again',
        SYNC_CAPABILITY: 'Sync no longer exposes the required sender capability',
        SYNC_CONFIGURATION: 'Sync recovery configuration is invalid',
        SYNC_RENDERER_REPLACED: 'Renderer backend or context was replaced; start Sync output again',
        SYNC_SENDER_CLOSED: 'Sync sender connection closed; connect and start again'
    })
    const originalCode = typeof error?.code === 'string' ? error.code : 'SYNC_SENDER_CLOSED'
    const code = originalCode === 'SYNC_SENDER_LOST' ? 'SYNC_SENDER_CLOSED' : originalCode
    return publicError(
        code,
        messages[code] || 'Sync output stopped after a non-recoverable connection failure'
    )
}

export class SyncOutputController {
    constructor({
        renderer = null,
        getCanvas = () => null,
        getDescriptor,
        connectionProvider = createDefaultSyncConnectionProvider(),
        clock = globalThis.performance,
        setInterval: setIntervalImplementation = globalThis.setInterval,
        clearInterval: clearIntervalImplementation = globalThis.clearInterval,
        setTimeout: setTimeoutImplementation = globalThis.setTimeout,
        clearTimeout: clearTimeoutImplementation = globalThis.clearTimeout,
        onStateChange = () => {}
    } = {}) {
        if (!connectionProvider || typeof connectionProvider.createClient !== 'function') {
            throw new TypeError('connectionProvider must expose createClient(options)')
        }
        if (typeof onStateChange !== 'function') {
            throw new TypeError('onStateChange must be a function')
        }
        if (typeof getCanvas !== 'function') throw new TypeError('getCanvas must be a function')
        if (getDescriptor !== undefined && typeof getDescriptor !== 'function') {
            throw new TypeError('getDescriptor must be a function')
        }

        this._renderer = renderer
        this._getCanvas = getCanvas
        this._getDescriptor = getDescriptor
        this._connectionProvider = connectionProvider
        this._clock = clock
        this._setInterval = (...args) => Reflect.apply(setIntervalImplementation, globalThis, args)
        this._clearInterval = (...args) => Reflect.apply(clearIntervalImplementation, globalThis, args)
        this._setTimeout = (...args) => Reflect.apply(setTimeoutImplementation, globalThis, args)
        this._clearTimeout = (...args) => Reflect.apply(clearTimeoutImplementation, globalThis, args)
        this._listeners = new Set([onStateChange])
        this._state = INITIAL_STATE
        this._operation = null
        this._passiveOperation = null
        this._token = undefined
        this._client = null
        this._welcome = null
        this._sender = null
        this._removeSink = null
        this._statsTimer = null
        this._liveGeneration = 0
        this._stoppingGeneration = 0
        this._liveCanvas = null
        this._liveDescriptor = null
        this._livePipeline = null
        this._recoveryGeneration = 0
        this._recoveryAttempts = 0
        this._recoveryTimer = null
        this._recoveryProbationTimer = null
        this._recoveryContext = null
        this._recoveryResources = null
    }

    get state() {
        return this._state
    }

    subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function')
        this._listeners.add(listener)
        try { listener(this._state) } catch {
            // View listeners are isolated from controller ownership.
        }
        let subscribed = true
        return () => {
            if (!subscribed) return
            subscribed = false
            this._listeners.delete(listener)
        }
    }

    checkAvailability() {
        if (this._state.status === 'recovering') return Promise.resolve(this._state)
        if (this._operation) return this._operation
        if (this._client || this._sender) return Promise.resolve(this._state)

        this._setState({
            status: 'checking',
            available: null,
            connected: false,
            providerIds: EMPTY_PROVIDER_IDS,
            error: null
        })

        const operation = this._runPassiveCheck()
        const tracked = operation.finally(() => {
            if (this._operation === tracked) this._operation = null
            if (this._passiveOperation === tracked) this._passiveOperation = null
        })
        this._operation = tracked
        this._passiveOperation = tracked
        return tracked
    }

    connect() {
        if (this._state.status === 'recovering') return Promise.resolve(this._state)
        if (this._operation) {
            const operation = this._operation
            return operation === this._passiveOperation
                ? operation.then(() => this.connect())
                : operation
        }
        if (this._client) return Promise.resolve(this._state)

        this._setState({
            status: 'checking',
            available: null,
            connected: false,
            providerIds: EMPTY_PROVIDER_IDS,
            error: null
        })

        const operation = this._runExplicitConnect()
        const tracked = operation.finally(() => {
            if (this._operation === tracked) this._operation = null
        })
        this._operation = tracked
        return tracked
    }

    start(name) {
        if (this._state.status === 'recovering') return Promise.resolve(this._state)
        if (this._operation) return this._operation
        if (this._state.status === 'sending') return Promise.resolve(this._state)

        try {
            validateSenderName(name)
        } catch (error) {
            this._setState({
                status: 'error',
                error: publicError(error.code, error.message)
            })
            return Promise.reject(error)
        }

        const operation = this._runStart(name)
        const tracked = operation.finally(() => {
            if (this._operation === tracked) this._operation = null
        })
        this._operation = tracked
        return tracked
    }

    stop() {
        if (this._state.status === 'recovering') {
            this._cancelRecovery({ resetAttempts: true })
            this._setState({
                status: 'ready',
                connected: false,
                senderName: null,
                error: null
            })
            return Promise.resolve(this._state)
        }
        if (this._operation) return this._operation
        if (this._state.status !== 'sending' || !this._sender) {
            return Promise.resolve(this._state)
        }

        const generation = this._liveGeneration
        this._stoppingGeneration = generation
        this._setState({ status: 'stopping', error: null })

        const operation = this._runStop(generation)
        const tracked = operation.finally(() => {
            if (this._operation === tracked) this._operation = null
        })
        this._operation = tracked
        return tracked
    }

    async _runPassiveCheck() {
        let client
        try {
            client = await this._connectionProvider.createClient({})
            if (!client || typeof client.probe !== 'function' || typeof client.close !== 'function') {
                throw new TypeError('connectionProvider client must expose probe() and close()')
            }

            const result = await client.probe()
            if (result?.available === true) {
                const providerIds = selectedSendProviderIds(result.health)
                if (providerIds.length > 0) {
                    this._setState({
                        status: 'ready',
                        available: true,
                        connected: false,
                        providerIds,
                        error: null
                    })
                    return this._state
                }
                this._setState({
                    status: 'unavailable',
                    available: true,
                    connected: false,
                    providerIds: EMPTY_PROVIDER_IDS,
                    error: publicError(
                        'SYNC_PROVIDER_UNAVAILABLE',
                        'Sync has no selected available send providers'
                    )
                })
                return this._state
            }

            this._setState({
                status: 'unavailable',
                available: false,
                connected: false,
                providerIds: EMPTY_PROVIDER_IDS,
                error: publicError(result?.code, result?.message)
            })
            return this._state
        } catch (error) {
            this._setState({
                status: 'unavailable',
                available: false,
                connected: false,
                providerIds: EMPTY_PROVIDER_IDS,
                error: publicError(error?.code, error?.message)
            })
            return this._state
        } finally {
            try {
                client?.close()
            } catch {
                // Passive discovery has no retained resource to recover.
            }
        }
    }

    async _runExplicitConnect() {
        let client
        try {
            if (this._token === undefined) {
                this._token = await this._pair()
            }

            client = await this._connectionProvider.createClient({ token: this._token })
            if (!client || typeof client.connect !== 'function' || typeof client.close !== 'function') {
                throw new TypeError('authenticated Sync client must expose connect() and close()')
            }

            const welcome = await client.connect()
            const providerIds = selectedSendProviderIds(welcome)
            if (providerIds.length === 0) {
                const error = new Error('Sync has no selected available send providers')
                error.code = 'SYNC_PROVIDER_UNAVAILABLE'
                throw error
            }

            this._client = client
            this._welcome = welcome
            this._setState({
                status: 'ready',
                available: true,
                connected: true,
                providerIds,
                error: null
            })
            return this._state
        } catch (error) {
            try {
                client?.close()
            } catch {
                // The connection failure remains the actionable error.
            }
            let reportedError = error
            if (error?.code === 'SYNC_AUTHENTICATION') {
                this._token = undefined
                reportedError = outputError(
                    'SYNC_AUTHENTICATION',
                    'Sync authentication failed; connect again to pair'
                )
            }
            this._client = null
            this._welcome = null
            this._setState({
                status: 'error',
                available: error?.code !== 'SYNC_UNAVAILABLE',
                connected: false,
                providerIds: EMPTY_PROVIDER_IDS,
                error: publicError(reportedError?.code, reportedError?.message)
            })
            throw reportedError
        }
    }

    async _pair() {
        let pairingClient
        try {
            pairingClient = await this._connectionProvider.createClient({})
            if (!pairingClient || typeof pairingClient.pair !== 'function' ||
                typeof pairingClient.close !== 'function') {
                throw new TypeError('pairing Sync client must expose pair() and close()')
            }
            const result = await pairingClient.pair('Visualize')
            if (!result || typeof result.token !== 'string' || result.token.length === 0) {
                const error = new Error('Sync pairing did not return a token')
                error.code = 'SYNC_PROTOCOL'
                throw error
            }
            return result.token
        } finally {
            try {
                pairingClient?.close()
            } catch {
                // Pairing-client shutdown must not retain the client or replace the result.
            }
        }
    }

    async _runStart(name) {
        let queue
        let sender
        let removeSink
        let configuredDescriptor
        let sinkGeneration = null
        try {
            if (!this._client || !this._welcome) {
                throw outputError('SYNC_NOT_CONNECTED', 'Connect Sync before starting an output')
            }
            if (typeof this._renderer?.createFrameExportQueue !== 'function' ||
                typeof this._renderer?.addSink !== 'function') {
                throw outputError(
                    'SYNC_RENDERER_UNAVAILABLE',
                    'This renderer does not support Sync output'
                )
            }
            const providerIds = selectedSendProviderIds(this._welcome)
            if (providerIds.length === 0) {
                throw outputError(
                    'SYNC_PROVIDER_UNAVAILABLE',
                    'Sync has no selected available send providers'
                )
            }
            if (typeof this._client.createSender !== 'function') {
                throw outputError('SYNC_CLIENT_INVALID', 'Sync client cannot create senders')
            }

            const liveCanvas = this._getCanvas()
            const descriptor = this._readDescriptor(liveCanvas)
            this._setState({
                status: 'starting',
                available: true,
                connected: true,
                providerIds,
                senderName: name,
                width: descriptor.width,
                height: descriptor.height,
                fps: descriptor.fps,
                stats: EMPTY_STATS,
                error: null
            })

            const rendererIdentity = this._captureRendererIdentity(liveCanvas, descriptor)
            queue = this._renderer.createFrameExportQueue({ slots: 3 })
            if (!queue) {
                throw outputError(
                    'SYNC_EXPORT_UNAVAILABLE',
                    'The active renderer backend cannot export frames'
                )
            }
            if (typeof queue.close !== 'function') {
                throw outputError('SYNC_EXPORT_UNAVAILABLE', 'Renderer returned an invalid export queue')
            }

            sender = await this._client.createSender(name, {
                exportQueue: queue,
                maxBufferedFrames: 1,
                clock: this._clock
            })
            validateSender(sender)
            this._assertRendererIdentity(rendererIdentity)

            configuredDescriptor = descriptor
            const sink = createConfiguredSink(sender, (nextDescriptor) => {
                configuredDescriptor = nextDescriptor
                if (sinkGeneration !== null) {
                    this._sinkConfigured(sender, sinkGeneration, nextDescriptor)
                }
            })
            removeSink = this._renderer.addSink(sink)
            if (typeof removeSink !== 'function') {
                throw outputError('SYNC_RENDERER_UNAVAILABLE', 'Renderer did not return a sink removal handle')
            }

            const generation = ++this._liveGeneration
            sinkGeneration = generation
            this._sender = sender
            this._removeSink = removeSink
            this._liveCanvas = liveCanvas
            this._liveDescriptor = configuredDescriptor
            this._livePipeline = rendererIdentity.pipeline
            this._statsTimer = this._setInterval(
                () => this._refreshStats(generation),
                STATS_INTERVAL_MS
            )
            this._resetRecoveryBudget()
            this._monitorSenderClosed(sender, generation)

            this._setState({
                status: 'sending',
                width: configuredDescriptor.width,
                height: configuredDescriptor.height,
                fps: configuredDescriptor.fps,
                stats: this._copyStats(sender.stats),
                error: null
            })
            return this._state
        } catch (error) {
            this._clearStatsTimer()
            if (typeof removeSink === 'function') {
                try { removeSink() } catch {
                    // The start failure remains the actionable error.
                }
            } else if (sender && typeof sender.close === 'function') {
                try { sender.close() } catch {
                    // Sender ownership supersedes direct queue cleanup.
                }
            } else if (queue && typeof queue.close === 'function') {
                try { queue.close() } catch {
                    // The start failure remains the actionable error.
                }
            }
            this._sender = null
            this._removeSink = null
            this._liveCanvas = null
            this._liveDescriptor = null
            this._livePipeline = null
            this._closeClient()
            const code = typeof error?.code === 'string' ? error.code : 'SYNC_START_FAILED'
            this._setState({
                status: 'error',
                connected: false,
                error: publicError(code, error?.message)
            })
            throw error
        }
    }

    async _runStop(generation) {
        const sender = this._sender
        const removeSink = this._removeSink
        let firstError

        this._clearStatsTimer()
        this._removeSink = null
        try {
            removeSink()
        } catch (error) {
            firstError = error
            try { sender.close() } catch {
                // The renderer removal failure remains the first actionable error.
            }
        }

        try {
            await this._waitForSenderClosed(sender.closed)
        } catch (error) {
            if (!firstError) firstError = error
        }

        const clientError = this._releaseClient()
        if (!firstError && clientError) firstError = clientError
        this._invalidateLiveSession(generation)
        this._resetRecoveryBudget()

        if (firstError) {
            const code = typeof firstError.code === 'string' ? firstError.code : 'SYNC_STOP_FAILED'
            this._setState({
                status: 'error',
                connected: false,
                senderName: null,
                error: publicError(code, firstError.message)
            })
            throw firstError
        }

        this._setState({
            status: 'ready',
            available: true,
            connected: false,
            senderName: null,
            error: null
        })
        return this._state
    }

    _readDescriptor(canvas = this._getCanvas()) {
        if (this._getDescriptor) return validateDescriptor(this._getDescriptor())
        return validateDescriptor({
            width: canvas?.width,
            height: canvas?.height,
            format: 'rgba8unorm',
            colorSpace: 'srgb',
            alphaMode: 'premultiplied',
            fps: 60
        })
    }

    _captureRendererIdentity(canvas, descriptor) {
        try {
            return Object.freeze({
                pipeline: this._renderer.pipeline,
                canvas,
                width: descriptor.width,
                height: descriptor.height
            })
        } catch (cause) {
            throw rendererReplacedError({ cause })
        }
    }

    _assertRendererIdentity(identity) {
        try {
            const canvas = this._getCanvas()
            if (this._renderer.pipeline !== identity.pipeline || canvas !== identity.canvas ||
                canvas?.width !== identity.width || canvas?.height !== identity.height) {
                throw rendererReplacedError()
            }
        } catch (error) {
            if (error?.code === 'SYNC_RENDERER_REPLACED') throw error
            throw rendererReplacedError({ cause: error })
        }
    }

    _copyStats(stats) {
        return Object.freeze({ ...stats })
    }

    _refreshStats(generation) {
        if (generation !== this._liveGeneration || this._state.status !== 'sending' || !this._sender) {
            return
        }
        this._setState({ stats: this._copyStats(this._sender.stats) })
    }

    _sinkConfigured(sender, generation, descriptor) {
        if (generation !== this._liveGeneration || sender !== this._sender ||
            this._state.status !== 'sending') {
            return
        }
        this._liveDescriptor = descriptor
        this._setState({
            width: descriptor.width,
            height: descriptor.height,
            fps: descriptor.fps
        })
    }

    _monitorSenderClosed(sender, generation) {
        sender.closed.then(
            () => this._senderEnded(sender, generation),
            (error) => this._senderEnded(sender, generation, error)
        )
    }

    _senderEnded(sender, generation, senderError) {
        if (generation !== this._liveGeneration || sender !== this._sender ||
            generation === this._stoppingGeneration || this._state.status !== 'sending') {
            return
        }

        let rendererReplaced
        try {
            const canvas = this._getCanvas()
            rendererReplaced = this._renderer.pipeline !== this._livePipeline ||
                canvas !== this._liveCanvas ||
                canvas?.width !== this._liveDescriptor?.width ||
                canvas?.height !== this._liveDescriptor?.height
        } catch {
            rendererReplaced = true
        }

        const context = Object.freeze({
            senderName: this._state.senderName,
            providerIds: this._state.providerIds,
            canvas: this._liveCanvas,
            descriptor: this._liveDescriptor,
            pipeline: this._livePipeline
        })
        this._clearStatsTimer()
        this._clearRecoveryProbationTimer()
        const removeSink = this._removeSink
        this._invalidateLiveSession(generation)
        try { removeSink?.() } catch {
            // The unexpected closure is already terminal for this live session.
        }
        this._releaseClient()

        if (!rendererReplaced && isRetryableRecoveryError(senderError)) {
            this._beginRecovery(context)
            return
        }

        const error = rendererReplaced
            ? publicError(
                'SYNC_RENDERER_REPLACED',
                'Renderer backend or context was replaced; start Sync output again'
            )
            : publicError(
                'SYNC_SENDER_CLOSED',
                'Sync sender connection closed; connect and start again'
            )
        this._setState({
            status: 'error',
            connected: false,
            senderName: null,
            error
        })
    }

    _beginRecovery(context) {
        const generation = ++this._recoveryGeneration
        this._recoveryContext = context
        this._setState({
            status: 'recovering',
            available: true,
            connected: false,
            providerIds: context.providerIds,
            senderName: context.senderName,
            width: context.descriptor.width,
            height: context.descriptor.height,
            fps: context.descriptor.fps,
            error: null
        })
        this._scheduleRecoveryAttempt(generation)
    }

    _scheduleRecoveryAttempt(generation) {
        if (!this._isRecoveryCurrent(generation)) return
        if (this._recoveryAttempts >= RECOVERY_DELAYS_MS.length) {
            this._finishRecovery(
                outputError('SYNC_RECOVERY_EXHAUSTED', 'Sync recovery budget was exhausted'),
                { exhausted: true }
            )
            return
        }
        const delay = RECOVERY_DELAYS_MS[this._recoveryAttempts]
        let timerId
        timerId = this._setTimeout(() => {
            this._clearTimeout(timerId)
            if (this._recoveryTimer === timerId) this._recoveryTimer = null
            void this._runRecoveryAttempt(generation)
        }, delay)
        this._recoveryTimer = timerId
    }

    async _runRecoveryAttempt(generation) {
        if (!this._isRecoveryCurrent(generation)) return
        this._recoveryAttempts++
        const context = this._recoveryContext
        const resources = {
            passiveClient: null,
            client: null,
            queue: null,
            sender: null,
            removeSink: null
        }
        this._recoveryResources = resources

        try {
            this._assertRecoveryCurrent(generation)
            this._assertRecoveryRendererIdentity(context)

            resources.passiveClient = await this._connectionProvider.createClient({})
            this._assertRecoveryCurrent(generation)
            if (!resources.passiveClient || typeof resources.passiveClient.probe !== 'function' ||
                typeof resources.passiveClient.close !== 'function') {
                throw outputError('SYNC_PROTOCOL', 'Sync recovery probe client is invalid')
            }
            const result = await resources.passiveClient.probe()
            this._assertRecoveryCurrent(generation)
            if (result?.available !== true) {
                throw outputError(
                    typeof result?.code === 'string' ? result.code : 'SYNC_UNAVAILABLE',
                    'Sync is unavailable during recovery'
                )
            }
            this._assertRecoveryProvider(result.health, context.providerIds)
            try { resources.passiveClient.close() } catch {
                // Recovery owns no state in a completed passive probe.
            }
            resources.passiveClient = null

            this._assertRecoveryCurrent(generation)
            this._assertRecoveryRendererIdentity(context)
            resources.client = await this._connectionProvider.createClient({ token: this._token })
            this._assertRecoveryCurrent(generation)
            if (!resources.client || typeof resources.client.connect !== 'function' ||
                typeof resources.client.createSender !== 'function' ||
                typeof resources.client.close !== 'function') {
                throw outputError('SYNC_PROTOCOL', 'Authenticated Sync recovery client is invalid')
            }
            const welcome = await resources.client.connect()
            this._assertRecoveryCurrent(generation)
            this._assertRecoveryProvider(welcome, context.providerIds)
            this._assertRecoveryRendererIdentity(context)

            resources.queue = this._renderer.createFrameExportQueue({ slots: 3 })
            if (!resources.queue || typeof resources.queue.close !== 'function') {
                throw outputError(
                    'SYNC_EXPORT_UNAVAILABLE',
                    'The active renderer backend cannot export frames'
                )
            }
            resources.sender = await resources.client.createSender(context.senderName, {
                exportQueue: resources.queue,
                maxBufferedFrames: 1,
                clock: this._clock
            })
            this._assertRecoveryCurrent(generation)
            validateSender(resources.sender)
            this._assertRecoveryRendererIdentity(context)

            let configuredDescriptor = context.descriptor
            let sinkGeneration = null
            const sender = resources.sender
            const sink = createConfiguredSink(sender, (descriptor) => {
                configuredDescriptor = descriptor
                if (sinkGeneration !== null) {
                    this._sinkConfigured(sender, sinkGeneration, descriptor)
                }
            })
            resources.removeSink = this._renderer.addSink(sink)
            if (typeof resources.removeSink !== 'function') {
                throw outputError(
                    'SYNC_RENDERER_UNAVAILABLE',
                    'Renderer did not return a sink removal handle'
                )
            }
            this._assertRecoveryCurrent(generation)
            this._assertRecoveryRendererIdentity(context)
            if (!descriptorsMatch(configuredDescriptor, context.descriptor)) {
                throw rendererReplacedError()
            }

            const liveGeneration = ++this._liveGeneration
            sinkGeneration = liveGeneration
            this._client = resources.client
            this._welcome = welcome
            this._sender = resources.sender
            this._removeSink = resources.removeSink
            this._liveCanvas = context.canvas
            this._liveDescriptor = configuredDescriptor
            this._livePipeline = context.pipeline
            resources.client = null
            resources.queue = null
            resources.sender = null
            resources.removeSink = null
            if (this._recoveryResources === resources) this._recoveryResources = null
            this._recoveryContext = null
            this._statsTimer = this._setInterval(
                () => this._refreshStats(liveGeneration),
                STATS_INTERVAL_MS
            )
            this._monitorSenderClosed(this._sender, liveGeneration)
            this._scheduleRecoveryProbation(liveGeneration)
            this._setState({
                status: 'sending',
                available: true,
                connected: true,
                providerIds: context.providerIds,
                senderName: context.senderName,
                width: configuredDescriptor.width,
                height: configuredDescriptor.height,
                fps: configuredDescriptor.fps,
                stats: this._copyStats(this._sender.stats),
                error: null
            })
        } catch (error) {
            this._cleanupRecoveryResources(resources)
            if (!this._isRecoveryCurrent(generation) || error === RECOVERY_CANCELLED) return
            if (isRetryableRecoveryError(error)) {
                if (this._recoveryAttempts < RECOVERY_DELAYS_MS.length) {
                    this._scheduleRecoveryAttempt(generation)
                } else {
                    this._finishRecovery(error, { exhausted: true })
                }
            } else {
                this._finishRecovery(error)
            }
        } finally {
            if (this._recoveryResources === resources) this._recoveryResources = null
        }
    }

    _assertRecoveryProvider(source, expectedProviderIds) {
        const providerIds = selectedSendProviderIds(source)
        if (providerIds.length === 0) {
            throw outputError(
                'SYNC_PROVIDER_UNAVAILABLE',
                'Sync has no selected available send providers'
            )
        }
        if (!sameProviderIdSet(providerIds, expectedProviderIds)) {
            throw outputError('SYNC_PROVIDER_REPLACED', 'The set of selected Sync providers changed')
        }
    }

    _assertRecoveryRendererIdentity(context) {
        try {
            const canvas = this._getCanvas()
            const descriptor = this._readDescriptor(canvas)
            if (this._renderer.pipeline !== context.pipeline || canvas !== context.canvas ||
                !descriptorsMatch(descriptor, context.descriptor)) {
                throw rendererReplacedError()
            }
        } catch (error) {
            if (error?.code === 'SYNC_RENDERER_REPLACED') throw error
            throw rendererReplacedError({ cause: error })
        }
    }

    _isRecoveryCurrent(generation) {
        return generation === this._recoveryGeneration &&
            this._state.status === 'recovering' && this._recoveryContext !== null
    }

    _assertRecoveryCurrent(generation) {
        if (!this._isRecoveryCurrent(generation)) throw RECOVERY_CANCELLED
    }

    _cleanupRecoveryResources(resources) {
        const removeSink = resources?.removeSink
        if (resources) resources.removeSink = null
        try { removeSink?.() } catch {
            // Continue releasing the remaining off-side resources.
        }

        const sender = resources?.sender
        if (resources) {
            resources.sender = null
            if (sender) resources.queue = null
        }
        try { sender?.close() } catch {
            // Continue releasing the recovery clients.
        }

        const queue = resources?.queue
        if (resources) resources.queue = null
        try { queue?.close() } catch {
            // Continue releasing the recovery clients.
        }

        for (const key of ['passiveClient', 'client']) {
            const client = resources?.[key]
            if (resources) resources[key] = null
            try { client?.close() } catch {
                // Recovery cleanup is best effort across every owned resource.
            }
        }
    }

    _finishRecovery(error, { exhausted = false } = {}) {
        this._recoveryGeneration++
        this._clearRecoveryTimer()
        this._clearRecoveryProbationTimer()
        this._cleanupRecoveryResources(this._recoveryResources)
        this._recoveryResources = null
        this._recoveryContext = null
        this._recoveryAttempts = 0
        if (error?.code === 'SYNC_AUTHENTICATION') this._token = undefined
        this._setState({
            status: 'error',
            available: error?.code !== 'SYNC_UNAVAILABLE',
            connected: false,
            senderName: null,
            error: exhausted
                ? publicError(
                    'SYNC_RECOVERY_EXHAUSTED',
                    'Sync output could not recover after three attempts; connect and start again'
                )
                : fixedRecoveryError(error)
        })
    }

    _cancelRecovery({ resetAttempts = false } = {}) {
        this._recoveryGeneration++
        this._clearRecoveryTimer()
        this._clearRecoveryProbationTimer()
        this._cleanupRecoveryResources(this._recoveryResources)
        this._recoveryResources = null
        this._recoveryContext = null
        if (resetAttempts) this._recoveryAttempts = 0
    }

    _scheduleRecoveryProbation(liveGeneration) {
        this._clearRecoveryProbationTimer()
        let timerId
        timerId = this._setTimeout(() => {
            this._clearTimeout(timerId)
            if (this._recoveryProbationTimer === timerId) this._recoveryProbationTimer = null
            if (liveGeneration === this._liveGeneration && this._state.status === 'sending') {
                this._recoveryAttempts = 0
            }
        }, RECOVERY_PROBATION_MS)
        this._recoveryProbationTimer = timerId
    }

    _clearRecoveryTimer() {
        if (this._recoveryTimer === null) return
        this._clearTimeout(this._recoveryTimer)
        this._recoveryTimer = null
    }

    _clearRecoveryProbationTimer() {
        if (this._recoveryProbationTimer === null) return
        this._clearTimeout(this._recoveryProbationTimer)
        this._recoveryProbationTimer = null
    }

    _resetRecoveryBudget() {
        this._clearRecoveryTimer()
        this._clearRecoveryProbationTimer()
        this._recoveryAttempts = 0
        this._recoveryContext = null
    }

    _waitForSenderClosed(closed) {
        let timeoutId
        const timeout = new Promise((resolve, reject) => {
            timeoutId = this._setTimeout(() => {
                reject(outputError(
                    'SYNC_STOP_TIMEOUT',
                    `Sync sender did not close within ${STOP_TIMEOUT_MS}ms`
                ))
            }, STOP_TIMEOUT_MS)
        })
        return Promise.race([closed, timeout]).finally(() => {
            this._clearTimeout(timeoutId)
        })
    }

    _invalidateLiveSession(generation) {
        if (this._liveGeneration === generation) this._liveGeneration++
        this._stoppingGeneration = 0
        this._sender = null
        this._removeSink = null
        this._liveCanvas = null
        this._liveDescriptor = null
        this._livePipeline = null
    }

    _clearStatsTimer() {
        if (this._statsTimer === null) return
        this._clearInterval(this._statsTimer)
        this._statsTimer = null
    }

    _closeClient() {
        this._releaseClient()
    }

    _releaseClient() {
        const client = this._client
        this._client = null
        this._welcome = null
        if (!client) return null
        try {
            client.close()
            return null
        } catch (error) {
            return error
        }
    }

    _setState(next) {
        const state = { ...this._state, ...next }
        if (next.stats) state.stats = this._copyStats(next.stats)
        this._state = Object.freeze(state)
        for (const listener of this._listeners) {
            try {
                listener(this._state)
            } catch {
                // View listeners cannot take ownership of the controller lifecycle.
            }
        }
    }
}

const PROVIDER_NAMES = Object.freeze({
    syphon: 'Syphon',
    spout: 'Spout',
    ndi: 'NDI'
})

const ERROR_STATUS_MESSAGES = Object.freeze({
    SYNC_PERMISSION_REQUIRED: 'Loopback access is required. Choose Connect Sync so the browser can request it.',
    SYNC_PERMISSION_DENIED: 'Loopback access was denied. Allow it for this site and try again.',
    SYNC_UNAVAILABLE: 'The Sync companion did not respond. Open Sync on this device and check again.',
    SYNC_PAIRING_DENIED: 'Pairing was denied in Sync. Connect again when you are ready to approve this origin.',
    SYNC_PAIRING_BUSY: 'Sync is handling another pairing request. Wait for it to finish and connect again.',
    SYNC_PAIRING_STORE: 'Sync could not save this pairing. Check its storage access and connect again.',
    SYNC_PAIRING_DURABILITY: 'Sync could not confirm durable pairing storage. Resolve its storage warning and connect again.',
    SYNC_PAIRING_ORIGIN_LIMIT: 'Sync has reached its paired-origin limit. Revoke an old origin and connect again.',
    SYNC_TIMEOUT: 'Sync did not respond in time. Check the companion and try again.',
    SYNC_PROVIDER_UNAVAILABLE: 'Sync has no available output provider. Enable Syphon, Spout, or NDI and reconnect.',
    SYNC_PROVIDER_REPLACED: 'Sync output providers changed. Reconnect before starting the sender again.',
    SYNC_RENDERER_UNAVAILABLE: 'The active Noisemaker renderer does not expose the Sync output seam.',
    SYNC_EXPORT_UNAVAILABLE: 'The active graphics backend cannot export frames for Sync.',
    SYNC_AUTHENTICATION: 'Sync rejected this pairing. Connect again to pair this origin.',
    SYNC_RECOVERY_EXHAUSTED: 'Sync could not recover the output after three attempts. Reconnect and start again.',
    SYNC_SENDER_CLOSED: 'The Sync sender closed unexpectedly. Reconnect to create a new sender.',
    SYNC_SENDER_LOST: 'The Sync sender connection was lost. Visualize is trying to recover it.',
    SYNC_RENDERER_REPLACED: 'The graphics backend or context changed. Reconnect before restarting the sender.',
    SYNC_STOP_TIMEOUT: 'The Sync sender did not close in time. Reconnect before starting another output.',
    SYNC_INVALID_SENDER_NAME: 'Use an output name with 1–64 UTF-8 bytes and no control or formatting characters.',
    SYNC_NOT_CONNECTED: 'Connect Sync before starting an output.',
    SYNC_PROTOCOL: 'Sync returned an invalid response. Reconnect and try again.',
    SYNC_CAPABILITY: 'Sync no longer exposes the required output capability.',
    SYNC_CONFIGURATION: 'Sync output configuration is invalid. Reconnect and try again.',
    SYNC_LIFECYCLE: 'The Sync connection closed. Reconnect and try again.',
    SYNC_CLIENT_INVALID: 'The Sync client could not create this output.',
    SYNC_SENDER_INVALID: 'Sync returned an invalid sender. Reconnect and try again.',
    SYNC_START_FAILED: 'Sync could not start this output. Reconnect and try again.',
    SYNC_STOP_FAILED: 'Sync could not stop cleanly. Reconnect before starting another output.'
})

const ACTIONS = Object.freeze({
    check: Object.freeze({ kind: 'check', label: 'Check again', disabled: false }),
    checking: Object.freeze({ kind: 'checking', label: 'Checking…', disabled: true }),
    connect: Object.freeze({ kind: 'connect', label: 'Connect Sync', disabled: false }),
    connecting: Object.freeze({ kind: 'connecting', label: 'Connecting…', disabled: true }),
    start: Object.freeze({ kind: 'start', label: 'Start sending', disabled: false }),
    starting: Object.freeze({ kind: 'starting', label: 'Starting…', disabled: true }),
    stop: Object.freeze({ kind: 'stop', label: 'Stop sending', disabled: false }),
    stopping: Object.freeze({ kind: 'stopping', label: 'Stopping…', disabled: true })
})

function finiteCounter(value) {
    return Number.isFinite(value) && value >= 0 ? value : 0
}

function actionForState(state) {
    switch (state.status) {
    case 'checking': return ACTIONS.checking
    case 'starting': return ACTIONS.starting
    case 'sending':
    case 'recovering': return ACTIONS.stop
    case 'stopping': return ACTIONS.stopping
    case 'ready': return state.connected ? ACTIONS.start : ACTIONS.connect
    case 'error':
        if (state.connected) return ACTIONS.start
        return state.error?.code === 'SYNC_UNAVAILABLE' ? ACTIONS.check : ACTIONS.connect
    case 'unavailable':
        return state.error?.code && state.error.code !== 'SYNC_UNAVAILABLE'
            ? ACTIONS.connect
            : ACTIONS.check
    case 'idle':
    default: return ACTIONS.check
    }
}

function stateLabel(state) {
    switch (state.status) {
    case 'checking': return 'Checking…'
    case 'starting': return 'Starting…'
    case 'sending': return 'Sending'
    case 'recovering': return 'Recovering…'
    case 'stopping': return 'Stopping…'
    case 'ready': return state.connected ? 'Connected' : 'Ready'
    case 'error': return 'Needs attention'
    case 'unavailable':
        return state.error?.code && state.error.code !== 'SYNC_UNAVAILABLE'
            ? 'Needs attention'
            : 'Disconnected'
    case 'idle':
    default: return 'Disconnected'
    }
}

function statusMessage(state) {
    if (state.error) {
        return ERROR_STATUS_MESSAGES[state.error.code] ||
            'Sync could not continue. Check the companion and try again.'
    }
    switch (state.status) {
    case 'checking': return 'Looking for the local Sync companion…'
    case 'starting': return 'Starting the Sync sender…'
    case 'sending': return 'Visualize is publishing through Sync.'
    case 'recovering': return 'Sync lost the sender connection and is recovering…'
    case 'stopping': return 'Stopping the Sync sender…'
    case 'ready':
        return state.connected
            ? 'Connected to Sync. Start sending when ready.'
            : 'Sync is available. Connect to pair Visualize.'
    case 'idle':
    case 'unavailable':
    case 'error':
    default: return 'Sync is not connected.'
    }
}

export function deriveSyncOutputView(state = {}) {
    const providerIds = Array.isArray(state.providerIds)
        ? state.providerIds.filter((id) => typeof id === 'string' && id.length > 0)
        : []
    const width = Number.isSafeInteger(state.width) && state.width > 0 ? state.width : null
    const height = Number.isSafeInteger(state.height) && state.height > 0 ? state.height : null
    const fps = Number.isFinite(state.fps) && state.fps > 0 ? state.fps : 60
    const stats = state.stats || EMPTY_STATS

    return Object.freeze({
        action: actionForState(state),
        stateLabel: stateLabel(state),
        live: state.status === 'sending',
        nameDisabled: ['checking', 'starting', 'sending', 'recovering', 'stopping'].includes(state.status),
        provider: providerIds.length > 0
            ? providerIds.map((id) => PROVIDER_NAMES[id] || id).join(', ')
            : 'No provider',
        format: width && height ? `${width}×${height} · ${fps} fps` : `—×— · ${fps} fps`,
        status: statusMessage(state),
        counters: Object.freeze({
            sent: finiteCounter(stats.sent),
            gpuBusy: finiteCounter(stats.droppedBusy),
            network: finiteCounter(stats.droppedBackpressure),
            failed: finiteCounter(stats.failed)
        })
    })
}
