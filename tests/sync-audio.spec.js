import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const daemonPath = process.env.SYNC_AUDIO_TEST_SERVER
const fixtureDsl = 'search synth, render\nnoise(seed: 7).write(o0)\nrender(o0)'
let daemon, endpoint

test.beforeAll(async () => {
    test.skip(!daemonPath || !fs.existsSync(daemonPath), 'Set SYNC_AUDIO_TEST_SERVER to the native Sync audio fixture')
    daemon = spawn(daemonPath, ['--test-origin', 'http://localhost:3070', '--test-receiver'], { stdio: ['ignore', 'pipe', 'pipe'] })
    endpoint = await new Promise((resolve, reject) => {
        let output = ''
        const timer = setTimeout(() => reject(new Error('Audio daemon startup timed out')), 5000)
        daemon.once('error', reject)
        daemon.stdout.on('data', chunk => {
            output += chunk
            if (!output.includes('\n')) return
            clearTimeout(timer)
            resolve(`http://127.0.0.1:${JSON.parse(output.split('\n')[0]).port}`)
        })
    })
})
test.afterAll(async () => {
    if (!daemon || daemon.exitCode !== null) return
    const exited = new Promise(resolve => daemon.once('exit', resolve))
    daemon.kill('SIGTERM')
    await exited
})

async function setup(page, fullApp = false) {
    if (fullApp) {
        // Exercise real rendering with a bounded input, without randomly
        // compiling a heavy simulation during native protocol assertions.
        await page.route('**/data/programs.json', route => route.fulfill({
            json: [{ title: 'Sync fixture', tagline: '', tags: ['abstract'], category: 'abstract', dsl: fixtureDsl }]
        }))
    }
    await page.route('**/js/sync/audio.js', route => route.fulfill({
        contentType: 'text/javascript',
        body: `import { SyncBridgeClient as Base } from '/js/sync/sdk/0.3.0/browser/index.js';
            export class SyncBridgeClient extends Base {
                constructor(options) { super({ ...options, endpoint: ${JSON.stringify(endpoint)}, permissions: { query: async () => ({ state: 'granted' }) } }); }
                async pair() { return { token: 'audio-test-token' }; }
            }`
    }))
    // The same engine AudioState used by the products, served locally for isolation.
    await page.route('**/__audio-state.js', route => route.fulfill({
        path: path.resolve('../noisemaker/shaders/src/runtime/external-input.js'), contentType: 'text/javascript'
    }))
    await page.goto(fullApp ? '/' : '/sync-audio-test-empty.html')
    await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => { throw new Error('Sync must not fall back to the microphone') }
    })
    if (fullApp) {
        await page.click('#boot-start')
        await page.waitForFunction(() => window.__visualize?.audio)
        return
    }
    await page.evaluate(async () => {
        const { AudioState } = await import('/__audio-state.js')
        const { SharedAudio } = await import('/js/audio.js')
        window.audioState = new AudioState()
        window.audio = new SharedAudio()
        window.audio.addDeck({ ensureAudioState: () => window.audioState })
        window.syncAudio = await import('/js/sync/audioInput.js')
        await window.syncAudio.connectSyncAudio()
    })
}

for (const channels of [1, 2, 8, 32]) {
    test(`native ${channels}-channel audio reaches every shader channel and releases capture`, async ({ page }) => {
        await setup(page)
        const id = `sync-audio:audio_${channels}`
        expect(await page.evaluate(id => window.audio.enable(id), id)).toBe(true)
        await expect.poll(() => page.evaluate(({ id, channels }) => Array.from({ length: channels }, (_, i) =>
            Math.round((window.audioState.getDeviceChannelState({ id, channel: i + 1 })?.raw || 0) * 32)), { id, channels }))
            .toEqual(Array.from({ length: channels }, (_, i) => i + 1))
        await expect.poll(() => page.evaluate(() => window.audioState.raw)).toBeCloseTo((channels + 1) / 64)
        await page.evaluate(() => window.audio.disable())
        expect(await page.evaluate(() => window.audioState.rawReady)).toBe(false)
        expect(await page.evaluate(id => window.audioState.getDeviceChannelState({ id, channel: 1 }), id)).toBe(null)
        expect(await page.evaluate(() => window.audioState.getDeviceChannelState({ channel: 1 }))).toBe(null)
        await expect.poll(() => page.evaluate(async () => (await window.syncAudio.refreshSyncAudioDevices())
            .find(source => source.id === 'sync-audio:audio_active')?.name)).toBe('0 · Sync')
    })
}

test('native read failure clears active state and permits a new source', async ({ page }) => {
    await setup(page)
    await page.evaluate(() => window.audio.enable('sync-audio:audio_fail_after_2'))
    await expect.poll(() => page.evaluate(() => window.audio.enabled)).toBe(false)
    expect(await page.evaluate(() => window.audio.enable('sync-audio:audio_2'))).toBe(true)
    await expect.poll(() => page.evaluate(() => window.audioState.getDeviceChannelState({ id: 'sync-audio:audio_2', channel: 2 })?.raw)).toBeCloseTo(2 / 32)
    await page.evaluate(() => window.audio.disable())
})

test('audio settings expose Sync discovery and native selection without microphone capture', async ({ page }) => {
    await setup(page, true)
    await page.click('#settings-toggle')
    await page.click('#sync-audio-connect')
    await expect(page.locator('#sync-audio-status')).toHaveText('Select a Sync input from the device list.')
    await page.evaluate(() => {
        const select = document.getElementById('audio-device')
        select.value = 'sync-audio:audio_32_tones'
        select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect.poll(() => page.evaluate(() => window.__visualize.audio.enabled)).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__visualize.audio.meters.vol)).toBeGreaterThan(0)
    await expect(page.locator('#audio-status')).toContainText('audio: 32 channel ort')
    expect(await page.evaluate(() => window.__visualize.audio.currentDeviceId)).toBe('sync-audio:audio_32_tones')
    await page.evaluate(() => window.__visualize.audio.disable())
})

test('initial deck loading cannot reset an active Sync audio status', async ({ page }) => {
    await page.route(url => url.pathname === '/js/noisemaker/deck.js' && !url.searchParams.has('ungated'), route => route.fulfill({
        contentType: 'text/javascript',
        body: `import { Deck as RealDeck, isHeavyDsl } from './deck.js?ungated';
            export { isHeavyDsl };
            const initialLoad = new Promise(resolve => { window.finishInitialDeckLoad = resolve; });
            export class Deck extends RealDeck {
                async load(...args) { await initialLoad; return super.load(...args); }
            }`
    }))
    await setup(page, true)
    await page.evaluate(async () => {
        const audio = window.__visualize.audio
        const onStatus = audio._onStatus
        window.bootAudioEvents = []
        audio.onStatusChange((message, enabled, error) => {
            window.bootAudioEvents.push({ message, enabled, error: error?.message })
            onStatus(message, enabled, error)
        })
        const sync = await import('/js/sync/audioInput.js')
        await sync.connectSyncAudio()
        await audio.enable('sync-audio:audio_2')
    })
    await expect(page.locator('#audio-status')).toContainText('audio: ')
    await page.evaluate(() => window.finishInitialDeckLoad())
    await page.waitForFunction(() => window.__visualize?.online)
    const status = await page.evaluate(() => ({ enabled: window.__visualize.audio.enabled, events: window.bootAudioEvents }))
    expect(status.enabled, JSON.stringify(status.events)).toBe(true)
    await expect(page.locator('#audio-status')).toContainText('audio: ')
    await page.evaluate(() => window.__visualize.audio.disable())
})

test('a failed Sync input can be selected again in the settings', async ({ page }) => {
    await setup(page, true)
    await page.click('#settings-toggle')
    await page.click('#sync-audio-connect')
    await expect(page.locator('#sync-audio-status')).toHaveText('Select a Sync input from the device list.')
    for (let attempt = 0; attempt < 2; attempt++) {
        await page.evaluate(() => {
            const audio = window.__visualize.audio
            window.retryStarted = false
            const enable = audio.enable.bind(audio)
            audio.enable = (...args) => { window.retryStarted = true; return enable(...args) }
            document.getElementById('audio-device')._selectOption('sync-audio:audio_fail_after_2')
        })
        await expect.poll(() => page.evaluate(() => window.retryStarted)).toBe(true)
        await expect.poll(() => page.evaluate(() => window.__visualize.audio.enabled)).toBe(false)
        await expect.poll(() => page.evaluate(() => document.getElementById('audio-device').value)).toBe('')
    }
})

test('an older cancelled audio selection cannot clear the newer selection', async ({ page }) => {
    await setup(page, true)
    await page.evaluate(async () => {
        const select = document.getElementById('audio-device')
        select.setOptions([{ value: '', text: 'Off' }, { value: 'A', text: 'A' }, { value: 'B', text: 'B' }])
        window.__visualize.audio.enable = id => id === 'A'
            ? new Promise(resolve => { window.cancelOlderAudio = resolve })
            : new Promise(() => {})
        select._selectOption('A')
        select._selectOption('B')
        window.cancelOlderAudio(false)
        await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(await page.locator('#audio-device').evaluate(element => element.value)).toBe('B')
})

test('native receiver accepts mixer bytes while audio and video share the grant', async ({ page }) => {
    await page.route('**/js/sync/bundle.js', route => route.fulfill({
        contentType: 'text/javascript',
        body: `import { SyncBridgeClient as Base } from '/js/sync/sdk/0.1.5/browser/index.js';
            window.nativeFrameChecksums = new Set();
            class ObservedSocket extends WebSocket {
                send(data) {
                    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                        let hash = 0x811c9dc5;
                        const payloadLength = bytes.length - 64;
                        const end = 64 + (payloadLength > 1048576 ? 65536 : payloadLength);
                        for (let i = 64; i < end; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
                        window.nativeFrameChecksums.add(hash);
                    }
                    return super.send(data);
                }
            }
            export class SyncBridgeClient extends Base {
                constructor(options) { super({ ...options, endpoint: ${JSON.stringify(endpoint)}, WebSocket: ObservedSocket, permissions: { query: async () => ({ state: 'granted' }) } }); }
                async pair() { throw new Error('Video should reuse the audio grant'); }
            }`
    }))
    await setup(page, true)
    await page.waitForFunction(dsl => {
        const app = window.__visualize
        return app?.online && app.mixer?.ready && Object.values(app.decks).every(deck => deck.currentDsl === dsl)
    }, fixtureDsl)
    await page.evaluate(async () => {
        const sync = await import('/js/sync/audioInput.js')
        await sync.connectSyncAudio()
        const { audio, syncOutputController: output } = window.__visualize
        await audio.enable('sync-audio:audio_2')
        await output.connect()
        await output.start('Visualize native receiver')
    })
    const receiverStatus = () => page.evaluate(async () => {
        const output = window.__visualize.syncOutputController
        const client = output._client, sender = output._sender
        if (!sender) return { state: output.state, accepted: false }
        const stats = await client._scheduleControl(client._controlSession, () => client._exchange(
            { type: 'getStats', senderId: sender.id }, message => message, client._controlSession))
        window.nativeReceiverStats = stats
        return { state: output.state, stats, checksums: [...window.nativeFrameChecksums],
            accepted: Number(stats.accepted) >= 2 && window.nativeFrameChecksums.has(Number(stats.checksum)) }
    })
    try {
        await expect.poll(async () => (await receiverStatus()).accepted).toBe(true)
    } catch (error) {
        error.message += '\nReceiver diagnostics: ' + JSON.stringify(await receiverStatus())
        throw error
    }
    const stats = await page.evaluate(() => window.nativeReceiverStats)
    expect(Number(stats.rejected)).toBe(0)
    expect(Number(stats.failed)).toBe(0)
    await page.evaluate(() => window.__visualize.syncOutputController.stop())
    expect(await page.evaluate(() => window.__visualize.audio.enabled)).toBe(true)
    await page.evaluate(() => window.__visualize.audio.disable())
})
