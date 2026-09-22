import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSyncAudioInput } from '../js/sync/audioInput.js'
import { createSyncCredentialStore } from '../js/sync/credentials.js'

const welcome = { capabilities: { providers: [{ id: 'audio', available: true, selected: true }] } }
const sources = [{ id: 'interface', name: 'Studio interface', channelCount: 8, sampleRate: 48000 }]

test('native audio discovery pairs only on explicit connect and shares the resulting grant', async () => {
    const credentials = createSyncCredentialStore()
    const calls = []
    class Client {
        constructor(options = {}) { calls.push(['client', options.token]) }
        async pair(name) { calls.push(['pair', name]); return { token: 'grant' } }
        async connect() { return welcome }
        async listAudioSources() { return sources }
        close() { calls.push(['close']) }
    }
    const audio = createSyncAudioInput({ Client, credentialStore: credentials, appName: 'Visualize' })
    assert.deepEqual(await audio.refreshSyncAudioDevices(), [])
    assert.equal(calls.length, 0)
    const [a, b] = await Promise.all([audio.connectSyncAudio(), audio.connectSyncAudio()])
    assert.deepEqual(a, b)
    assert.equal(a[0].id, 'sync-audio:interface')
    assert.equal(a[0].channelCount, 8)
    assert.equal(credentials.current().token, 'grant')
    assert.deepEqual(calls.filter(c => c[0] === 'pair'), [['pair', 'Visualize audio']])
    await audio.refreshSyncAudioDevices()
    assert.equal(calls.filter(c => c[0] === 'pair').length, 1)
})

test('audio consent upgrade rotates video grant once and failed refresh marks sources unavailable', async () => {
    const credentials = createSyncCredentialStore()
    credentials.publish('video-grant')
    let pairs = 0
    let unavailable = false
    class Client {
        constructor({ token } = {}) { this.token = token }
        async pair() { pairs++; return { token: 'audio-grant' } }
        async connect() { if (unavailable) throw new Error('offline'); return welcome }
        async listAudioSources() {
            if (this.token === 'video-grant') throw Object.assign(new Error('consent required'), { daemonCode: 'audio_pairing_required' })
            return sources
        }
        close() {}
    }
    const audio = createSyncAudioInput({ Client, credentialStore: credentials })
    await audio.connectSyncAudio()
    assert.equal(pairs, 1)
    assert.equal(credentials.current().token, 'audio-grant')
    unavailable = true
    assert.equal((await audio.refreshSyncAudioDevices())[0].connected, false)
    assert.equal(pairs, 1)
})

test('abort closes a native client while opening and rejects late completion', async () => {
    const credentials = createSyncCredentialStore()
    credentials.publish('grant')
    let finish
    let closes = 0
    class Client {
        openAudioSource() { return new Promise(resolve => { finish = resolve }) }
        close() { closes++ }
    }
    const audio = createSyncAudioInput({ Client, credentialStore: credentials })
    const abort = new AbortController()
    const pending = audio.openSyncAudioSource('sync-audio:interface', () => {}, { signal: abort.signal })
    abort.abort()
    assert.equal(closes, 1)
    finish({ sampleRate: 48000, channelCount: 8 })
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(closes, 1)
})

test('late discovery failure cannot invalidate a newer successful inventory', async () => {
    const credentials = createSyncCredentialStore()
    credentials.publish('grant')
    let rejectFirst, calls = 0
    class Client {
        async connect() { return welcome }
        listAudioSources() {
            if (++calls === 1) return new Promise((resolve, reject) => { rejectFirst = reject })
            return Promise.resolve(sources)
        }
        close() {}
    }
    const audio = createSyncAudioInput({ Client, credentialStore: credentials })
    const older = audio.refreshSyncAudioDevices()
    await Promise.resolve()
    await audio.refreshSyncAudioDevices()
    rejectFirst(new Error('old connection failed'))
    await older
    assert.equal(audio.getSyncAudioDevices()[0].connected, true)
})
