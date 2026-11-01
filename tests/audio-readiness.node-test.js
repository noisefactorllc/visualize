// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audioReadinessSnapshot } from './audioReadiness.js'

function activeAudio() {
    return { enabled: true, _audioContext: { state: 'running' },
        _timeDomainData: new Uint8Array([64, 192]),
        meters: { low: 0.9, mid: 0.6, high: 0, vol: 0.5 } }
}

test('audio readiness requires the existing volume assertion as well as FFT signal', () => {
    const audio = activeAudio()
    audio.meters = { low: 0.03, mid: 0, high: 0, vol: 0.01 }
    assert.equal(audioReadinessSnapshot(audio), false)
})

test('audio readiness rejects smoothed FFT signal without a current waveform', () => {
    const audio = activeAudio()
    audio._timeDomainData.fill(128)
    assert.equal(audioReadinessSnapshot(audio), false)
})

test('audio readiness captures the same live sample for the later assertion', () => {
    const audio = activeAudio()
    assert.equal(audioReadinessSnapshot({ ...audio, enabled: false }), false)
    assert.equal(audioReadinessSnapshot({ ...audio, _audioContext: { state: 'suspended' } }), false)
    const snapshot = audioReadinessSnapshot(audio)
    assert.equal(snapshot.rms, 0.5)
    assert.deepEqual(snapshot.meters, audio.meters)
    audio.meters.vol = 0
    audio._timeDomainData.fill(128)
    assert.equal(snapshot.meters.vol, 0.5)
    assert.equal(snapshot.rms, 0.5)
})
