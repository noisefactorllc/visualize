/**
 * SharedAudio — one mic/loopback stream feeding the audioState bags of
 * every deck plus a public meters object for the UI.
 *
 * Mirrors the FFT-bin to audio band mapping used by polymorphic's
 * LocalAudioInput so DSL programs written for Polymorphic/Noisedeck
 * (audio() automation, audio-tagged effects) react the same way here.
 *
 * Use addDeck(deck) for every Deck created; the manager will write FFT
 * bands into each deck's audioState every frame while enabled.
 */

import * as nativeSyncAudio from './sync/audioInput.js'
import { SyncAudioChannels } from './sync/audioChannels.js'

export const AUDIO_STORAGE_KEY = 'visualize.audio.v1'
export const AUDIO_SENSITIVITY_STORAGE_KEY = 'visualize.audio.sensitivity.v1'
export const DEFAULT_AUDIO_SENSITIVITY = 1.5
export const MIN_AUDIO_SENSITIVITY = 0.5
export const MAX_AUDIO_SENSITIVITY = 4.0

export function parseAudioSensitivity(raw, fallback = DEFAULT_AUDIO_SENSITIVITY) {
    if (raw == null || typeof raw === 'boolean') return fallback
    let val = raw
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)
            val = typeof parsed === 'number' ? parsed : (parsed?.sensitivity ?? parseFloat(raw))
        } catch {
            val = parseFloat(raw)
        }
    } else if (typeof raw === 'object' && raw !== null) {
        val = raw.sensitivity
    }
    const num = typeof val === 'number' ? val : Number(val)
    if (!Number.isFinite(num)) return fallback
    const clamped = Math.max(MIN_AUDIO_SENSITIVITY, Math.min(MAX_AUDIO_SENSITIVITY, num))
    return Math.round(clamped * 10) / 10
}

export function loadAudioSensitivity(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return DEFAULT_AUDIO_SENSITIVITY
    try {
        const item = storage.getItem(AUDIO_STORAGE_KEY) ?? storage.getItem(AUDIO_SENSITIVITY_STORAGE_KEY)
        return parseAudioSensitivity(item)
    } catch {
        return DEFAULT_AUDIO_SENSITIVITY
    }
}

export function persistAudioSensitivity(sensitivity, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    if (!storage) return false
    try {
        const val = parseAudioSensitivity(sensitivity)
        let existing = {}
        try {
            const raw = storage.getItem(AUDIO_STORAGE_KEY)
            if (raw) {
                const parsed = JSON.parse(raw)
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    existing = parsed
                }
            }
        } catch {}
        storage.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ ...existing, sensitivity: val }))
        return true
    } catch {
        return false
    }
}

export class SharedAudio {
    constructor(options = {}) {
        this._syncAudio = options?.syncAudio ?? nativeSyncAudio
        this._captureGeneration = 0
        this._pendingAbort = null
        this._nativeCapture = null
        this._nativeChannels = null
        this._decks = new Set()
        this._audioStates = new Map() // deck -> audioState
        this._enabled = false
        this._deviceId = ''
        this._deviceLabel = ''
        const initialSens = typeof options === 'number' ? options : options?.sensitivity
        this._sensitivity = parseAudioSensitivity(initialSens, DEFAULT_AUDIO_SENSITIVITY)
        this._stream = null
        this._audioContext = null
        this._analyser = null
        this._source = null
        this._fftData = null
        this._timeDomainData = null
        this._rafId = null
        // Bind the per-frame loop once so the rAF callback doesn't allocate
        // a fresh closure every frame for the life of the session.
        this._loopBound = () => this._loop()
        this._onStatus = null
        this._onMeters = null
        this._onSensitivity = null

        this.meters = { sub: 0, low: 0, mid: 0, high: 0, vol: 0 }
    }

    static isSupported() {
        return !!(typeof navigator !== 'undefined'
            && navigator.mediaDevices
            && navigator.mediaDevices.getUserMedia
            && typeof AudioContext !== 'undefined')
    }

    onStatusChange(cb) { this._onStatus = cb }
    onMeters(cb) { this._onMeters = cb }
    onSensitivityChange(cb) { this._onSensitivity = cb }

    get enabled() { return this._enabled }
    get currentDeviceId() { return this._deviceId }
    get currentDeviceLabel() { return this._deviceLabel }
    get sensitivity() { return this._sensitivity }

    setSensitivity(s) {
        if (s == null || typeof s === 'boolean') return
        const num = typeof s === 'number' ? s : Number(s)
        if (!Number.isFinite(num)) return
        this._sensitivity = parseAudioSensitivity(num, this._sensitivity)
        if (this._onSensitivity) this._onSensitivity(this._sensitivity)
    }

    /**
     * Register a deck so its audioState gets written every frame.
     */
    addDeck(deck) {
        this._decks.add(deck)
        const state = deck.ensureAudioState()
        if (state) this._audioStates.set(deck, state)
    }

    /**
     * List available audio input devices. May trigger a permissions prompt
     * for labels — call this after `enable()` for full device names.
     */
    async listDevices() {
        if (!SharedAudio.isSupported()) return []
        try {
            const devs = await navigator.mediaDevices.enumerateDevices()
            return devs.filter(d => d.kind === 'audioinput')
        } catch (err) {
            console.warn('[SharedAudio] enumerateDevices failed', err)
            return []
        }
    }

    async enable(deviceId = '') {
        if (this._enabled && deviceId === this._deviceId) return true
        // Invalidate pending opens before replacing a source.
        const stopping = this.disable()
        const generation = this._captureGeneration
        await stopping
        if (generation !== this._captureGeneration) return false
        const abort = new AbortController()
        this._pendingAbort = abort
        let capture, stream, context, source, channels, failure
        try {
            if (nativeSyncAudio.isSyncAudioSource(deviceId)) {
                capture = await this._syncAudio.openSyncAudioSource(deviceId, error => {
                    failure = error
                    if (generation !== this._captureGeneration || !this._enabled) return
                    const stopping = this.disable()
                    const stoppedGeneration = this._captureGeneration
                    void stopping.then(() => {
                        if (stoppedGeneration === this._captureGeneration) this._notify(`Sync audio: ${error.message}`, error)
                    })
                }, { signal: abort.signal })
                abort.signal.throwIfAborted()
                if (failure) throw failure
                context = capture.context
                source = capture.source
                const device = this._syncAudio.getSyncAudioDevices().find(item => item.id === deviceId)
                this._deviceId = deviceId
                this._deviceLabel = device?.name || 'Sync audio'
                channels = new SyncAudioChannels(capture, { id: deviceId, name: this._deviceLabel })
            } else {
                if (!SharedAudio.isSupported()) throw new Error('Audio input not supported')
                stream = await navigator.mediaDevices.getUserMedia({ audio: {
                    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
                } })
                abort.signal.throwIfAborted()
                const track = stream.getAudioTracks()[0]
                this._deviceId = track?.getSettings?.().deviceId || deviceId || ''
                this._deviceLabel = track?.label || 'default'
                context = new AudioContext()
                source = context.createMediaStreamSource(stream)
            }
            await context.resume()
            abort.signal.throwIfAborted()
            if (failure) throw failure
            const analyser = context.createAnalyser()
            analyser.fftSize = 256
            analyser.smoothingTimeConstant = 0.8
            source.connect(analyser)
            this._stream = stream || null
            this._audioContext = context
            this._source = source
            this._nativeCapture = capture || null
            this._nativeChannels = channels || null
            this._analyser = analyser
            this._fftData = new Uint8Array(analyser.frequencyBinCount)
            this._timeDomainData = new Uint8Array(analyser.fftSize)
            this.refreshDeckStates()
            this._enabled = true
            this._loop()
            this._notify(`audio: ${this._deviceLabel}`)
            return true
        } catch (error) {
            channels?.stop()
            capture?.bridge.stop()
            stream?.getTracks().forEach(track => track.stop())
            try { source?.disconnect() } catch {}
            await context?.close().catch(() => {})
            if (generation === this._captureGeneration) this._notify(`audio input failed: ${error.message || error.name}`, error)
            return false
        }
    }

    async disable() {
        this._captureGeneration++
        this._pendingAbort?.abort()
        this._pendingAbort = null
        this._enabled = false
        this._nativeChannels?.stop()
        this._nativeChannels = null
        this._nativeCapture?.bridge.stop()
        this._nativeCapture = null
        if (this._rafId) {
            cancelAnimationFrame(this._rafId)
            this._rafId = null
        }
        try { this._source?.disconnect() } catch {}
        this._source = null
        if (this._stream) {
            for (const t of this._stream.getTracks()) t.stop()
            this._stream = null
        }
        const context = this._audioContext
        this._audioContext = null
        this._analyser = null
        this._fftData = null
        this._timeDomainData = null
        this._enabled = false
        this.meters.sub = this.meters.low = this.meters.mid = this.meters.high = this.meters.vol = 0
        for (const state of this._audioStates.values()) {
            state.sub = 0; state.low = 0; state.mid = 0; state.high = 0; state.vol = 0
            state.spectrum?.fill?.(0)
            state.waveform?.fill?.(0.5)
        }
        this._notify('audio off')
        try { await context?.close() } catch {}
    }

    async toggle(deviceId = '') {
        if (this._enabled) {
            await this.disable()
            return false
        }
        return this.enable(deviceId)
    }

    /**
     * Re-pick decks' audioState after they've been recompiled (the renderer
     * sometimes recreates the bag). Call after any deck.load().
     */
    refreshDeckStates() {
        for (const deck of this._decks) {
            const state = deck.ensureAudioState()
            if (state) this._audioStates.set(deck, state)
        }
    }

    _loop() {
        if (!this._enabled) return
        this._analyser.getByteFrequencyData(this._fftData)
        this._analyser.getByteTimeDomainData(this._timeDomainData)

        const fft = this._fftData
        const sens = this._sensitivity
        // sub: just the deepest FFT bin (~0-187Hz at our 48kHz/256
        // fftSize). Distinct from low (bins 0-3 avg) so the operator
        // can target kick-drum fundamentals specifically — used by
        // Auto-Mix's audio source picker.
        const sub  = Math.min(1, (fft[0] / 255) * sens)
        const low  = Math.min(1, ((fft[0] + fft[1] + fft[2] + fft[3]) / 4 / 255) * sens)
        const mid  = Math.min(1, ((fft[4] + fft[6] + fft[8] + fft[10]) / 4 / 255) * sens)
        const high = Math.min(1, ((fft[16] + fft[20] + fft[24] + fft[28]) / 4 / 255) * sens)
        const vol  = (low + mid + high) / 3

        this.meters.sub = sub
        this.meters.low = low
        this.meters.mid = mid
        this.meters.high = high
        this.meters.vol = vol

        for (const state of this._audioStates.values()) {
            state.sub = sub
            state.low = low
            state.mid = mid
            state.high = high
            state.vol = vol
            state.setSpectrum?.(this._fftData)
            state.setWaveform?.(this._timeDomainData)
        }

        this._nativeChannels?.update(this._audioStates.values(), sens)
        if (this._onMeters) this._onMeters(this.meters)
        this._rafId = requestAnimationFrame(this._loopBound)
    }

    _notify(msg, error = null) {
        if (this._onStatus) this._onStatus(msg, this._enabled, error)
    }
}
