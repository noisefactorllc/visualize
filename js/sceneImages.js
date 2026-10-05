// SPDX-License-Identifier: MIT
/**
 * Scene images — the image files that saved scenes show.
 *
 * A saved scene's DSL names each image it shows as `image:<sha256>`. The
 * scene itself lives in localStorage and holds only that DSL plus its small
 * settings; the image is stored here, in IndexedDB, as the original file's
 * bytes in a Blob. There is one record, { id, blob, storedAt }, per image
 * however many scenes use it. Nothing here deletes an image.
 *
 * Scenes used to carry their images as base64 text inside localStorage, one
 * copy per scene. Chrome allows 5,242,880 characters per origin, shared with
 * every other Visualize setting, so a few images filled it and every later
 * scene save failed. IndexedDB is a share of the disk.
 */

const DB_NAME = 'visualize-scene-images'
const STORE = 'images'
const VERSION = 1
const IMAGE_ID = /^[a-f0-9]{64}$/
const DATA_URL = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/

let _dbPromise = null

function openDb() {
    if (_dbPromise) return _dbPromise
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        }
        req.onsuccess = () => {
            const db = req.result
            // Let a newer page version upgrade the database.
            db.onversionchange = () => { db.close(); _dbPromise = null }
            resolve(db)
        }
        req.onerror = () => reject(req.error)
    }).catch(err => {
        // Try again on the next call: storage can come back (a freed disk,
        // a profile that leaves private mode).
        _dbPromise = null
        throw err
    })
    return _dbPromise
}

/**
 * Run `work` in one transaction and settle when the transaction commits, so
 * a caller that awaits a write knows the bytes are on disk.
 */
async function transact(mode, work) {
    const db = await openDb()
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(STORE, mode)
            const req = work(tx.objectStore(STORE))
            tx.oncomplete = () => resolve(req?.result)
            tx.onerror = () => reject(tx.error)
            tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
        } catch (err) {
            reject(err)
        }
    })
}

/** SHA-256 of a file's bytes as lowercase hex: the image id. */
async function imageDigest(blob) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Store the image files of a scene about to be saved. Each file must hash to
 * its id. Resolves once every image is committed; rejects if any is not, and
 * the caller must then not save the scene, because it would name an image
 * that is not stored.
 *
 * @param {Array<{id: string, blob: Blob}>} images
 */
export async function storeSceneImages(images = []) {
    if (!images.length) return
    const files = new Map()
    for (const { id, blob } of images) {
        if (!IMAGE_ID.test(id) || !(blob instanceof Blob)) throw new Error('Invalid scene image')
        if (files.has(id)) continue
        if (await imageDigest(blob) !== id) throw new Error(`Image bytes do not match their id: ${id}`)
        files.set(id, blob)
    }
    const storedAt = Date.now()
    await transact('readwrite', store => {
        for (const [id, blob] of files) store.put({ id, blob, storedAt })
    })
}

/**
 * The stored image file for `id`, or null when it is not stored or storage
 * is unavailable.
 * @param {string} id
 * @returns {Promise<Blob|null>}
 */
export async function getSceneImage(id) {
    if (typeof indexedDB === 'undefined' || !IMAGE_ID.test(id)) return null
    try {
        const record = await transact('readonly', store => store.get(id))
        return record?.blob instanceof Blob ? record.blob : null
    } catch (err) {
        console.warn('[sceneImages] read failed', err)
        return null
    }
}

/**
 * The file inside a base64 `data:` URL, the form older scenes kept their
 * images in. Decoded here, without fetch, so stored text is never treated as
 * a URL to load.
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function embeddedImageFile(dataUrl) {
    const match = typeof dataUrl === 'string' && DATA_URL.exec(dataUrl)
    if (!match) throw new Error('Invalid embedded image')
    const raw = atob(match[2])
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return new Blob([bytes], { type: match[1] })
}

/**
 * Store images that older scenes carried as base64 text: decode each to its
 * bytes, check the bytes against the id, and commit them.
 *
 * @param {Array<{id: string, dataUrl: string}>} images
 */
export async function storeEmbeddedImages(images = []) {
    await storeSceneImages(images.map(image => ({ id: image?.id, blob: embeddedImageFile(image?.dataUrl) })))
}

/**
 * Move images out of scenes saved before images had their own storage,
 * which frees their localStorage. Runs once per page load.
 *
 * @param {import('./scenes.js').Scenes} scenes
 */
export async function migrateSceneImages(scenes) {
    if (typeof indexedDB === 'undefined') return
    await scenes.moveEmbeddedImages(storeEmbeddedImages)
}
