import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SharedAudio } from '../js/audio.js'

test('disabling while native capture opens cancels ownership and cannot enable later', async () => {
    let finish
    let aborted = false
    let stopped = 0
    const audio = new SharedAudio({ syncAudio: {
        openSyncAudioSource(id, onError, { signal }) {
            signal.addEventListener('abort', () => { aborted = true })
            return new Promise(resolve => { finish = resolve })
        },
        getSyncAudioDevices: () => []
    } })
    const pending = audio.enable('sync-audio:slow')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await audio.disable()
    assert.equal(aborted, true)
    finish({ bridge: { stop() { stopped++ } }, context: { async close() {} } })
    assert.equal(await pending, false)
    assert.equal(audio.enabled, false)
    assert.equal(stopped, 1)
})
