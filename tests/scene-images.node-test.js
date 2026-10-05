// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { embeddedImageFile, getSceneImage, migrateSceneImages, storeEmbeddedImages, storeSceneImages } from '../js/sceneImages.js'

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
