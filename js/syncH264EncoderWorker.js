let encoder = null
let warming = false
let warmChunks = 0

self.onmessage = ({ data }) => {
    if (data.type === 'configure') {
        try {
            encoder = new VideoEncoder({
                output(chunk) {
                    if (warming) { warmChunks++; return }
                    const payload = new ArrayBuffer(chunk.byteLength)
                    chunk.copyTo(new Uint8Array(payload))
                    self.postMessage({ type: 'encoded', timestamp: chunk.timestamp, payload,
                        encoderQueueSize: encoder.encodeQueueSize }, [payload])
                },
                error(error) { self.postMessage({ type: 'error', message: String(error) }) }
            })
            encoder.configure(data.config)
            self.postMessage({ type: 'ready' })
        } catch (error) {
            self.postMessage({ type: 'error', message: String(error) })
        }
        return
    }
    if (data.type === 'finishWarmup') {
        encoder.flush().then(() => {
            warming = false
            self.postMessage({ type: 'warmReady', frames: warmChunks })
        }, error => self.postMessage({ type: 'error', message: String(error) }))
        return
    }
    if (data.type === 'flush') {
        encoder.flush().then(() => self.postMessage({ type: 'flushed' }),
            error => self.postMessage({ type: 'error', message: String(error) }))
        return
    }
    if (data.type === 'warm') warming = true
    if (data.type === 'frame' || data.type === 'warm') {
        try {
            encoder.encode(data.frame, { keyFrame: data.keyFrame })
        } catch (error) {
            self.postMessage({ type: 'error', message: String(error) })
        } finally {
            data.frame.close()
        }
    }
}
