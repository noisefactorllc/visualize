import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subscribeSyncCamera, createSyncCameraSession } from '../js/sync/cameraSession.js'

test('two decks share a native subscription and stopping one preserves the other', () => {
    let receiver, starts = 0, stops = 0
    const api = { subscribe(callback) { starts++; receiver = callback; return () => { stops++ } } }
    const first = [], second = []
    const stopFirst = subscribeSyncCamera(frame => first.push(frame), api)
    const stopSecond = subscribeSyncCamera(frame => second.push(frame), api)
    assert.equal(starts, 1)
    receiver(1)
    stopFirst()
    stopFirst()
    assert.equal(stops, 0)
    receiver(2)
    assert.deepEqual(first, [1])
    assert.deepEqual(second, [1, 2])
    stopSecond()
    assert.equal(stops, 1)
})

test('a changed camera stream stops its native subscription and reports failure once', async t => {
    const originals = Object.fromEntries(['MediaStreamTrackProcessor', 'VideoFrame', 'electronAPI'].map(key => [key, globalThis[key]]))
    t.after(() => { for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
    } })
    globalThis.MediaStreamTrackProcessor = class {}
    globalThis.VideoFrame = class {}
    let stops = 0
    globalThis.electronAPI = { syncCamera: { isAvailable: async () => true, subscribe: () => () => { stops++ } } }
    const track = Object.assign(new EventTarget(), { label: 'Sync Camera', kind: 'video', readyState: 'live' })
    const stream = Object.assign(new EventTarget(), { getVideoTracks: () => [track] })
    const errors = []
    const session = await createSyncCameraSession(track, { stream, isCurrent: () => true, upload() {}, onError: error => errors.push(error) })
    stream.dispatchEvent(new Event('removetrack'))
    stream.dispatchEvent(new Event('removetrack'))
    await session.stop()
    assert.equal(session.active, false)
    assert.equal(stops, 1)
    assert.equal(errors.length, 1)
    assert.match(errors[0].message, /track changed/)
})
