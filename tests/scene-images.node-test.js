// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { embeddedImageFile, getSceneImage, migrateSceneImages, sceneImagesMigrated, storeEmbeddedImages, storeSceneImages } from '../js/sceneImages.js'

// Node has no IndexedDB: these cover the checks that run before storage is
// opened. tests/scene-images.spec.js covers storage in Chromium.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('an embedded image decodes to its exact bytes and type, without fetching', async () => {
    const file = embeddedImageFile(`data:image/png;base64,${PNG_BYTES.toString('base64')}`)
    assert.equal(file.type, 'image/png')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_BYTES)
})

test('only base64 image data URLs are accepted as embedded images', () => {
    for (const dataUrl of [
        undefined,
        'https://example.com/image.png',
        'blob:https://visualize.noisedeck.app/1234',
        'data:text/plain;base64,aGVsbG8=',
        'data:image/png,not-base64',
        'data:image/png;base64,***',
    ]) {
        assert.throws(() => embeddedImageFile(dataUrl), /Invalid embedded image/, String(dataUrl))
    }
})

test('image files are checked against their ids before anything is stored', async () => {
    const blob = new Blob([PNG_BYTES], { type: 'image/png' })
    await assert.rejects(storeSceneImages([{ id: 'f'.repeat(64), blob }]), /do not match their id/)
    await assert.rejects(storeSceneImages([{ id: 'not-a-sha256', blob }]), /Invalid scene image/)
    await assert.rejects(storeSceneImages([{ id: sha256(PNG_BYTES), blob: 'data:image/png;base64,AAAA' }]), /Invalid scene image/)
})

test('an embedded image whose bytes do not match its id is refused', async () => {
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
    await assert.rejects(storeEmbeddedImages([{ id: 'f'.repeat(64), dataUrl }]), /do not match their id/)
    await assert.rejects(storeEmbeddedImages([{ id: sha256(PNG_BYTES), dataUrl: 'https://example.com/a.png' }]), /Invalid embedded image/)
})

test('without IndexedDB nothing is read or moved', async () => {
    assert.equal(await getSceneImage(sha256(PNG_BYTES)), null)
    let moved = false
    await migrateSceneImages({ moveEmbeddedImages: async () => { moved = true } })
    assert.equal(moved, false)
})

/** Run `work` with a stand-in IndexedDB, and remove it afterwards. */
async function withIndexedDB(indexedDB, work) {
    globalThis.indexedDB = indexedDB
    try { return await work() } finally { delete globalThis.indexedDB }
}

const settled = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setTimeout(() => resolve(false), 20))])

test('a save waits for the startup migration, never longer than its bound, and never fails with it', async () => {
    assert.equal(await settled(sceneImagesMigrated()), true, 'nothing to wait for before a migration starts')
    await withIndexedDB({}, async () => {
        let finish
        const migration = migrateSceneImages({ moveEmbeddedImages: () => new Promise(resolve => { finish = resolve }) })
        const waiting = sceneImagesMigrated()
        assert.equal(await settled(waiting), false, 'a save waits while images are moving')
        finish(3)
        assert.equal(await settled(waiting), true)
        assert.equal(await migration, undefined)

        const failing = migrateSceneImages({ moveEmbeddedImages: async () => { throw new Error('IndexedDB unavailable') } })
        await assert.rejects(failing, /IndexedDB unavailable/)
        assert.equal(await settled(sceneImagesMigrated()), true, 'a failed migration lets saves go ahead')

        migrateSceneImages({ moveEmbeddedImages: () => new Promise(() => {}) })
        assert.equal(await settled(sceneImagesMigrated(5)), true, 'a migration that never ends holds saves only up to the bound')
    })
})

/** An IndexedDB stand-in whose open requests the test answers. */
function fakeIndexedDB() {
    const opens = []
    const transactions = []
    const records = new Map()
    function database() {
        const db = {
            closed: false,
            objectStoreNames: { contains: () => true },
            close() { db.closed = true },
            transaction(store, mode, options) {
                transactions.push({ store, mode, options })
                const tx = {
                    objectStore: () => ({
                        put(record) { records.set(record.id, record) },
                        get(id) { return { result: records.get(id) } },
                    }),
                }
                setTimeout(() => tx.oncomplete())
                return tx
            },
        }
        return db
    }
    return {
        opens, transactions, records,
        open(name, version) {
            const request = { name, version }
            opens.push(request)
            return request
        },
        async succeed() {
            const request = await this.next()
            request.result = database()
            request.onsuccess()
            return request.result
        },
        async block() {
            ;(await this.next()).onblocked()
        },
        answered: 0,
        async next() {
            while (opens.length <= this.answered) await new Promise(resolve => setTimeout(resolve))
            return opens[this.answered++]
        },
    }
}

/** The media type and bytes of a stored image file, or null. */
async function fileOf(file) {
    const blob = await file
    if (!blob) return null
    assert.ok(blob instanceof Blob)
    return { type: blob.type, bytes: Buffer.from(await blob.arrayBuffer()) }
}

test('an image is stored as its bytes in an ArrayBuffer, which WebKit private browsing accepts, and read as a Blob', async () => {
    const idb = fakeIndexedDB()
    const id = sha256(PNG_BYTES)
    await withIndexedDB(idb, async () => {
        const stored = storeSceneImages([{ id, blob: new File([PNG_BYTES], 'picked.png', { type: 'image/png' }) }])
        const db = await idb.succeed()
        await stored
        const record = idb.records.get(id)
        assert.deepEqual(Object.keys(record).sort(), ['bytes', 'id', 'storedAt', 'type'])
        assert.ok(record.bytes instanceof ArrayBuffer)
        assert.equal(record.type, 'image/png')
        assert.deepEqual(Buffer.from(record.bytes), PNG_BYTES)
        assert.deepEqual(await fileOf(getSceneImage(id)), { type: 'image/png', bytes: PNG_BYTES })
        db.onclose()
    })
})

test('an image stored earlier as a Blob still reads', async () => {
    const idb = fakeIndexedDB()
    const id = sha256(PNG_BYTES)
    idb.records.set(id, { id, blob: new Blob([PNG_BYTES], { type: 'image/png' }), storedAt: 1 })
    await withIndexedDB(idb, async () => {
        const read = getSceneImage(id)
        const db = await idb.succeed()
        assert.deepEqual(await fileOf(read), { type: 'image/png', bytes: PNG_BYTES })
        db.onclose()
    })
})

test('image storage writes durably, and reopens after another tab upgrades it or the browser closes it', async () => {
    const idb = fakeIndexedDB()
    const id = sha256(PNG_BYTES)
    const blob = new Blob([PNG_BYTES], { type: 'image/png' })
    await withIndexedDB(idb, async () => {
        const stored = storeSceneImages([{ id, blob }])
        const first = await idb.succeed()
        await stored
        assert.deepEqual(idb.transactions.at(-1), { store: 'images', mode: 'readwrite', options: { durability: 'strict' } })
        assert.deepEqual(await fileOf(getSceneImage(id)), await fileOf(blob))
        assert.deepEqual(idb.transactions.at(-1), { store: 'images', mode: 'readonly', options: undefined })
        assert.equal(idb.opens.length, 1, 'one connection serves both')

        first.onversionchange()
        assert.equal(first.closed, true, 'a newer version in another tab is let through')
        const afterUpgrade = getSceneImage(id)
        const second = await idb.succeed()
        assert.deepEqual(await fileOf(afterUpgrade), await fileOf(blob))
        assert.equal(idb.opens.length, 2)

        second.onclose()
        const afterClose = getSceneImage(id)
        const third = await idb.succeed()
        assert.deepEqual(await fileOf(afterClose), await fileOf(blob))
        assert.equal(idb.opens.length, 3)
        third.onclose()
    })
})

test('a blocked open fails the save, and the next save opens again', async () => {
    const idb = fakeIndexedDB()
    const id = sha256(PNG_BYTES)
    const blob = new Blob([PNG_BYTES], { type: 'image/png' })
    await withIndexedDB(idb, async () => {
        const blocked = storeSceneImages([{ id, blob }])
        await idb.block()
        await assert.rejects(blocked, /blocked by another Visualize tab/)
        const retried = storeSceneImages([{ id, blob }])
        await idb.succeed()
        await retried
        assert.equal(idb.opens.length, 2)
    })
})
