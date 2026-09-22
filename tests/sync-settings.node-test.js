import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// Run the actual asynchronous settings refresh against delayed device discovery.
const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8')
const refresh = app.slice(app.indexOf('    async function refreshAudioDevices()'), app.indexOf('    async function handleAudioDeviceChange')).replace(/    let audioSelectionGeneration = 0\n/, '')

test('capture failure during discovery cannot restore its old selected input', async () => {
    let resolveDevices
    const select = { value: 'failed', setOptions() {}, setAttribute(key, value) { this.value = value } }
    const audio = { enabled: true, currentDeviceId: 'failed', listDevices: () => new Promise(resolve => { resolveDevices = resolve }) }
    const context = vm.createContext({ audio, $: () => select, refreshSyncAudioDevices: async () => [] })
    vm.runInContext('let audioSelectionGeneration = 0; let audioDeviceRefreshGeneration = 0;\n' + refresh, context)
    const pending = vm.runInContext('refreshAudioDevices()', context)
    audio.enabled = false
    select.value = ''
    vm.runInContext('audioSelectionGeneration++', context)
    resolveDevices([{ deviceId: 'failed', label: 'Failed source' }])
    await pending
    assert.equal(select.value, '')
})
