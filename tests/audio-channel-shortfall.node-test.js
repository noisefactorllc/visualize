// SPDX-License-Identifier: MIT
// Channel-shortfall diagnostics: a compiled program whose audio bindings
// select a channel (or device) the live capture cannot supply used to
// resolve to null and silently evaluate to `min` with no diagnostic
// (the Visualize capture-path equivalent of the shared runtime's
// GAP-032 channel-shortfall warning).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SharedAudio, channelShortfall } from '../js/audio.js'

const device2 = { id: 'sync-audio:audio_2', name: '0 · Sync', channelCount: 2 }

test('channelShortfall flags a channel beyond the captured device channels', () => {
    assert.equal(
        channelShortfall({ id: null, name: null, channel: 5 }, device2),
        '0 · Sync channel 5 (captured device only exposes 2 channel(s))'
    )
    assert.equal(
        channelShortfall({ id: 'sync-audio:audio_2', name: null, channel: 3 }, device2),
        'sync-audio:audio_2 channel 3 (captured device only exposes 2 channel(s))'
    )
})

test('channelShortfall accepts in-range and default bindings unchanged', () => {
    assert.equal(channelShortfall({ id: null, name: null, channel: 1 }, device2), null)
    assert.equal(channelShortfall({ id: null, name: null, channel: 2 }, device2), null)
    assert.equal(
        channelShortfall({ id: 'sync-audio:audio_2', name: null, channel: 1 }, device2), null
    )
})

test('channelShortfall flags selectors that target another device', () => {
    assert.equal(
        channelShortfall({ id: 'sync-audio:audio_8', name: null, channel: 1 }, device2),
        'sync-audio:audio_8 is not the captured input (0 · Sync)'
    )
    assert.equal(
        channelShortfall({ id: null, name: 'Studio 4i', channel: 1 }, device2),
        'Studio 4i is not the captured input (0 · Sync)'
    )
    // A same-device name selector still validates the channel.
    assert.equal(
        channelShortfall({ id: null, name: '0 · Sync', channel: 9 }, device2),
        '0 · Sync channel 9 (captured device only exposes 2 channel(s))'
    )
})

test('channelShortfall ignores malformed requirements and captures', () => {
    assert.equal(channelShortfall(null, device2), null)
    assert.equal(channelShortfall({ id: null, name: null, channel: 1 }, null), null)
    assert.equal(channelShortfall({ id: null, name: null }, device2), null)
    assert.equal(channelShortfall({ id: null, name: null, channel: 0 }, device2), null)
    assert.equal(channelShortfall({ id: null, name: null, channel: 1.5 }, device2), null)
    assert.equal(channelShortfall({ id: null, name: null, channel: 1 }, { id: device2.id, name: device2.name }), null)
})

test('refreshDeckStates warns once per unmet set and stays silent while unchanged', () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = message => warnings.push(String(message))
    try {
        const audio = new SharedAudio()
        audio._enabled = true
        audio._nativeChannels = { device: device2 }
        const requirements = () => ({ selected: [
            { id: null, name: null, channel: 5 },
            { id: null, name: null, channel: 1 }
        ] })
        const makeDeck = () => ({ ensureAudioState: () => ({}), audioRequirements: requirements })
        audio._decks = new Set([makeDeck()])
        audio.refreshDeckStates()
        audio.refreshDeckStates()
        audio.refreshDeckStates()
        assert.equal(warnings.length, 1)
        assert.match(warnings[0], /\[SharedAudio\] 1 selected audio binding\(s\) could not be captured/)
        assert.match(warnings[0], /channel 5 \(captured device only exposes 2 channel\(s\)\)/)
        assert.match(warnings[0], /they evaluate to min\./)
        // A satisfied program clears the sticky warning, so a later shortfall
        // warns again.
        audio._decks = new Set([{ ensureAudioState: () => ({}), audioRequirements: () => ({ selected: [{ id: null, name: null, channel: 1 }] }) }])
        audio.refreshDeckStates()
        assert.equal(warnings.length, 1)
        audio._decks = new Set([makeDeck()])
        audio.refreshDeckStates()
        assert.equal(warnings.length, 2)
        // A deck without the runtime requirements view (older renderer) warns nothing.
        audio._decks = new Set([{ ensureAudioState: () => ({}) }])
        audio.refreshDeckStates()
        assert.equal(warnings.length, 2)
    } finally {
        console.warn = originalWarn
    }
})

test('refreshDeckStates never warns when the capture is inactive or logging throws', () => {
    const originalWarn = console.warn
    console.warn = () => { throw new Error('logging is broken') }
    try {
        const audio = new SharedAudio()
        audio._enabled = true
        audio._decks = new Set([{ ensureAudioState: () => ({}), audioRequirements: () => ({ selected: [{ id: null, name: null, channel: 5 }] }) }])
        // Disabled: no capture, no warning.
        audio._nativeChannels = null
        audio.refreshDeckStates()
        // Enabled with an active capture: the logging failure must not escape.
        audio._enabled = true
        audio._nativeChannels = { device: device2 }
        audio.refreshDeckStates()
        // Disabled again (the SharedAudio.disable path) also stays quiet.
        audio._enabled = false
        audio._nativeChannels = { device: device2 }
        audio.refreshDeckStates()
    } finally {
        console.warn = originalWarn
    }
})

test('a throwing requirements view cannot interrupt refreshDeckStates', () => {
    const audio = new SharedAudio()
    audio._enabled = true
    audio._nativeChannels = { device: device2 }
    audio._decks = new Set([{
        ensureAudioState: () => ({}),
        audioRequirements() { throw new Error('pipeline mid-compile') }
    }])
    assert.doesNotThrow(() => audio.refreshDeckStates())
    assert.equal(audio._lastShortfallWarning, '')
})
