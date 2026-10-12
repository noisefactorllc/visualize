// SPDX-License-Identifier: MIT
/**
 * IndexedDB-backed thumbnail cache for library program tiles.
 *
 * Key:   short SHA prefix of the DSL text — cache auto-invalidates when
 *        an entry's DSL changes (e.g. curated tweak, re-imported feed
 *        entry) without any explicit busting.
 * Value: { bytes: ArrayBuffer, type: <media type>, ts: <ms> }
 * TTL:   14 days — well past how often the library changes, short enough
 *        that stale shader-bundle differences eventually flush.
 *
 * Stores file bytes in IndexedDB so WebKit private browsing can cache them.
 * Older records containing a Blob remain readable.
 */

const DB_NAME = 'visualize-thumb-cache'
const STORE = 'thumbnails'
const VERSION = 1
const TTL_MS = 14 * 24 * 60 * 60 * 1000

let _dbPromise = null

function openDb() {
    if (_dbPromise) return _dbPromise
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
        }
        req.onsuccess = () => {
            const db = req.result
            // One-shot prune of entries past their TTL. The read-path TTL
            // only *hides* stale entries; without this nothing ever deletes
            // them, so the store grows unbounded (rebind / auto-VJ mint a
            // fresh DSL — and thus a fresh key — on every roll).
            sweepExpired(db)
            resolve(db)
        }
        req.onerror = () => reject(req.error)
    }).catch(err => {
        // Browser private mode / disabled storage — disable the cache by
        // returning null DB; callers handle this as "always-miss".
        console.warn('[thumbCache] indexedDB unavailable:', err?.message || err)
        return null
    })
    return _dbPromise
}

/**
 * Best-effort, fire-and-forget prune of entries older than the TTL. Runs
 * once per session (openDb memoizes the connection). Deletes records whose
 * `ts` is missing/non-numeric or past TTL — exactly the records the read
 * path already treats as a miss — so it never removes a usable thumbnail.
 */
function sweepExpired(db) {
    try {
        const cutoff = Date.now() - TTL_MS
        const tx = db.transaction(STORE, 'readwrite')
        const req = tx.objectStore(STORE).openCursor()
        req.onsuccess = () => {
            const cursor = req.result
            if (!cursor) return
            const v = cursor.value
            if (!v || typeof v.ts !== 'number' || v.ts < cutoff) cursor.delete()
            cursor.continue()
        }
        // Best-effort: swallow cursor/transaction errors (quota, abort) so an
        // unhandled IDBRequest error can't bubble to the connection.
        req.onerror = () => {}
        tx.onerror = () => {}
    } catch { /* storage disabled / mid-teardown — ignore */ }
}

/** Short stable hash of a string. SHA-256 truncated to 16 hex chars. */
export async function hashDsl(dsl) {
    const buf = new TextEncoder().encode(dsl)
    const digest = await crypto.subtle.digest('SHA-256', buf)
    const bytes = new Uint8Array(digest)
    let hex = ''
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0')
    return hex
}

/** Get a cached thumbnail Blob by key. Returns null on miss, stale, or DB error. */
export async function getCachedThumb(key) {
    const db = await openDb()
    if (!db) return null
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readonly')
            const req = tx.objectStore(STORE).get(key)
            req.onsuccess = () => {
                const entry = req.result
                if (!entry) return resolve(null)
                if (Date.now() - entry.ts > TTL_MS) return resolve(null)
                if (entry.bytes instanceof ArrayBuffer) {
                    return resolve(new Blob([entry.bytes], { type: entry.type || '' }))
                }
                resolve(entry.blob instanceof Blob ? entry.blob : null)
            }
            req.onerror = () => resolve(null)
        } catch {
            resolve(null)
        }
    })
}

/** Write a thumbnail Blob to the cache. Best-effort — errors are swallowed. */
export async function putCachedThumb(key, blob) {
    if (!(blob instanceof Blob)) return
    let bytes
    try { bytes = await blob.arrayBuffer() } catch { return }
    const db = await openDb()
    if (!db) return
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite')
            tx.objectStore(STORE).put({ bytes, type: blob.type, ts: Date.now() }, key)
            tx.oncomplete = () => resolve()
            tx.onerror = () => resolve()
        } catch {
            resolve()
        }
    })
}

/** Clear every cached thumbnail. Exposed for debug/devtools use. */
export async function clearCache() {
    const db = await openDb()
    if (!db) return
    return new Promise((resolve) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
    })
}
