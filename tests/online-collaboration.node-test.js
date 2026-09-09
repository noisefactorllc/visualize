import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisualizeOnlineCollaboration, DEFAULT_SEANCE_SDK_URL } from '../js/onlineCollaboration.js'

test('the rolling SDK URL bypasses previously cached releases', () => {
    assert.equal(DEFAULT_SEANCE_SDK_URL, 'https://seance.noisefactor.io/sdk/0/index.js?v=0.2.2')
})

async function harness() {
    const messages = []
    const handlers = new Map()
    const dialog = new EventTarget()
    const layer = {
        status: 'offline',
        on: (event, handler) => handlers.set(event, handler),
        bindEditor() {},
        getStatus() { return this.status },
        getSessionId: () => 'ABC123',
        getShareUrl: () => 'https://visualize.test/?seance=ABC123',
        goOffline() { this.status = 'offline' },
    }
    globalThis.__visualizeOnlineTestLayer = layer
    const sdkUrl = 'data:text/javascript,export function createOnlineDslLayer() { return globalThis.__visualizeOnlineTestLayer }'
    const controller = await createVisualizeOnlineCollaboration({
        sdkUrl, dialog, decks: {}, editorForDeck: () => null,
        getDeckText: () => 'noise().write(o0)', applyRemoteText() {},
        location: new URL('https://visualize.test/'),
        history: { replaceState() {} }, toast: text => messages.push(text),
    })
    await controller._ensureOnline()
    delete globalThis.__visualizeOnlineTestLayer
    return { controller, layer, handlers, dialog, messages }
}

test('an ambiguous reconnect explains how to preserve and recover the local deck draft', async () => {
    const { handlers, messages } = await harness()
    for (const reason of ['reconnect_ambiguous', 'readonly_draft']) {
        messages.length = 0
        handlers.get('doc-reject')?.({ reason, docId: 'deck:A' })
        assert.match(messages.at(-1) || '', /copy.*draft.*rejoin/i)
    }
})

test('an absent deck document explains why its local draft is not shared', async () => {
    const { handlers, messages } = await harness()
    handlers.get('doc-reject')?.({ reason: 'missing_document', docId: 'deck:B' })
    assert.match(messages.at(-1) || '', /not.*session.*copy.*draft.*new session/i)
})

test('read-only access appears as read-only in the collaboration dialog', async () => {
    const { layer, handlers, dialog } = await harness()
    layer.status = 'readonly'
    handlers.get('status')()
    assert.equal(dialog.state, 'readonly')
})

test('overlapping take-online actions create only one session', async () => {
    const { controller, layer } = await harness()
    let release
    let creates = 0
    layer.takeOnline = async () => {
        creates++
        await new Promise(resolve => { release = resolve })
        layer.status = 'online'
    }
    const first = controller.takeOnline()
    const second = controller.takeOnline()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(creates, 1)
    release()
    await Promise.all([first, second])
})
