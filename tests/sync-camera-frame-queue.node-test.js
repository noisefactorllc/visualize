import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncCameraFrameQueue, canQueueSyncCamera } from '../js/sync/cameraFrameQueue.js'

const bounded = { timeout: 5000 }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function setup(t) {
    const saved = new Map(['MediaStreamTrackProcessor', 'createImageBitmap', 'VideoFrame'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
    const frames = [], bitmaps = [], uploads = [], readers = [], errors = []
    const track = Object.assign(new EventTarget(), { kind: 'video', label: 'Sync Camera', readyState: 'live' })
    const h = { track, frames, bitmaps, uploads, readers, errors, current: true, delayedBitmap: null, delayBitmap: false, onUpload: null, owners: [] }
    globalThis.MediaStreamTrackProcessor = class {
        constructor(options) {
            assert.equal(options.track, track)
            assert.equal(options.maxBufferSize, 4)
            const reader = {
                pending: null, cancels: 0, releases: 0,
                read() { assert.equal(this.pending, null); return new Promise((resolve, reject) => { this.pending = { resolve, reject } }) },
                cancel() { this.cancels++; if (this.pending) { const { resolve } = this.pending; this.pending = null; resolve({ done: true }) } return Promise.resolve() },
                releaseLock() { assert.equal(this.pending, null); this.releases++ },
            }
            readers.push(reader)
            this.readable = { getReader: () => reader }
        }
    }
    globalThis.createImageBitmap = () => {
        const bitmap = { width: 1920, height: 1080, closes: 0, close() { this.closes++ } }
        bitmaps.push(bitmap)
        return h.delayBitmap ? new Promise(resolve => { h.delayedBitmap = () => resolve(bitmap) }) : Promise.resolve(bitmap)
    }
    h.start = () => {
        const owner = new SyncCameraFrameQueue(track, {
            isCurrent: () => h.current,
            upload(bitmap) { uploads.push(bitmap); return h.onUpload?.(bitmap) ?? { width: bitmap.width, height: bitmap.height } },
            onError: error => errors.push(error),
        })
        h.owners.push(owner)
        return owner
    }
    h.deliver = async timestamp => {
        const frame = { timestamp, closes: 0, close() { this.closes++ } }
        frames.push(frame)
        const reader = readers.at(-1), { resolve } = reader.pending
        reader.pending = null
        resolve({ done: false, value: frame })
        await flush()
        return frame
    }
    t.after(async () => {
        h.delayedBitmap?.()
        await Promise.all(h.owners.map(owner => owner.stop()))
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor)
            else delete globalThis[key]
        }
    })
    return h
}

test('eligibility uses exact supported Sync names and required APIs', bounded, t => {
    const h = setup(t)
    for (const label of ['Sync Camera', 'sync camera', 'Sync Windows Virtual Camera']) assert.equal(canQueueSyncCamera({ ...h.track, kind: 'video', readyState: 'live', label }), true)
    for (const label of ['Physical Camera', 'My Sync Camera', 'Sync Camera Source', 'Sync']) assert.equal(canQueueSyncCamera({ kind: 'video', readyState: 'live', label }), false)
    globalThis.MediaStreamTrackProcessor = undefined
    assert.equal(canQueueSyncCamera(h.track), false)
})

test('FIFO waits for two, consumes one oldest per call, and refills after sustained starvation', bounded, async t => {
    const h = setup(t), owner = h.start()
    await h.deliver(100); owner.consume(); assert.equal(h.uploads.length, 0)
    await h.deliver(200); owner.consume(); assert.equal(h.uploads[0], h.bitmaps[0])
    owner.consume(); assert.equal(h.uploads[1], h.bitmaps[1])
    // Transient drain: solitary arrival consumes immediately without stutter
    await h.deliver(300); owner.consume(); assert.equal(h.uploads[2], h.bitmaps[2])
    // Sustained starvation: 3 consecutive empty consume calls re-arms buffering
    owner.consume(); owner.consume(); owner.consume()
    // Next solitary arrival waits for two frames to rebuild jitter reserve
    await h.deliver(400); owner.consume(); assert.equal(h.uploads.length, 3)
    await h.deliver(500); owner.consume(); assert.equal(h.uploads[3], h.bitmaps[3])
    await owner.stop()
    assert.ok(h.frames.every(frame => frame.closes === 1)); assert.ok(h.bitmaps.every(bitmap => bitmap.closes === 1))
})

test('fourth pending bitmap closes oldest and retains fixed FIFO depth three', bounded, async t => {
    const h = setup(t), owner = h.start()
    for (const timestamp of [100, 200, 300, 400, 500]) await h.deliver(timestamp)
    assert.equal(h.bitmaps[0].closes, 1); assert.equal(h.bitmaps[1].closes, 1)
    owner.consume(); assert.equal(h.uploads[0], h.bitmaps[2])
    await owner.stop(); assert.ok(h.bitmaps.every(bitmap => bitmap.closes === 1))
})

test('same-track restart retains timestamp watermark; decreasing timestamps fail instead of resetting', bounded, async t => {
    const h = setup(t), first = h.start()
    await h.deliver(100); await first.stop()
    const second = h.start()
    await h.deliver(100); assert.equal(h.bitmaps.length, 1)
    await h.deliver(200); await h.deliver(150)
    await second.stop()
    assert.equal(second.active, false); assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /timestamp/)
    assert.throws(() => h.start(), /timestamp/)
    assert.ok(h.frames.every(frame => frame.closes === 1)); assert.ok(h.bitmaps.every(bitmap => bitmap.closes === 1))
})

test('async upload retains bitmap, continues acquisition, and permits no overlapping consumption', bounded, async t => {
    const h = setup(t); let resolve
    h.onUpload = () => new Promise(done => { resolve = done })
    const owner = h.start(); await h.deliver(100); await h.deliver(200); owner.consume()
    await h.deliver(300); owner.consume(); assert.equal(h.uploads.length, 1); assert.equal(h.bitmaps[0].closes, 0)
    const stopped = owner.stop(); assert.equal(h.bitmaps[1].closes, 1); assert.equal(h.bitmaps[2].closes, 1)
    let settled = false; stopped.then(() => { settled = true }); await flush(); assert.equal(settled, false)
    resolve({ width: 1920, height: 1080 }); await stopped
    assert.equal(h.bitmaps[0].closes, 1); assert.equal(h.readers[0].cancels, 1); assert.equal(h.readers[0].releases, 1)
})

test('stop during conversion closes frame immediately and eventual bitmap without upload', bounded, async t => {
    const h = setup(t); h.delayBitmap = true
    const owner = h.start(), frame = await h.deliver(100)
    assert.equal(frame.closes, 1)
    const stopped = owner.stop(); h.delayedBitmap(); await stopped
    assert.equal(h.bitmaps[0].closes, 1); assert.equal(h.uploads.length, 0)
})

test('source change and reentrant upload failure close resources and stop ownership', bounded, async t => {
    const h = setup(t), owner = h.start()
    await h.deliver(100); await h.deliver(200)
    h.onUpload = () => { owner.stop(); throw new Error('upload failed') }
    owner.consume(); await owner.stop()
    assert.equal(h.errors.length, 1); assert.equal(h.uploads.length, 1); assert.ok(h.bitmaps.every(bitmap => bitmap.closes === 1))
})

test('source invalidation while a read is pending closes arriving frame before conversion', bounded, async t => {
    const h = setup(t), owner = h.start()
    h.current = false; const frame = await h.deliver(100); await owner.stop()
    assert.equal(frame.closes, 1); assert.equal(h.bitmaps.length, 0); assert.equal(h.uploads.length, 0)
})

test('bitmap rejection reports once and closes every queued resource', bounded, async t => {
    const h = setup(t), owner = h.start(); await h.deliver(100)
    globalThis.createImageBitmap = () => Promise.reject(new Error('bitmap failed'))
    const frame = await h.deliver(200); await owner.stop()
    assert.equal(frame.closes, 1); assert.equal(h.bitmaps[0].closes, 1); assert.equal(h.errors.length, 1); assert.equal(owner.active, false)
})

test('VideoFrame instances bypass createImageBitmap and queue directly to upload', bounded, async t => {
    let bitmapCalls = 0
    class MockVideoFrame {
        constructor(timestamp) {
            this.timestamp = timestamp
            this.displayWidth = 1920
            this.displayHeight = 1080
            this.width = 1920
            this.height = 1080
            this.closes = 0
        }
        close() { this.closes++ }
    }
    globalThis.VideoFrame = MockVideoFrame
    globalThis.createImageBitmap = () => {
        bitmapCalls++
        return Promise.resolve({ width: 1920, height: 1080, close() {} })
    }
    const h = setup(t)
    h.deliver = async timestamp => {
        const frame = new MockVideoFrame(timestamp)
        h.frames.push(frame)
        const reader = h.readers.at(-1), { resolve } = reader.pending
        reader.pending = null
        resolve({ done: false, value: frame })
        await flush()
        return frame
    }
    const owner = h.start()
    const f1 = await h.deliver(100)
    const f2 = await h.deliver(200)
    owner.consume()
    assert.equal(bitmapCalls, 0)
    assert.equal(h.uploads.length, 1)
    assert.equal(h.uploads[0], f1)
    owner.consume()
    assert.equal(h.uploads.length, 2)
    assert.equal(h.uploads[1], f2)
    await owner.stop()
    assert.equal(f1.closes, 1)
    assert.equal(f2.closes, 1)
})

test('useNativeShm streams frames via subscriber without MediaStreamTrackProcessor', bounded, async () => {
    class MockVideoFrame {
        constructor(buffer, options) {
            this.buffer = buffer
            this.options = options
            this.width = options.codedWidth
            this.height = options.codedHeight
            this.timestamp = options.timestamp
            this.closes = 0
        }
        close() { this.closes++ }
    }
    globalThis.VideoFrame = MockVideoFrame

    const track = Object.assign(new EventTarget(), { kind: 'video', label: 'Sync Camera', readyState: 'live' })
    let subscriber = null
    let unsubscribes = 0
    const uploads = []
    const errors = []

    const owner = new SyncCameraFrameQueue(track, {
        useNativeShm: true,
        shmSubscriber: (cb) => {
            subscriber = cb
            return () => { unsubscribes++ }
        },
        isCurrent: () => true,
        upload: (bitmap) => { uploads.push(bitmap); return { width: bitmap.width, height: bitmap.height } },
        onError: (err) => errors.push(err)
    })

    assert.ok(subscriber !== null)

    const buf1 = new ArrayBuffer(100)
    const buf2 = new ArrayBuffer(100)
    subscriber({ sequence: 1, presentationTimeUs: 1000, width: 1920, height: 1080, buffer: buf1 })
    subscriber({ sequence: 2, presentationTimeUs: 2000, width: 1920, height: 1080, buffer: buf2 })

    owner.consume()
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].timestamp, 1000)

    owner.consume()
    assert.equal(uploads.length, 2)
    assert.equal(uploads[1].timestamp, 2000)

    await owner.stop()
    assert.equal(unsubscribes, 1)
    assert.equal(uploads[0].closes, 1)
    assert.equal(uploads[1].closes, 1)
})

test('useNativeShm enforces timestamp watermark and reports error on regression', bounded, async () => {
    class MockVideoFrame {
        constructor(buffer, options) {
            this.buffer = buffer
            this.options = options
            this.width = options.codedWidth
            this.height = options.codedHeight
            this.timestamp = options.timestamp
            this.closes = 0
        }
        close() { this.closes++ }
    }
    globalThis.VideoFrame = MockVideoFrame

    const track = Object.assign(new EventTarget(), { kind: 'video', label: 'Sync Camera', readyState: 'live' })
    let subscriber = null
    const uploads = []
    const errors = []

    const owner = new SyncCameraFrameQueue(track, {
        useNativeShm: true,
        shmSubscriber: (cb) => {
            subscriber = cb
            return () => {}
        },
        isCurrent: () => true,
        upload: (bitmap) => { uploads.push(bitmap); return { width: bitmap.width, height: bitmap.height } },
        onError: (err) => errors.push(err)
    })

    subscriber({ sequence: 1, presentationTimeUs: 5000, width: 1920, height: 1080, buffer: new ArrayBuffer(10) })
    subscriber({ sequence: 2, presentationTimeUs: 4000, width: 1920, height: 1080, buffer: new ArrayBuffer(10) })

    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /timestamp/)
    assert.equal(owner.active, false)
    await owner.stop()
})
