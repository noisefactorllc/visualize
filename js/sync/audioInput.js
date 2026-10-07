import { SyncBridgeClient } from './audio.js'
import { syncCredentialStore } from './credentials.js'
import { SyncLifecycleError, SyncUnavailableError } from './sdk/0.3.3/browser/index.js'

export const SYNC_AUDIO_PREFIX = 'sync-audio:'
export function isSyncAudioSource(id) {
    return typeof id === 'string' && id.startsWith(SYNC_AUDIO_PREFIX)
}

export function syncAudioBufferFrames(sampleRate) {
    const capacity = Math.max(4096, Math.min(65536, Math.ceil(sampleRate * 0.25)))
    const prefill = Math.min(capacity, Math.ceil(sampleRate * 0.12))
    const maxQueuedFrames = Math.min(capacity, Math.ceil(sampleRate * 0.18))
    return { capacity, prefill, maxQueuedFrames }
}

// The native daemon closes a control connection whose hello is delayed past
// its 1s hello deadline (server.cpp kControlHelloDeadlineMs) or whose exchange
// misses its 2s data-message deadline (kDataMessageDeadlineMs). A busy main
// thread — fullApp decks rendering under software rasterization — delays the
// handshake in ~500ms bursts, so a fresh connect can lose that race
// (evidence: m143-dbg6.log, socket open then 1008 close ~1.1s later). Two
// shapes of transient loss exist: the socket dying before the welcome
// (SyncUnavailableError) and the daemon closing a connected session
// mid-exchange (SyncLifecycleError 'control connection closed').
export function isTransientConnectLoss(error) {
    return error instanceof SyncUnavailableError ||
        (error instanceof SyncLifecycleError && error.message === 'control connection closed')
}

// Bounded delayed retries turn that transient loss into a normal connect
// instead of surfacing it as an error to the user. Each attempt (including
// the last) is preceded by the abort check, so a cancelled selection never
// opens a fresh native capture during backoff.
export async function retryUnavailable(retry, { attempts = 3, delay = 600, signal } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        signal?.throwIfAborted()
        try {
            return await retry()
        } catch (error) {
            if (!isTransientConnectLoss(error) || attempt === attempts) throw error
            await new Promise(resolve => setTimeout(resolve, delay))
            delay *= 2
        }
    }
}

// Sync's contract for readAudioSource() (sync docs/developers.md and
// browser/README.md): reset queued browser audio when firstFrame stops
// following the preceding frame cursor or droppedFrames changes. Any
// discontinuity means the queued frames are no longer contiguous with what
// the bridge already delivered, so it must flush. audioWorklet.js pairs this
// with a resume policy: a reset releases the start-of-stream prefill gate so
// a sustained run of drops under renderer load cannot starve playback and
// meters behind a prefill that keeps restarting.
export function syncAudioNeedsReset(nextFrame, droppedFrames, packet) {
    return nextFrame !== null &&
        (packet.firstFrame !== nextFrame || packet.droppedFrames !== droppedFrames)
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

    function pause(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds))
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
                    (await retryUnavailable(() => client.pair(`${appName} audio`))).token
                )
                pairingRequiredCredential = undefined
                client.close()
            }
            const discover = async () => {
                client?.close()
                client = new Client({ token: credential.token })
                const welcome = await client.connect()
                if (!welcome.capabilities.providers.some(provider => provider.id === 'audio' && provider.direction === 'receive' && provider.available && provider.selected))
                    throw new Error('Update Sync to a version that supports audio input')
                return client.listAudioSources()
            }
            try {
                credential = credentialStore.current()
                if (!credential || credential === pairingRequiredCredential) await pair()
                let sources
                try {
                    sources = await retryUnavailable(() => discover())
                } catch (error) {
                    handleCredentialFailure(error, credential)
                    if (error.daemonCode !== 'audio_pairing_required' || paired) throw error
                    client.close()
                    const current = credentialStore.current()
                    // A stale rejection must not force pairing over a newer grant.
                    // Otherwise this explicit click may ask for native consent once.
                    if (current && current !== credential) credential = current
                    else await pair()
                    sources = await retryUnavailable(() => discover())
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
            if (!welcome.capabilities.providers.some(provider => provider.id === 'audio' && provider.direction === 'receive' && provider.available && provider.selected)) {
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
        let client
        let format
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
            client?.close() // Connection ownership releases the native capture.
            try { node?.disconnect() } catch {}
            try { sink?.disconnect() } catch {}
            void context?.close().catch(() => {})
        }
        signal?.addEventListener('abort', stop, { once: true })
        try {
            signal?.throwIfAborted()
            // openAudioSource's control hello races the same 1s daemon
            // deadline as discovery (see retryUnavailable), so it gets the
            // same bounded delayed retries before giving up on the device.
            // Every attempt re-checks the abort signal before closing and
            // reopening the client, and a failed attempt closes the client
            // it created, so a cancelled or failed selection never leaves a
            // native capture open against later selections.
            format = await retryUnavailable(async () => {
                client?.close()
                client = new Client({ token: credential.token })
                try {
                    return await client.openAudioSource(sourceId)
                } catch (error) {
                    client?.close()
                    throw error
                }
            }, { signal })
            signal?.throwIfAborted()
            context = new AudioContext({ sampleRate: format.sampleRate })
            if (context.sampleRate !== format.sampleRate) throw new Error('Sync audio sample rate is unsupported')
            await context.audioWorklet.addModule(workletUrl)
            signal?.throwIfAborted()
            const bufferFrames = syncAudioBufferFrames(context.sampleRate)
            node = new AudioWorkletNode(context, 'sync-audio-bridge', {
                numberOfInputs: 0, numberOfOutputs: 1,
                outputChannelCount: [format.channelCount],
                processorOptions: { channelCount: format.channelCount, ...bufferFrames }
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
                        if (syncAudioNeedsReset(nextFrame, droppedFrames, packet))
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
