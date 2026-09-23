import { ALPHA_MODE, COLOR_SPACE, encodeFrameV1, PIXEL_FORMAT } from './sync/bundle.js'

const HEADER_BYTES = 64
const MAX_ACCESS_UNIT_BYTES = 8 * 1024 * 1024
const PACING_DELAY_MS = 60
const MIN_WRITE_GAP_MS = 16
const MAX_PENDING_FRAMES = 12
const ENCODE_TIMEOUT_MS = 2000

function outputError(code, message, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause })
    error.code = code
    return error
}

export function supportsH264CanvasOutput(welcome) {
    if (typeof globalThis.VideoEncoder !== 'function' ||
        typeof globalThis.VideoFrame !== 'function' ||
        typeof globalThis.WebSocketStream !== 'function') return false
    const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(welcome?.version || '')
    if (!version) return false
    const [major, minor, patch] = version.slice(1).map(Number)
    return (major > 0 || minor > 2 || (minor === 2 && patch >= 84)) &&
        welcome?.capabilities?.providers?.some(provider => provider.id === 'syphon' &&
            provider.direction === 'send' && provider.available && provider.selected) === true
}

export class SyncH264CanvasSender {
    static async create({ client, name, canvas, descriptor, clock = performance }) {
        if (typeof client?.createH264StreamSender !== 'function') {
            throw outputError('SYNC_CAPABILITY', 'Sync SDK does not support H.264 output')
        }
        const config = {
            codec: 'avc1.640028',
            width: descriptor.width,
            height: descriptor.height,
            bitrate: 50_000_000,
            framerate: descriptor.fps,
            bitrateMode: 'constant',
            latencyMode: 'realtime',
            hardwareAcceleration: 'prefer-hardware',
            avc: { format: 'annexb' }
        }
        const support = await VideoEncoder.isConfigSupported(config)
        if (!support.supported) {
            throw outputError('SYNC_CAPABILITY', 'Hardware H.264 output is unavailable at this resolution')
        }
        const transport = await client.createH264StreamSender(name)
        let sender
        try {
            sender = new SyncH264CanvasSender({ transport, canvas, descriptor, clock, config })
            await sender.ready
            await sender.warmup()
            return sender
        } catch (error) {
            if (sender) sender.close()
            else transport.close()
            throw error
        }
    }

    constructor({ transport, canvas, descriptor, clock, config }) {
        this._transport = transport
        this._canvas = canvas
        this._descriptor = descriptor
        this._clock = clock
        this._closed = false
        this._closing = false
        this._flushed = false
        this._failure = null
        this._nextSequence = 1
        this._nextWrite = 1
        this._lastWriteAt = -Infinity
        this._pending = new Map()
        this._timer = null
        this._writing = false
        this._keyframeNeeded = true
        this._diagnostics = { maxPending: 0, maxEncodeLatencyMs: 0,
            maxWriteLatencyMs: 0, maxEncoderQueue: 0, encoded: 0 }
        this.stats = { accepted: 0, droppedBusy: 0, droppedBackpressure: 0, sent: 0, failed: 0 }
        this.closed = new Promise((resolve, reject) => {
            this._resolveClosed = resolve
            this._rejectClosed = reject
        })
        // The controller attaches its close monitor after the renderer sink exists.
        // A worker startup failure may happen before that point.
        void this.closed.catch(() => {})
        transport.closed.then(
            () => this._end(),
            error => this._end(error)
        )
        this.ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve
            this._rejectReady = reject
        })
        this._readyTimer = setTimeout(() => {
            const error = outputError('SYNC_ENCODING_FAILED', 'H.264 worker did not start')
            this._rejectReady(error)
            this._fail(error)
        }, 5000)
        this._worker = new Worker(new URL('./syncH264EncoderWorker.js', import.meta.url), {
            type: 'module'
        })
        this._worker.onmessage = ({ data }) => {
            if (data.type === 'ready') {
                clearTimeout(this._readyTimer)
                this._readyTimer = null
                this._resolveReady()
            }
            else if (data.type === 'warmReady') {
                if (data.frames < 60) {
                    this._rejectWarmup?.(outputError('SYNC_ENCODING_FAILED',
                        'H.264 hardware encoder did not warm up'))
                } else this._resolveWarmup?.()
            }
            else if (data.type === 'flushed') {
                this._flushed = true
                this._finishDrain()
            }
            else if (data.type === 'encoded') this._encoded(data)
            else if (data.type === 'error') {
                const error = outputError('SYNC_ENCODING_FAILED', data.message)
                clearTimeout(this._readyTimer)
                this._readyTimer = null
                this._rejectReady(error)
                this._rejectWarmup?.(error)
                this._fail(error)
            }
        }
        this._worker.onerror = error => {
            const failure = outputError('SYNC_ENCODING_FAILED', 'H.264 worker failed', error)
            clearTimeout(this._readyTimer)
            this._readyTimer = null
            this._rejectReady(failure)
            this._rejectWarmup?.(failure)
            this._fail(failure)
        }
        this._worker.postMessage({ type: 'configure', config })
    }

    async warmup() {
        const completion = new Promise((resolve, reject) => {
            this._resolveWarmup = resolve
            this._rejectWarmup = reject
        })
        const start = this._clock.now()
        for (let index = 0; index < 120; index++) {
            const target = start + index * 1000 / 60
            const delay = target - this._clock.now()
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
            if (this._closed) throw outputError('SYNC_SENDER_CLOSED', 'H.264 sender closed during warmup')
            const frame = new VideoFrame(this._canvas, { timestamp: Math.round(target * 1000) })
            try {
                this._worker.postMessage({ type: 'warm', frame, keyFrame: index === 0 }, [frame])
            } finally { frame.close() }
        }
        this._worker.postMessage({ type: 'finishWarmup' })
        let timeout
        try {
            await Promise.race([
                completion,
                new Promise((_, reject) => { timeout = setTimeout(() => reject(outputError(
                    'SYNC_ENCODING_FAILED', 'H.264 hardware encoder warmup timed out')), 5000) })
            ])
        } finally { clearTimeout(timeout) }
        this._resolveWarmup = null
        this._rejectWarmup = null
    }

    configure(descriptor) {
        if (descriptor.width !== this._descriptor.width ||
            descriptor.height !== this._descriptor.height || descriptor.fps !== this._descriptor.fps) {
            this._fail(outputError('SYNC_RENDERER_REPLACED',
                'Output resolution changed; start Sync output again'))
        }
    }

    submit(_texture, timestamp) {
        if (this._closed || this._closing) return false
        if (this._pending.size >= MAX_PENDING_FRAMES) {
            this.stats.droppedBackpressure++
            this._keyframeNeeded = true
            return false
        }
        const sequence = this._nextSequence++
        const now = Number.isFinite(timestamp) ? timestamp : this._clock.now()
        const videoTimestamp = Math.round(now * 1000)
        const presentationTimeUs = Math.round((this._clock.timeOrigin + now) * 1000)
        const keyFrame = this._keyframeNeeded || sequence % 120 === 1
        this._keyframeNeeded = false
        try {
            const frame = new VideoFrame(this._canvas, { timestamp: videoTimestamp })
            try { this._worker.postMessage({ type: 'frame', frame, keyFrame }, [frame]) }
            finally { frame.close() }
        } catch (error) {
            this.stats.failed++
            this._fail(outputError('SYNC_ENCODING_FAILED', 'Could not encode the canvas frame', error))
            return false
        }
        this._pending.set(videoTimestamp, {
            sequence, presentationTimeUs, due: now + PACING_DELAY_MS - (keyFrame ? 10 : 2),
            capturedAt: this._clock.now(), frame: null
        })
        this._diagnostics.maxPending = Math.max(this._diagnostics.maxPending, this._pending.size)
        this.stats.accepted++
        this._schedule()
        return true
    }

    _encoded({ timestamp, payload, encoderQueueSize }) {
        if (this._closed) return
        const pending = this._pending.get(timestamp)
        if (!pending || payload.byteLength > MAX_ACCESS_UNIT_BYTES) {
            this._fail(outputError('SYNC_ENCODING_FAILED', 'H.264 encoder returned an invalid frame'))
            return
        }
        try {
            this._diagnostics.encoded++
            this._diagnostics.maxEncodeLatencyMs = Math.max(
                this._diagnostics.maxEncodeLatencyMs, this._clock.now() - pending.capturedAt)
            this._diagnostics.maxEncoderQueue = Math.max(
                this._diagnostics.maxEncoderQueue, encoderQueueSize || 0)
            const frame = new ArrayBuffer(HEADER_BYTES + payload.byteLength)
            new Uint8Array(frame, HEADER_BYTES).set(new Uint8Array(payload))
            pending.frame = encodeFrameV1({
                width: this._descriptor.width,
                height: this._descriptor.height,
                rowStride: 0,
                sequence: pending.sequence,
                presentationTimeUs: pending.presentationTimeUs,
                pixelFormat: PIXEL_FORMAT.H264_ANNEXB,
                colorSpace: COLOR_SPACE.SRGB,
                alphaMode: ALPHA_MODE.OPAQUE
            }, new Uint8Array(frame, HEADER_BYTES), frame)
            this._schedule()
        } catch (error) {
            this._fail(outputError('SYNC_ENCODING_FAILED', 'Could not pack the H.264 frame', error))
        }
    }

    _schedule() {
        if (this._closed || this._writing || this._timer !== null) return
        const next = [...this._pending.values()].find(value => value.sequence === this._nextWrite)
        if (!next) return
        const age = this._clock.now() - next.capturedAt
        if (age > ENCODE_TIMEOUT_MS) {
            this._fail(outputError('SYNC_ENCODING_FAILED', 'H.264 frame encoding timed out'))
            return
        }
        const delay = next.frame ? Math.max(0, next.due - this._clock.now(),
            this._lastWriteAt + MIN_WRITE_GAP_MS - this._clock.now()) :
            Math.min(50, ENCODE_TIMEOUT_MS - age)
        this._timer = setTimeout(() => {
            this._timer = null
            void this._writeNext()
        }, delay)
    }

    async _writeNext() {
        if (this._closed || this._writing) return
        const entry = [...this._pending.entries()].find(([, value]) => value.sequence === this._nextWrite)
        if (!entry || !entry[1].frame) {
            this._schedule()
            return
        }
        this._writing = true
        const writeStartedAt = this._clock.now()
        try {
            this._lastWriteAt = writeStartedAt
            await this._transport.writeFrame(entry[1].frame, { copy: false })
            this._diagnostics.maxWriteLatencyMs = Math.max(
                this._diagnostics.maxWriteLatencyMs, this._clock.now() - writeStartedAt)
            if (!this._closed) {
                this.stats.sent++
                this._pending.delete(entry[0])
                this._nextWrite++
            }
        } catch (error) {
            this.stats.failed++
            this._fail(error)
        } finally {
            this._writing = false
            this._finishDrain()
            this._schedule()
        }
    }

    _fail(error) {
        if (this._closed) return
        this._failure = error
        this._abort()
    }

    _end(error) {
        if (!this._closed) this._abort()
        const failure = this._failure || error
        if (failure) this._rejectClosed(failure)
        else this._resolveClosed()
    }

    close() {
        if (this._closed || this._closing) return
        this._closing = true
        this._drainTimer = setTimeout(() => this._fail(outputError(
            'SYNC_STOP_TIMEOUT', 'H.264 output did not drain before stopping')), 2500)
        this._worker.postMessage({ type: 'flush' })
    }

    _finishDrain() {
        if (!this._closing || !this._flushed || this._pending.size > 0 || this._writing) return
        clearTimeout(this._drainTimer)
        this._closed = true
        if (this._timer !== null) clearTimeout(this._timer)
        this._timer = null
        this._worker.terminate()
        this._transport.close()
    }

    _abort() {
        if (this._closed) return
        this._closed = true
        this._closing = true
        this._rejectReady(outputError('SYNC_SENDER_CLOSED', 'H.264 sender closed before starting'))
        this._rejectWarmup?.(outputError('SYNC_SENDER_CLOSED', 'H.264 sender closed during warmup'))
        clearTimeout(this._drainTimer)
        if (this._timer !== null) clearTimeout(this._timer)
        this._timer = null
        if (this._readyTimer !== null) clearTimeout(this._readyTimer)
        this._readyTimer = null
        this._pending.clear()
        this._worker.terminate()
        this._transport.close()
    }
}
