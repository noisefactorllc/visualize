import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisualizeOnlineCollaboration, DEFAULT_SEANCE_SDK_URL } from '../js/onlineCollaboration.js'

test('the rolling SDK URL bypasses previously cached releases', () => {
    assert.equal(DEFAULT_SEANCE_SDK_URL, 'https://seance.noisefactor.io/sdk/0/index.js?v=images-20260929')
})

async function harness(options = {}) {
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
        ...options,
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

test('both deck image assets are seeded outside session text without duplicate bytes', async () => {
    const image = { id: 'a'.repeat(64), dataUrl: 'data:image/png;base64,original' }
    const { controller, layer } = await harness({
        prepareImages: async (deck, text) => ({ dsl: `${deck}:${text}`, images: [image] }),
    })
    let payload
    layer.takeOnline = async value => { payload = value }
    await controller.takeOnline()
    assert.deepEqual(payload.images, [image])
    assert.deepEqual(payload.docs.map(doc => doc.text), ['A:noise().write(o0)', 'B:noise().write(o0)'])
})

test('a changed image is uploaded before publishing its reference and stale preparation cannot publish', async () => {
    const image = { id: 'b'.repeat(64), dataUrl: 'data:image/png;base64,original' }
    const text = 'media(url: "local-image").write(o0)'
    let current = text
    const events = []
    let finishUpload
    const { controller, layer } = await harness({
        getDeckText: () => current,
        prepareImages: async () => ({ dsl: 'media(url: "image:resolved").write(o0)', images: [image] }),
        imageBlob: async asset => asset,
    })
    layer.status = 'online'
    layer.uploadImage = async () => { events.push('upload'); await new Promise(resolve => { finishUpload = resolve }) }
    layer.updateLocalText = (id, dsl) => { events.push([id, dsl]) }
    const publish = controller.updateLocalText('deck:A', text)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(events, ['upload'])
    finishUpload()
    await publish
    assert.deepEqual(events[1], ['deck:A', 'media(url: "image:resolved").write(o0)'])
    current = text
    controller._uploadedImages.clear()
    const obsolete = controller.updateLocalText('deck:A', text)
    await new Promise(resolve => setTimeout(resolve, 0))
    current = 'noise().write(o0)'
    finishUpload()
    await obsolete
    assert.equal(events.filter(Array.isArray).length, 1)
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


test('pending and rejected image replacements preserve the prior shared document during control edits', async () => {
    let current = 'media(url:"image:old", rotation:0).write(o0)'
    const published = [], uploads = []
    const { controller, layer } = await harness({
        getDeckText: () => current,
        prepareImages: async (_deck, text) => ({ dsl: text.replace('local-new', 'image:new'), images: [{ id: 'new', dataUrl: 'new original bytes' }] }),
        imageBlob: async image => image,
    })
    layer.status = 'online'
    layer.uploadImage = () => new Promise((resolve, reject) => uploads.push({ resolve, reject }))
    layer.updateLocalText = (_doc, text) => published.push(text)
    current = 'media(url:"local-new", rotation:0).write(o0)'
    const firstRejected = assert.rejects(controller.updateLocalText('deck:A', current), /upload refused/)
    await new Promise(resolve => setTimeout(resolve, 0))
    current = 'media(url:"local-new", rotation:25).write(o0)'
    const controlRejected = assert.rejects(controller.updateLocalText('deck:A', current), /upload refused/)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(published, [], 'pending uploads do not replace the previous shared image')
    for (const upload of uploads.splice(0)) upload.reject(new Error('upload refused'))
    await Promise.all([firstRejected, controlRejected])
    assert.deepEqual(published, [])
    const laterRejected = assert.rejects(controller.updateLocalText('deck:A', current), /upload refused/)
    await new Promise(resolve => setTimeout(resolve, 0))
    uploads[0].reject(new Error('upload refused'))
    await laterRejected
    assert.deepEqual(published, [], 'failed uploads cannot leak a reference on a later control edit')
})


for (const cancel of ['edit A while B prepares', 'offline']) {
    test(`initial two-deck image preparation preserves drafts and cancels creation after ${cancel}`, async () => {
        const editors = {A:{value:'media(url:"https://images.test/a.png", rotation:0)'},B:{value:'media(url:"https://images.test/b.png", rotation:0)'}}
        const original = {A:editors.A.value,B:editors.B.value}
        const seeds = []
        let release
        const {controller,layer,messages} = await harness({
            editorForDeck:id => editors[id],getDeckText:id => editors[id].value,
            prepareImages:async (id,text) => {
                if (id === 'B') await new Promise(resolve => {release = resolve})
                return {dsl:text.replace(/https:[^"]+/,'image:ready'),images:[{id:'ready'}]}
            },
        })
        layer.takeOnline = async value => seeds.push(value)
        const creating = controller.takeOnline()
        while (!release) await Promise.resolve()
        assert.equal(editors.A.value, original.A, 'preparing B must not replace A before the snapshot is complete')
        if (cancel.startsWith('edit')) editors.A.value = original.A.replace('rotation:0','rotation:42')
        else controller.goOffline()
        const expected = {A:editors.A.value,B:editors.B.value}
        release()
        await creating
        assert.deepEqual({A:editors.A.value,B:editors.B.value}, expected)
        assert.deepEqual(seeds, [])
        if (cancel.startsWith('edit')) assert.ok(messages.some(text => /changed|latest/i.test(text)))
    })
}

test('go offline during the initial SDK import cancels image preparation and session creation', async t => {
    let entered, release, prepared = 0, created = 0
    const importing = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    globalThis.__visualizePendingSdk = {
        entered, gate,
        layer: { on() {}, bindEditor() {}, getStatus:() => 'offline', getSessionId:() => null, takeOnline:async () => { created++ } },
    }
    t.after(() => { delete globalThis.__visualizePendingSdk })
    const sdkUrl = 'data:text/javascript,globalThis.__visualizePendingSdk.entered();await globalThis.__visualizePendingSdk.gate;export function createOnlineDslLayer(){return globalThis.__visualizePendingSdk.layer}'
    const controller = await createVisualizeOnlineCollaboration({
        sdkUrl, decks:{}, editorForDeck:() => null, getDeckText:() => 'media(url:"local")', applyRemoteText() {},
        location:new URL('https://visualize.test/'), history:{replaceState() {}},
        prepareImages:async () => { prepared++; return {dsl:'prepared',images:[]} },
    })
    const pending = controller.takeOnline()
    await importing
    controller.goOffline()
    release()
    await pending
    assert.equal(prepared, 0)
    assert.equal(created, 0)
})
