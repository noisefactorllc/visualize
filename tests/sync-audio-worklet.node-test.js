import test from 'node:test'
import assert from 'node:assert/strict'

// The worklet module is a plain script that registers two processors with the
// globals an AudioWorkletGlobalScope provides. Node caches it by path, so load
// it once here and hand both constructors to the tests below.
const posted = []
const processors = new Map()
globalThis.AudioWorkletProcessor = class {
    constructor() {
        this.port = { onmessage: null, postMessage: value => posted.push(value) }
    }
}
globalThis.registerProcessor = (name, ctor) => processors.set(name, ctor)
await import('../js/sync/audioWorklet.js')

test('audio input worklet preserves signed DC and reports every input channel', () => {
    const Processor = processors.get('sync-audio-input')
    const processor = new Processor()
    const output = new Float32Array([1, 1, 1, 1])
    const keepAlive = processor.process([[
        new Float32Array([-1, -0.5, -0.5, 0]),
        new Float32Array([0.25, 0.5, 0.5, 0.75])
    ]], [[output]])

    assert.equal(keepAlive, true)
    assert.deepEqual(posted, [[-0.5, 0.5]])
    assert.deepEqual([...output], [0, 0, 0, 0], 'worklet output must remain silent')
})

test('audio bridge worklet plays queued planar frames and holds the last sample on underrun', () => {
    const Bridge = processors.get('sync-audio-bridge')
    const bridge = new Bridge({ processorOptions: { channelCount: 2, capacity: 16, prefill: 4 } })
    const render = () => {
        const output = [new Float32Array(4).fill(9), new Float32Array(4).fill(9)]
        assert.equal(bridge.process([], [output]), true)
        return output.map(channel => [...channel])
    }
    const post = planes => bridge.port.onmessage({ data: planes.map(plane => new Float32Array(plane)) })
    const single = rows => rows.map(row => row.map(value => Math.fround(value)))

    // Nothing queued yet: silence, not garbage.
    assert.deepEqual(render(), [[0, 0, 0, 0], [0, 0, 0, 0]])

    // Below the prefill, output still waits.
    post([[0.1, 0.2], [-0.1, -0.2]])
    assert.deepEqual(render(), [[0, 0, 0, 0], [0, 0, 0, 0]])

    // Reaching the prefill releases the queue in order, per channel, signed.
    post([[0.3, 0.4, 0.5, 0.6], [-0.3, -0.4, -0.5, -0.6]])
    assert.deepEqual(render(), single([[0.1, 0.2, 0.3, 0.4], [-0.1, -0.2, -0.3, -0.4]]))

    // Underrun holds each channel's last sample instead of dropping to zero.
    assert.deepEqual(render(), single([[0.5, 0.6, 0.6, 0.6], [-0.5, -0.6, -0.6, -0.6]]))
    assert.deepEqual(render(), single([[0.6, 0.6, 0.6, 0.6], [-0.6, -0.6, -0.6, -0.6]]))

    // Overflow keeps the newest frames: 20 into a capacity of 16 drops the oldest four.
    post([Array.from({ length: 10 }, (_, i) => i + 1), Array.from({ length: 10 }, (_, i) => -(i + 1))])
    post([Array.from({ length: 10 }, (_, i) => i + 11), Array.from({ length: 10 }, (_, i) => -(i + 11))])
    assert.deepEqual(render(), [[5, 6, 7, 8], [-5, -6, -7, -8]])
    assert.deepEqual(render(), [[9, 10, 11, 12], [-9, -10, -11, -12]])
})

test('a native discontinuity clears queued samples and held control values', () => {
    const Bridge = processors.get('sync-audio-bridge')
    const bridge = new Bridge({ processorOptions: { channelCount: 1, capacity: 16, prefill: 4 } })
    bridge.enqueue([new Float32Array(8).fill(0.8)])
    bridge.process([], [[new Float32Array(4)]])
    bridge.port.onmessage({ data: { reset: true } })
    const output = new Float32Array(4).fill(9)
    bridge.process([], [[output]])
    assert.deepEqual([...output], [0, 0, 0, 0])
    bridge.enqueue([new Float32Array(4).fill(-0.5)])
    bridge.process([], [[output]])
    assert.deepEqual([...output], [-0.5, -0.5, -0.5, -0.5])
})

test('Sync backlog keeps the newest aligned frames through ring wrap and holds the newest CV', { timeout: 1000 }, () => {
    const Bridge = processors.get('sync-audio-bridge')
    const bridge = new Bridge({ processorOptions: {
        channelCount: 3, capacity: 4096, prefill: 512, maxQueuedFrames: 576
    } })
    const channelValue = (frame, channel) => channel === 0 ? frame : channel === 1 ? -frame : frame + 10000
    // Twelve 10ms packets at 48kHz cross the storage ring and exceed the 12ms
    // freshness target. The first rendered frame must come from the newest 576.
    for (let packet = 0; packet < 12; packet++) {
        bridge.enqueue(Array.from({ length: 3 }, (_, channel) =>
            Float32Array.from({ length: 480 }, (_, index) => channelValue(packet * 480 + index, channel))))
    }
    for (let quantum = 0; quantum < 6; quantum++) {
        const output = Array.from({ length: 3 }, () => new Float32Array(128))
        bridge.process([], [output])
        for (let channel = 0; channel < output.length; channel++) {
            const expected = Array.from({ length: 128 }, (_, index) =>
                channelValue(Math.min(5184 + quantum * 128 + index, 5759), channel))
            assert.deepEqual([...output[channel]], expected)
        }
    }
    bridge.port.onmessage({ data: { reset: true } })
    const cleared = Array.from({ length: 3 }, () => new Float32Array(128).fill(9))
    bridge.process([], [cleared])
    for (const channel of cleared) assert.deepEqual([...channel], Array(128).fill(0))
})

test('Sync freshness target accommodates a whole low-rate packet and clamps prefill', { timeout: 1000 }, () => {
    const Bridge = processors.get('sync-audio-bridge')
    // At 8kHz the 12ms target is only 96 frames. A valid 480-frame packet must
    // play intact, and a packet reaching the target must not wait for 512 frames.
    const bridge = new Bridge({ processorOptions: {
        channelCount: 2, capacity: 4096, prefill: 512, maxQueuedFrames: 96
    } })
    const post = (start, length) => bridge.enqueue([
        Float32Array.from({ length }, (_, index) => start + index),
        Float32Array.from({ length }, (_, index) => -(start + index))
    ])
    post(1, 96)
    const initial = [new Float32Array(128), new Float32Array(128)]
    bridge.process([], [initial])
    assert.deepEqual([...initial[0]], Array.from({ length: 128 }, (_, index) => Math.min(index + 1, 96)))
    assert.deepEqual([...initial[1]], [...initial[0]].map(value => -value))

    post(1000, 480)
    post(2000, 480)
    for (let quantum = 0; quantum < 4; quantum++) {
        const output = [new Float32Array(128), new Float32Array(128)]
        bridge.process([], [output])
        const expected = Array.from({ length: 128 }, (_, index) => Math.min(2000 + quantum * 128 + index, 2479))
        assert.deepEqual([...output[0]], expected)
        assert.deepEqual([...output[1]], expected.map(value => -value))
    }
})

test('browser bridge without a Sync freshness target retains its existing capacity backlog', { timeout: 1000 }, () => {
    const Bridge = processors.get('sync-audio-bridge')
    const bridge = new Bridge({ processorOptions: { channelCount: 1, capacity: 4096, prefill: 512 } })
    for (let packet = 0; packet < 12; packet++) {
        bridge.enqueue([Float32Array.from({ length: 480 }, (_, index) => packet * 480 + index)])
    }
    const output = new Float32Array(128)
    bridge.process([], [[output]])
    assert.deepEqual([...output], Array.from({ length: 128 }, (_, index) => 1664 + index))
})

test('32 discrete channels routed through audio bridge preserve channel ordering with zero crosstalk', () => {
    const Bridge = processors.get('sync-audio-bridge')
    const bridge = new Bridge({ processorOptions: { channelCount: 32, capacity: 4096, prefill: 128 } })

    // Step 1: Linear discrete ramps across all 32 channels
    const rampPlanes = Array.from({ length: 32 }, (_, c) => {
        const val = Math.fround((c + 1) / 32)
        return new Float32Array(256).fill(val)
    })
    bridge.enqueue(rampPlanes)

    const rampOutput = Array.from({ length: 32 }, () => new Float32Array(128))
    const keepAlive = bridge.process([], [rampOutput])
    assert.equal(keepAlive, true)
    assert.equal(rampOutput.length, 32)

    for (let c = 0; c < 32; c++) {
        const expected = Math.fround((c + 1) / 32)
        for (let i = 0; i < 128; i++) {
            assert.equal(rampOutput[c][i], expected, `channel ${c + 1} sample ${i} mismatch`)
        }
    }

    // Step 2: Stepped pulse test - pulse channel 15 only, all others zero
    bridge.port.onmessage({ data: { reset: true } })
    const pulsePlanes = Array.from({ length: 32 }, (_, c) => {
        const val = (c === 15) ? 1.0 : 0.0
        return new Float32Array(256).fill(val)
    })
    bridge.enqueue(pulsePlanes)

    const pulseOutput = Array.from({ length: 32 }, () => new Float32Array(128))
    bridge.process([], [pulseOutput])

    for (let i = 0; i < 128; i++) {
        assert.equal(pulseOutput[15][i], 1.0, `pulsed channel 16 must be 1.0 at sample ${i}`)
    }
    for (let c = 0; c < 32; c++) {
        if (c === 15) continue
        for (let i = 0; i < 128; i++) {
            assert.equal(pulseOutput[c][i], 0.0, `silent channel ${c + 1} must have strictly 0.0 crosstalk at sample ${i}`)
        }
    }
})

test('32 discrete channels routed through raw audio input processor report exact per-channel means', () => {
    const Processor = processors.get('sync-audio-input')
    const processor = new Processor()
    const postedMessages = []
    processor.port.postMessage = value => postedMessages.push(value)

    const inputChannels = Array.from({ length: 32 }, (_, c) => {
        const val = Math.fround((c + 1) / 32)
        return new Float32Array(128).fill(val)
    })
    const dummyOutput = [new Float32Array(128)]
    const keepAlive = processor.process([inputChannels], [dummyOutput])

    assert.equal(keepAlive, true)
    assert.equal(postedMessages.length, 1)
    assert.equal(postedMessages[0].length, 32)

    for (let c = 0; c < 32; c++) {
        const expected = Math.fround((c + 1) / 32)
        assert.ok(Math.abs(postedMessages[0][c] - expected) < 1e-6, `channel ${c + 1} mean mismatch: ${postedMessages[0][c]} vs ${expected}`)
    }
})
