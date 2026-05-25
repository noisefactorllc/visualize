/**
 * Recorder — capture the master canvas to a downloadable webm via
 * MediaRecorder + canvas.captureStream().
 *
 * Bitrate choice (8 Mbps) keeps quality high enough for VJ archives
 * without overwhelming the encoder during gnarly high-motion shaders.
 * If the browser doesn't support vp9, the constructor falls back to
 * webm without codec hint and lets the UA choose.
 */

export class Recorder {
    constructor(canvas, { onTick, onStateChange, onWarning } = {}) {
        this.canvas = canvas
        this._recorder = null
        this._chunks = []
        this._startTime = 0
        this._tickId = null
        this._onTick = onTick || (() => {})
        this._onStateChange = onStateChange || (() => {})
        this._onWarning = onWarning || (() => {})
        this._mimeType = this._pickMime()
        this._fps = 60
        this._bitrate = 8_000_000
        // Chunks accumulate in-memory until stop() (MediaRecorder doesn't
        // stream to disk). At 8 Mbps that's ~60 MB/min; warn at 15 min
        // (~900 MB) and hard-stop at 60 min so the browser doesn't OOM.
        this._warnAfterMs = 15 * 60 * 1000
        this._hardStopAfterMs = 60 * 60 * 1000
        this._warned = false
    }

    /** Estimate in bytes — based on bitrate, not actual chunk size. */
    get estimatedSize() {
        return Math.floor(this.elapsedMs * this._bitrate / 8000)
    }

    static isSupported() {
        return typeof MediaRecorder !== 'undefined'
            && typeof HTMLCanvasElement !== 'undefined'
            && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    }

    _pickMime() {
        if (typeof MediaRecorder === 'undefined') return ''
        const candidates = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ]
        for (const m of candidates) {
            try {
                if (MediaRecorder.isTypeSupported(m)) return m
            } catch {}
        }
        return ''
    }

    get isRecording() {
        return !!this._recorder && this._recorder.state === 'recording'
    }

    get elapsedMs() {
        return this._startTime ? performance.now() - this._startTime : 0
    }

    start() {
        if (!Recorder.isSupported()) return false
        if (this.isRecording) return false
        const stream = this.canvas.captureStream(this._fps)
        const opts = { videoBitsPerSecond: this._bitrate }
        if (this._mimeType) opts.mimeType = this._mimeType
        try {
            this._recorder = new MediaRecorder(stream, opts)
        } catch (err) {
            console.error('[Recorder] failed to create MediaRecorder', err)
            return false
        }
        this._chunks = []
        this._recorder.ondataavailable = (e) => {
            if (e.data && e.data.size) this._chunks.push(e.data)
        }
        this._recorder.onstop = () => this._onStop()
        this._recorder.start(1000)
        this._startTime = performance.now()
        this._warned = false
        this._tickId = setInterval(() => {
            const ms = this.elapsedMs
            this._onTick(ms)
            if (!this._warned && ms > this._warnAfterMs) {
                this._warned = true
                const mb = Math.round(this.estimatedSize / 1024 / 1024)
                this._onWarning(`recording is ${Math.round(ms / 60000)}min (~${mb}MB in memory) — stop soon to avoid running out of RAM`)
            }
            if (ms > this._hardStopAfterMs) {
                this._onWarning('recording auto-stopped at 60min to protect memory')
                this.stop()
            }
        }, 1000)
        this._onStateChange(true)
        return true
    }

    stop() {
        if (!this.isRecording) return
        clearInterval(this._tickId)
        this._tickId = null
        try { this._recorder.stop() } catch (err) { console.error(err) }
    }

    toggle() {
        if (this.isRecording) {
            this.stop()
            return false
        }
        return this.start()
    }

    _onStop() {
        const blob = new Blob(this._chunks, { type: this._mimeType || 'video/webm' })
        this._chunks = []
        this._onStateChange(false)
        if (blob.size === 0) return
        this._download(blob)
        this._startTime = 0
    }

    _download(blob) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        a.href = url
        a.download = `visualize-${ts}.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
}

/**
 * Format ms as MM:SS for the record-time readout.
 */
export function formatRecTime(ms) {
    const totalSec = Math.floor(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return `${m}:${String(s).padStart(2, '0')}`
}
