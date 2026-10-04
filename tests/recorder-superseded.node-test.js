// Recorder — superseded-recorder event isolation.
//
// MediaRecorder delivers a stopped recorder's final dataavailable and stop
// as queued tasks. A stop() immediately followed by start() in the same task
// (double-click on the record button, a fast toggle) therefore leaves the
// superseded recorder's events pending while a newer recording is live.
// Those stale events must not touch the live recording's chunk buffer or
// the recording UI state.
import test from 'node:test'
import assert from 'node:assert/strict'

import { Recorder } from '../js/recorder.js'

// ── Browser globals stub ─────────────────────────────────────────────
// A fake MediaRecorder that follows the spec ordering the fix relies on:
// stop() flips state to inactive synchronously, then queues
// dataavailable(final chunk) + stop as tasks.
class FakeMediaRecorder {
    static isTypeSupported() { return true }
    constructor(stream, opts) {
        this.state = 'inactive'
        this.stream = stream
        this.opts = opts
        this._finalChunk = null
    }
    start() { this.state = 'recording' }
    stop() {
        if (this.state === 'inactive') return
        this.state = 'inactive'
        const finalChunk = this._finalChunk
        queueMicrotask(() => { this.ondataavailable?.({ data: finalChunk }) })
        queueMicrotask(() => { this.onstop?.() })
    }
    // Deliver a chunk now and remember it as this recording's final chunk,
    // the way a real recorder's last timeslice dataavailable does.
    emit(data) { this._finalChunk = data; this.ondataavailable?.({ data }) }
}

// Installed before any Recorder is constructed (the constructor reads
// MediaRecorder for mime selection).
globalThis.MediaRecorder = FakeMediaRecorder
globalThis.HTMLCanvasElement = class HTMLCanvasElement {}
globalThis.HTMLCanvasElement.prototype.captureStream = () => ({})
const downloads = []
globalThis.URL.createObjectURL = (blob) => { downloads.push(blob); return 'blob:test' }
globalThis.URL.revokeObjectURL = () => {}
globalThis.document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ click() {}, remove() {}, href: '' }),
}

function makeRecorder() {
    const canvas = { captureStream: () => ({}) }
    const stateEvents = []
    const rec = new Recorder(canvas, { onStateChange: (s) => stateEvents.push(s) })
    return { rec, stateEvents }
}

// A MediaRecorder dataavailable payload is a Blob (carrying .size, which the
// Recorder filters on) — not a bare Uint8Array.
function chunkOf(n) { return new Blob([new Uint8Array(n).fill(7)]) }

async function settle() {
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
}

function stopQuietly(rec) {
    rec.stop()
    return settle()
}

test('a normal stop still finalizes the recording', async () => {
    downloads.length = 0
    const { rec, stateEvents } = makeRecorder()
    assert.equal(rec.start(), true)
    rec._recorder.emit(chunkOf(3))
    rec.stop()
    await settle()
    assert.deepEqual(stateEvents, [true, false])
    // The live chunk plus the recorder's final dataavailable: 2 × 3 bytes.
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0].size, 6)
    await stopQuietly(rec)
})

test('a superseded recorder cannot flip the live recording\'s state or clock', async () => {
    downloads.length = 0
    const { rec, stateEvents } = makeRecorder()
    assert.equal(rec.start(), true)   // recording A
    rec._recorder.emit(chunkOf(3))
    rec.stop()                        // A stops; its events queue as tasks
    assert.equal(rec.start(), true)   // recording B starts in the same task
    await settle()                    // A's stale events land while B is live
    assert.deepEqual(stateEvents, [true, true])
    assert.equal(rec.isRecording, true)
    assert.ok(rec.elapsedMs >= 0)
    // B's pre-stale chunk must have survived; its final recording reflects it.
    rec._recorder.emit(chunkOf(2))
    await stopQuietly(rec)
    assert.deepEqual(stateEvents, [true, true, false])
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0].size, 4)
    downloads.length = 0
})

test('a superseded recorder\'s queued chunk does not contaminate the live recording', async () => {
    downloads.length = 0
    const { rec, stateEvents } = makeRecorder()
    assert.equal(rec.start(), true)   // recording A
    rec._recorder.emit(chunkOf(3))   // A's last timeslice
    rec.stop()                        // queues A's final dataavailable(3 bytes) + stop
    assert.equal(rec.start(), true)   // recording B starts in the same task
    rec._recorder.emit(chunkOf(2))      // B captures its own data
    await settle()                    // A's stale events land
    // A's 3-byte final chunk must not be spliced into B's recording, and A's
    // stale stop must not report "recording saved" for the live recording.
    assert.deepEqual(stateEvents, [true, true])
    await stopQuietly(rec)
    assert.deepEqual(stateEvents, [true, true, false])
    assert.equal(downloads.length, 1)
    // Exactly B's live + final chunks (2 × 2 bytes) — A's 3-byte chunk absent.
    assert.equal(downloads[0].size, 4)
    downloads.length = 0
})
