import { SyncCameraFrameQueue, canQueueSyncCamera } from './cameraFrameQueue.js'

const subscriptions = new WeakMap()

// The desktop IPC owns one subscription per window. Share it between decks.
export function subscribeSyncCamera(listener, api = globalThis.electronAPI?.syncCamera) {
    let entry = subscriptions.get(api)
    if (!entry) {
        entry = { listeners: new Set(), stop: null }
        subscriptions.set(api, entry)
    }
    entry.listeners.add(listener)
    if (!entry.stop) {
        try {
            entry.stop = api.subscribe(frame => {
                for (const callback of [...entry.listeners]) callback(frame)
            })
        } catch (error) {
            entry.listeners.delete(listener)
            if (!entry.listeners.size) subscriptions.delete(api)
            throw error
        }
    }
    let active = true
    return () => {
        if (!active) return
        active = false
        entry.listeners.delete(listener)
        if (!entry.listeners.size) {
            subscriptions.delete(api)
            entry.stop()
        }
    }
}

export async function createSyncCameraSession(track, options) {
    if (!canQueueSyncCamera(track)) return null
    const api = globalThis.electronAPI?.syncCamera
    let useNativeShm = false
    if (api && typeof globalThis.VideoFrame === 'function') {
        try { useNativeShm = await api.isAvailable() } catch { /* Use the browser camera track. */ }
    }
    if (!options.isCurrent()) return null
    const stream = options.stream
    const trackMatches = () => !stream || (stream.getVideoTracks().length === 1 && stream.getVideoTracks()[0] === track)
    if (!trackMatches()) throw new Error('Camera track changed')
    let queue
    const detach = () => {
        stream?.removeEventListener('addtrack', changed)
        stream?.removeEventListener('removetrack', changed)
    }
    const fail = error => {
        detach()
        try { options.onError(error) } finally { void queue?.stop() }
    }
    const changed = () => fail(new Error('Camera track changed'))
    queue = new SyncCameraFrameQueue(track, {
        ...options, useNativeShm,
        onError: fail,
        shmSubscriber: useNativeShm ? callback => subscribeSyncCamera(callback, api) : null
    })
    if (queue.active) {
        stream?.addEventListener('addtrack', changed)
        stream?.addEventListener('removetrack', changed)
    }
    return {
        get active() { return queue.active },
        consume: () => queue.consume(),
        stop() { detach(); return queue.stop() }
    }
}
