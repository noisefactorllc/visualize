// Camera timestamps identify frames on this actual track, not Sync packets or
// unique pictures. Keep the watermark across consumer stop/start on that track.
const tracks = new WeakMap()

export function canQueueSyncCamera(track) {
    const label = track?.label?.trim().toLowerCase()
    return track?.kind === 'video' && track.readyState === 'live' &&
        (label === 'sync camera' || label === 'sync windows virtual camera') &&
        typeof globalThis.MediaStreamTrackProcessor === 'function' &&
        (typeof globalThis.VideoFrame === 'function' || typeof globalThis.createImageBitmap === 'function')
}

/** Owns frame acquisition only; the media manager calls consume on its RAF. */
export class SyncCameraFrameQueue {
    constructor(track, { isCurrent, upload, onError, useNativeShm = false, shmSubscriber = null }) {
        const previous = tracks.get(track)
        if (previous?.error) throw previous.error
        if (previous?.owner) throw new Error('Camera frames still have an owner')

        this.track = track
        this.active = true
        this._isCurrent = isCurrent
        this._upload = upload
        this._onError = onError
        this._pending = []
        this._buffering = true
        this._starvationTicks = 0
        this._uploading = false
        this._uploadDone = Promise.resolve()
        this._stopped = null
        this._watermark = previous || { timestamp: -Infinity, error: null, owner: null }
        this._watermark.owner = this
        tracks.set(track, this._watermark)
        this._ended = () => this._fail(new Error('Camera frame stream ended'))
        track.addEventListener('ended', this._ended)

        this._useNativeShm = useNativeShm
        this._shmUnsubscribe = null
        this._reader = null
        this._pumpDone = Promise.resolve()

        if (this._useNativeShm) {
            const subscribe = shmSubscriber || globalThis.electronAPI?.syncCamera?.subscribe
            if (typeof subscribe === 'function') {
                this._shmUnsubscribe = subscribe(frameData => this._onShmFrame(frameData))
            } else {
                this._fail(new Error('Native shared memory camera subscriber unavailable'))
            }
        } else {
            const processor = new globalThis.MediaStreamTrackProcessor({ track, maxBufferSize: 4 })
            this._reader = processor.readable.getReader()
            this._pumpDone = this._readFrames()
        }
    }

    _fail(error) {
        if (!this._watermark.error) {
            this._watermark.error = error
            try { this._onError(error) } catch { /* Cleanup must still run. */ }
        }
        this.stop()
    }

    _close(resource) {
        try { resource.close() } catch (error) { this._fail(error) }
    }

    _onShmFrame(frameData) {
        if (!this.active || !this._isCurrent()) {
            this.stop()
            return
        }
        let frame = null
        try {
            const { presentationTimeUs, width, height, buffer } = frameData
            const timestamp = Number(presentationTimeUs)
            if (!Number.isSafeInteger(timestamp) || timestamp < this._watermark.timestamp) {
                throw new Error('Camera frame timestamp is invalid or decreased')
            }
            if (timestamp === this._watermark.timestamp) return
            this._watermark.timestamp = timestamp

            if (typeof globalThis.VideoFrame === 'function') {
                frame = new globalThis.VideoFrame(buffer, {
                    format: 'BGRA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp
                })
            } else {
                throw new Error('VideoFrame constructor unavailable for native shm frames')
            }

            if (!this.active || !this._isCurrent()) {
                this.stop()
                return
            }
            if (this._pending.length === 3) this._close(this._pending.shift())
            if (!this.active) return
            this._pending.push(frame)
            frame = null
        } catch (error) {
            this._fail(error)
        } finally {
            if (frame) this._close(frame)
        }
    }

    async _readFrames() {
        while (this.active) {
            let frame = null, item = null
            try {
                const delivery = await this._reader.read()
                if (delivery.done) {
                    if (this.active) this._fail(new Error('Camera frame stream ended'))
                    break
                }
                frame = delivery.value
                if (!this.active || !this._isCurrent()) { this.stop(); continue }
                const timestamp = frame.timestamp
                if (!Number.isSafeInteger(timestamp) || timestamp < this._watermark.timestamp) {
                    throw new Error('Camera frame timestamp is invalid or decreased')
                }
                if (timestamp === this._watermark.timestamp) continue
                this._watermark.timestamp = timestamp
                if (typeof globalThis.VideoFrame === 'function' && frame instanceof globalThis.VideoFrame) {
                    item = frame
                    frame = null
                } else {
                    let converted
                    try { converted = globalThis.createImageBitmap(frame) }
                    finally { const owned = frame; frame = null; this._close(owned) }
                    item = await converted
                }
                if (!this.active || !this._isCurrent()) { this.stop(); continue }
                const width = item.displayWidth ?? item.width
                const height = item.displayHeight ?? item.height
                if (!(width > 0 && height > 0)) throw new Error('Camera bitmap is empty')
                if (this._pending.length === 3) this._close(this._pending.shift())
                if (!this.active) continue
                this._pending.push(item)
                item = null
            } catch (error) {
                this._fail(error)
            } finally {
                if (frame) this._close(frame)
                if (item) this._close(item)
            }
        }
    }

    consume() {
        if (!this.active || this._uploading) return
        if (!this._isCurrent()) { this.stop(); return }
        if (this._buffering) {
            if (this._pending.length < 2) return
            this._buffering = false
            this._starvationTicks = 0
        }
        if (this._pending.length === 0) {
            this._starvationTicks++
            if (this._starvationTicks >= 3) this._buffering = true
            return
        }
        this._starvationTicks = 0
        const bitmap = this._pending.shift()
        this._uploading = true
        this._uploadDone = (async () => {
            try {
                let size = this._upload(bitmap)
                if (size && typeof size.then === 'function') size = await size
                if (!(size?.width > 0 && size?.height > 0)) throw new Error('Camera texture upload failed')
            } catch (error) {
                this._fail(error)
            } finally {
                this._uploading = false
                this._close(bitmap)
            }
        })()
    }

    stop() {
        if (this._stopped) return this._stopped
        this.active = false
        if (this._shmUnsubscribe) {
            try { this._shmUnsubscribe() } catch (error) { this._fail(error) }
            this._shmUnsubscribe = null
        }
        // Defer the await so reentrant stop inside upload waits for the current
        // upload promise assignment and its bitmap's finally block.
        this._stopped = Promise.resolve().then(async () => {
            await this._pumpDone
            await this._uploadDone
            await cancelled
            if (this._reader) {
                try { this._reader.releaseLock() } catch (error) { this._fail(error) }
            }
            if (this._watermark.owner === this) this._watermark.owner = null
        })
        this.track.removeEventListener('ended', this._ended)
        while (this._pending.length) this._close(this._pending.shift())
        let cancelled = Promise.resolve()
        if (this._reader) {
            try { cancelled = Promise.resolve(this._reader.cancel()).catch(error => this._fail(error)) }
            catch (error) { this._fail(error); cancelled = Promise.resolve() }
        }
        return this._stopped
    }
}
