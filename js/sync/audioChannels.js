// Retain every native channel for device/channel selectors in audio() DSL.
export class SyncAudioChannels {
    constructor(capture, device) {
        this.device = { id: device.id, name: device.name, channelCount: capture.channelCount }
        this.states = new Set()
        this.raw = []
        const { context, source, channelCount } = capture
        this.splitter = context.createChannelSplitter(channelCount)
        source.connect(this.splitter)
        this.analysers = Array.from({ length: channelCount }, (_, channel) => {
            const analyser = context.createAnalyser()
            analyser.fftSize = 256
            analyser.smoothingTimeConstant = 0.8
            this.splitter.connect(analyser, channel)
            return analyser
        })
        this.tap = new AudioWorkletNode(context, 'sync-audio-input', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            channelCount, channelCountMode: 'explicit', channelInterpretation: 'discrete'
        })
        this.tap.port.onmessage = ({ data }) => { this.raw = data }
        source.connect(this.tap)
        this.tap.connect(context.destination) // The tap emits only silence.
    }

    update(states, sensitivity = 1) {
        const current = new Set(states)
        for (const previous of this.states) {
            if (current.has(previous)) continue
            previous.disconnectDevice?.(this.device.id)
            previous.disconnectDefaultInput?.()
            previous.setRawUnavailable?.()
        }
        this.states = current
        for (const state of current) {
            if (!state) continue
            state.registerDevice?.(this.device)
            state.registerDefaultChannels?.(this.device.channelCount)
            if (this.raw.length) state.setRaw?.(this.raw.reduce((sum, value) => sum + value, 0) / this.raw.length)
            for (let index = 0; index < this.analysers.length; index++) {
                const channel = index + 1
                for (const selector of [{ id: this.device.id, channel }, { channel }]) {
                    const selected = state.getDeviceChannelState?.(selector)
                    if (!selected) continue
                    selected.updateFromAnalyser?.(this.analysers[index], 3)
                    for (const band of ['low', 'mid', 'high', 'vol']) {
                        selected[band] = Math.min(1, selected[band] * sensitivity)
                    }
                    if (Number.isFinite(this.raw[index])) selected.setRaw?.(this.raw[index])
                }
            }
        }
    }

    stop() {
        this.tap.port.onmessage = null
        this.tap.disconnect()
        this.splitter.disconnect()
        for (const analyser of this.analysers) analyser.disconnect()
        for (const state of this.states) {
            state.disconnectDevice?.(this.device.id)
            state.disconnectDefaultInput?.()
            state.setRawUnavailable?.()
        }
        this.states.clear()
    }
}
