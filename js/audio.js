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

export class SharedAudio {
    constructor() {
        this._decks = new Set()
        this._audioStates = new Map() // deck -> audioState
        this._enabled = false
        this._deviceId = ''
        this._deviceLabel = ''
        this._sensitivity = 1.5
        this._stream = null
        this._audioContext = null
        this._analyser = null
        this._source = null
        this._fftData = null
        this._timeDomainData = null
        this._rafId = null
        this._onStatus = null
        this._onMeters = null

        this.meters = { low: 0, mid: 0, high: 0, vol: 0 }
        this.spectrum = new Uint8Array(128)
        this.waveform = new Uint8Array(256)
    }

    static isSupported() {
        return !!(typeof navigator !== 'undefined'
            && navigator.mediaDevices
            && navigator.mediaDevices.getUserMedia
            && typeof AudioContext !== 'undefined')
    }

    onStatusChange(cb) { this._onStatus = cb }
    onMeters(cb) { this._onMeters = cb }

    get enabled() { return this._enabled }
    get currentDeviceId() { return this._deviceId }
    get currentDeviceLabel() { return this._deviceLabel }

    setSensitivity(s) { this._sensitivity = Math.max(0.1, s) }

    /**
     * Register a deck so its audioState gets written every frame.
     */
    addDeck(deck) {
        this._decks.add(deck)
        const state = deck.ensureAudioState()
        if (state) this._audioStates.set(deck, state)
    }

    removeDeck(deck) {
        this._decks.delete(deck)
        this._audioStates.delete(deck)
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
        if (this._enabled) await this.disable()
        if (!SharedAudio.isSupported()) {
            this._notify('audio input not supported')
            return false
        }
        const constraints = {
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        }
        if (deviceId) constraints.audio.deviceId = { exact: deviceId }
        try {
            this._stream = await navigator.mediaDevices.getUserMedia(constraints)
        } catch (err) {
            this._notify(`audio access denied: ${err.message || err.name}`)
            return false
        }
        const track = this._stream.getAudioTracks()[0]
        const settings = track?.getSettings?.() || {}
        this._deviceId = settings.deviceId || deviceId || ''
        this._deviceLabel = track?.label || 'default'

        this._audioContext = new AudioContext()
        this._analyser = this._audioContext.createAnalyser()
        this._analyser.fftSize = 256
        this._analyser.smoothingTimeConstant = 0.8
        this._source = this._audioContext.createMediaStreamSource(this._stream)
        this._source.connect(this._analyser)
        this._fftData = new Uint8Array(this._analyser.frequencyBinCount)
        this._timeDomainData = new Uint8Array(this._analyser.fftSize)

        // Refresh audio state references for each deck (renderer may have
        // recreated the bag during compilation).
        for (const deck of this._decks) {
            const state = deck.ensureAudioState()
            if (state) this._audioStates.set(deck, state)
        }

        this._enabled = true
        this._loop()
        this._notify(`audio: ${this._deviceLabel}`)
        return true
    }

    async disable() {
        if (!this._enabled) return
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
        if (this._audioContext) {
            try { await this._audioContext.close() } catch {}
            this._audioContext = null
        }
        this._analyser = null
        this._fftData = null
        this._timeDomainData = null
        this._enabled = false
        this.meters.low = this.meters.mid = this.meters.high = this.meters.vol = 0
        for (const state of this._audioStates.values()) {
            state.low = 0; state.mid = 0; state.high = 0; state.vol = 0
            state.spectrum?.fill?.(0)
            state.waveform?.fill?.(0.5)
        }
        this._notify('audio off')
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

        // Copy a downsampled spectrum for the UI meter
        const spectrumOut = this.spectrum
        const fft = this._fftData
        const ratio = fft.length / spectrumOut.length
        for (let i = 0; i < spectrumOut.length; i++) {
            spectrumOut[i] = fft[Math.floor(i * ratio)] || 0
        }
        const wave = this.waveform
        const td = this._timeDomainData
        const wr = td.length / wave.length
        for (let i = 0; i < wave.length; i++) {
            wave[i] = td[Math.floor(i * wr)] || 128
        }

        const sens = this._sensitivity
        const low  = Math.min(1, ((fft[0] + fft[1] + fft[2] + fft[3]) / 4 / 255) * sens)
        const mid  = Math.min(1, ((fft[4] + fft[6] + fft[8] + fft[10]) / 4 / 255) * sens)
        const high = Math.min(1, ((fft[16] + fft[20] + fft[24] + fft[28]) / 4 / 255) * sens)
        const vol  = (low + mid + high) / 3

        this.meters.low = low
        this.meters.mid = mid
        this.meters.high = high
        this.meters.vol = vol

        for (const state of this._audioStates.values()) {
            state.low = low
            state.mid = mid
            state.high = high
            state.vol = vol
            state.setSpectrum?.(this._fftData)
            state.setWaveform?.(this._timeDomainData)
        }

        if (this._onMeters) this._onMeters(this.meters)
        this._rafId = requestAnimationFrame(() => this._loop())
    }

    _notify(msg) {
        if (this._onStatus) this._onStatus(msg, this._enabled)
    }
}
