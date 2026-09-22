/* global AudioWorkletProcessor, registerProcessor */
class SyncAudioBridgeProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super()
        const { channelCount, capacity = 16384, prefill = 1024, maxQueuedFrames } = options.processorOptions || {}
        this.channelCount = channelCount
        this.capacity = capacity
        this.maxQueuedFrames = maxQueuedFrames === undefined ? capacity
            : Math.max(1, Math.min(capacity, Math.floor(maxQueuedFrames)))
        this.prefill = maxQueuedFrames === undefined ? prefill : Math.min(prefill, this.maxQueuedFrames)
        this.buffers = Array.from({ length: channelCount }, () => new Float32Array(capacity))
        this.last = new Float32Array(channelCount)
        this.readIndex = 0
        this.writeIndex = 0
        this.available = 0
        this.primed = false
        this.port.onmessage = ({ data }) => this.enqueue(data)
    }

    enqueue(planes) {
        if (planes?.reset === true) {
            this.readIndex = this.writeIndex = this.available = 0
            this.primed = false
            this.last.fill(0)
            return
        }
        if (!Array.isArray(planes) || planes.length < this.channelCount) return
        const frames = planes[0].length
        if (frames === 0 || frames > this.capacity) return
        // Sync limits stale backlog, while retaining a whole valid packet even
        // when its duration exceeds the target at a low sample rate.
        const limit = Math.max(this.maxQueuedFrames, frames)
        const overflow = this.available + frames - limit
        if (overflow > 0) {
            this.readIndex = (this.readIndex + overflow) % this.capacity
            this.available -= overflow
        }
        for (let channel = 0; channel < this.channelCount; channel++) {
            const plane = planes[channel]
            const buffer = this.buffers[channel]
            const head = Math.min(frames, this.capacity - this.writeIndex)
            buffer.set(plane.subarray(0, head), this.writeIndex)
            if (head < frames) buffer.set(plane.subarray(head), 0)
        }
        this.writeIndex = (this.writeIndex + frames) % this.capacity
        this.available += frames
        if (this.available >= this.prefill) this.primed = true
    }

    process(inputs, outputs) {
        const output = outputs[0]
        if (!output || output.length === 0) return true
        const frames = output[0].length
        const count = this.primed ? Math.min(frames, this.available) : 0
        for (let channel = 0; channel < output.length; channel++) {
            const out = output[channel]
            const buffer = this.buffers[channel]
            if (!buffer) { out.fill(0); continue }
            for (let i = 0; i < count; i++) out[i] = buffer[(this.readIndex + i) % this.capacity]
            if (count > 0) this.last[channel] = out[count - 1]
            if (count < frames) out.fill(this.last[channel], count)
        }
        this.readIndex = (this.readIndex + count) % this.capacity
        this.available -= count
        if (this.available === 0) this.primed = false
        return true
    }
}

registerProcessor('sync-audio-bridge', SyncAudioBridgeProcessor)

class SyncAudioInputProcessor extends AudioWorkletProcessor {
    process(inputs, outputs) {
        const channels = inputs[0] || []
        if (channels.length > 0) {
            const means = channels.map(samples => {
                if (samples.length === 0) return 0
                let sum = 0
                for (let i = 0; i < samples.length; i++) sum += samples[i]
                return sum / samples.length
            })
            this.port.postMessage(means)
        }

        for (const output of outputs) {
            for (const channel of output) channel.fill(0)
        }
        return true
    }
}

registerProcessor('sync-audio-input', SyncAudioInputProcessor)
