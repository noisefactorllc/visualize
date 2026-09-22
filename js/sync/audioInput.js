import { SyncBridgeClient } from './audio.js'
import { syncCredentialStore } from './credentials.js'

export const SYNC_AUDIO_PREFIX = 'sync-audio:'
export function isSyncAudioSource(id) {
    return typeof id === 'string' && id.startsWith(SYNC_AUDIO_PREFIX)
}

export function createSyncAudioInput({
    Client = SyncBridgeClient,
    credentialStore = syncCredentialStore,
    appName = 'Visualize',
    workletUrl = new URL('./audioWorklet.js', import.meta.url).href
} = {}) {
    let connecting
    let discoveryGeneration = 0
    let devices = []
    let pairingRequiredCredential

    function handleCredentialFailure(error, credential) {
        if (error.code === 'SYNC_AUTHENTICATION') {
            credentialStore.clear(credential)
            if (pairingRequiredCredential === credential) pairingRequiredCredential = undefined
        } else if (error.daemonCode === 'audio_pairing_required' &&
            credentialStore.current() === credential) {
            pairingRequiredCredential = credential
        }
    }

    function getSyncAudioDevices() {
        return devices.map(device => ({ ...device }))
    }

    function connectSyncAudio() {
        if (connecting) return connecting
        connecting = Promise.resolve().then(async () => {
            const generation = ++discoveryGeneration
            let client
            let credential
            let paired = false
            const pair = async () => {
                paired = true
                client?.close()
                client = new Client()
                credential = credentialStore.publish(
                    (await client.pair(`${appName} audio`)).token
                )
                pairingRequiredCredential = undefined
                client.close()
            }
            const discover = async () => {
                client = new Client({ token: credential.token })
                const welcome = await client.connect()
                if (!welcome.capabilities.providers.some(provider => provider.id === 'audio' && provider.available && provider.selected))
                    throw new Error('Update Sync to a version that supports audio input')
                return client.listAudioSources()
            }
            try {
                credential = credentialStore.current()
                if (!credential || credential === pairingRequiredCredential) await pair()
                let sources
                try {
                    sources = await discover()
                } catch (error) {
                    handleCredentialFailure(error, credential)
                    if (error.daemonCode !== 'audio_pairing_required' || paired) throw error
                    client.close()
                    const current = credentialStore.current()
                    // A stale rejection must not force pairing over a newer grant.
                    // Otherwise this explicit click may ask for native consent once.
                    if (current && current !== credential) credential = current
                    else await pair()
                    sources = await discover()
                }
                if (generation !== discoveryGeneration) return getSyncAudioDevices()
                devices = sources.map(source => ({
                    id: SYNC_AUDIO_PREFIX + source.id,
                    name: `${source.name} · Sync`,
                    channelCount: source.channelCount,
                    sampleRate: source.sampleRate,
                    connected: true
                }))
                pairingRequiredCredential = undefined
                return getSyncAudioDevices()
            } catch (error) {
                handleCredentialFailure(error, credential)
                if (generation === discoveryGeneration) devices = devices.map(device => ({ ...device, connected: false }))
                throw error
            } finally {
                client?.close()
                connecting = null
            }
        })
        return connecting
    }

    async function refreshSyncAudioDevices() {
        if (connecting) return connecting.catch(() => getSyncAudioDevices())
        const generation = ++discoveryGeneration
        const credential = credentialStore.current()
        if (!credential) {
            devices = devices.map(device => ({ ...device, connected: false }))
            return getSyncAudioDevices()
        }
        let client
        try {
            client = new Client({ token: credential.token })
            const welcome = await client.connect()
            if (!welcome.capabilities.providers.some(provider => provider.id === 'audio' && provider.available && provider.selected)) {
                if (generation === discoveryGeneration) devices = devices.map(device => ({ ...device, connected: false }))
                return getSyncAudioDevices()
            }
            const sources = await client.listAudioSources()
            if (generation !== discoveryGeneration) return getSyncAudioDevices()
            devices = sources.map(source => ({
                id: SYNC_AUDIO_PREFIX + source.id,
                name: `${source.name} · Sync`,
                channelCount: source.channelCount,
                sampleRate: source.sampleRate,
                connected: true
            }))
            pairingRequiredCredential = undefined
            return getSyncAudioDevices()
        } catch (error) {
            handleCredentialFailure(error, credential)
            if (generation === discoveryGeneration) devices = devices.map(device => ({ ...device, connected: false }))
            return getSyncAudioDevices()
        } finally {
            client?.close()
        }
    }

    async function openSyncAudioSource(id, onError = () => {}, { signal } = {}) {
        if (!isSyncAudioSource(id)) throw new TypeError('Invalid Sync audio source')
        signal?.throwIfAborted()
        const credential = credentialStore.current()
        if (!credential) throw new Error('Connect Sync audio before selecting its inputs')
        const sourceId = id.slice(SYNC_AUDIO_PREFIX.length)
        const client = new Client({ token: credential.token })
        let context
        let node
        let sink
        let active = true
        let timer
        let wake
        const pause = milliseconds => new Promise(resolve => {
            wake = resolve
            timer = setTimeout(resolve, milliseconds)
        })
        const stop = () => {
            if (!active) return
            active = false
            clearTimeout(timer)
            wake?.()
            signal?.removeEventListener('abort', stop)
            client.close() // Connection ownership releases the native capture.
            try { node?.disconnect() } catch {}
            try { sink?.disconnect() } catch {}
            void context?.close().catch(() => {})
        }
        signal?.addEventListener('abort', stop, { once: true })
        try {
            const format = await client.openAudioSource(sourceId)
            signal?.throwIfAborted()
            context = new AudioContext({ sampleRate: format.sampleRate })
            if (context.sampleRate !== format.sampleRate) throw new Error('Sync audio sample rate is unsupported')
            await context.audioWorklet.addModule(workletUrl)
            signal?.throwIfAborted()
            const maxQueuedFrames = Math.max(1, Math.min(4096, Math.floor(context.sampleRate * 0.012)))
            node = new AudioWorkletNode(context, 'sync-audio-bridge', {
                numberOfInputs: 0, numberOfOutputs: 1,
                outputChannelCount: [format.channelCount],
                processorOptions: { channelCount: format.channelCount, capacity: 4096, prefill: 512, maxQueuedFrames }
            })
            // Keep the capture graph running for band-only consumers too.
            sink = context.createGain()
            sink.gain.value = 0
            node.connect(sink).connect(context.destination)
            await context.resume()
            signal?.throwIfAborted()
            let nextFrame = null
            let droppedFrames = null
            ;(async () => {
                try {
                    while (active) {
                        if (context.state !== 'running') { await pause(25); continue }
                        const packet = await client.readAudioSource(sourceId)
                        if (!active) return
                        if (packet.channelCount !== format.channelCount || packet.sampleRate !== context.sampleRate)
                            throw new Error('Sync audio format changed; reconnect the input')
                        if (packet.frameCount === 0) { await pause(3); continue }
                        if (nextFrame !== null && (packet.firstFrame !== nextFrame || packet.droppedFrames !== droppedFrames))
                            node.port.postMessage({ reset: true })
                        nextFrame = packet.firstFrame + BigInt(packet.frameCount)
                        droppedFrames = packet.droppedFrames
                        node.port.postMessage(packet.planes, packet.planes.map(plane => plane.buffer))
                    }
                } catch (error) {
                    if (!active) return
                    stop()
                    discoveryGeneration++
                    devices = devices.map(device => device.id === id ? { ...device, connected: false } : device)
                    onError(error)
                }
            })()
            return { context, source: node, channelCount: format.channelCount,
                bridge: { node, stop } }
        } catch (error) {
            stop()
            await context?.close().catch(() => {})
            handleCredentialFailure(error, credential)
            throw error
        }
    }

    return Object.freeze({ getSyncAudioDevices, connectSyncAudio, refreshSyncAudioDevices, openSyncAudioSource })
}

export const { getSyncAudioDevices, connectSyncAudio, refreshSyncAudioDevices, openSyncAudioSource } = createSyncAudioInput()
