// Recorder — per-recording session isolation.
//
// MediaRecorder delivers a stopped recorder's final dataavailable and stop
// as queued tasks. A stop() immediately followed by start() in the same task
// (double-click on the record button, a fast toggle) therefore leaves the
// superseded recording's events pending while a newer recording is live.
// Each recording owns an isolated session: the superseded recording keeps
// appending to and finalizing its OWN session (it is still saved), while the
// live recording's chunk buffer and the recording UI state stay untouched.
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

test('a superseded recording is still finalized and downloaded, without touching the live recording', async () => {
    downloads.length = 0
    const { rec, stateEvents } = makeRecorder()
    assert.equal(rec.start(), true)   // recording A
    rec._recorder.emit(chunkOf(3))    // A captures a real chunk
    rec.stop()                        // A stops; its events queue as tasks
    assert.equal(rec.start(), true)   // recording B starts in the same task
    await settle()                    // A's stale events land while B is live
    // A is saved from its own session: its live chunk plus its final
    // dataavailable, downloaded even though B already started.
    assert.equal(downloads.length, 1)
    assert.equal(downloads[0].size, 6)
    // A's stop must not flip the live recording's UI state or clock.
    assert.deepEqual(stateEvents, [true, true])
    assert.equal(rec.isRecording, true)
    assert.ok(rec.elapsedMs >= 0)
    // B keeps recording into its own session and saves exactly its data.
    rec._recorder.emit(chunkOf(2))
    await stopQuietly(rec)
    assert.deepEqual(stateEvents, [true, true, false])
    assert.equal(downloads.length, 2)
    assert.equal(downloads[1].size, 4)
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
    // A's final chunk lands in A's own session, never in B's buffer, and
    // A's stale stop must not report "recording saved" for the live recording.
    assert.deepEqual(stateEvents, [true, true])
    await stopQuietly(rec)
    assert.deepEqual(stateEvents, [true, true, false])
    // A's blob (6 bytes: live + final 3-byte chunks) and B's blob
    // (4 bytes: live + final 2-byte chunks) — no cross-session splicing.
    assert.equal(downloads.length, 2)
    assert.deepEqual(downloads.map(b => b.size), [6, 4])
    downloads.length = 0
})

test('a superseded recording with no captured data finalizes silently', async () => {
    downloads.length = 0
    const { rec, stateEvents } = makeRecorder()
    assert.equal(rec.start(), true)   // recording A: stopped before its first timeslice
    rec.stop()
    assert.equal(rec.start(), true)   // recording B starts in the same task
    await settle()
    // A's session is empty: nothing to save, and no UI state change.
    assert.deepEqual(downloads, [])
    assert.deepEqual(stateEvents, [true, true])
    assert.equal(rec.isRecording, true)
    await stopQuietly(rec)
    assert.deepEqual(stateEvents, [true, true, false])
    downloads.length = 0
})
