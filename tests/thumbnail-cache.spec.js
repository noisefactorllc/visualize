// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'

test('thumbnail cache stores bytes when IndexedDB rejects Blob records', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const { putCachedThumb, getCachedThumb } = await import('/js/thumbnailCache.js')
        const original = new Blob(['thumbnail bytes'], { type: 'image/webp' })
        const put = IDBObjectStore.prototype.put
        IDBObjectStore.prototype.put = function (value, ...args) {
            if (value?.blob instanceof Blob) throw new DOMException('Blob records refused', 'UnknownError')
            return put.call(this, value, ...args)
        }
        try { await putCachedThumb('current', original) }
        finally { IDBObjectStore.prototype.put = put }
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('visualize-thumb-cache', 1)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        const current = await new Promise((resolve, reject) => {
            const request = db.transaction('thumbnails', 'readonly').objectStore('thumbnails').get('current')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        db.close()
        const bytesOf = async blob => blob && [...new Uint8Array(await blob.arrayBuffer())]
        return {
            storedBytes: current?.bytes instanceof ArrayBuffer,
            storedType: current?.type,
            storedBlob: current?.blob instanceof Blob,
            current: await bytesOf(await getCachedThumb('current')),
            expected: await bytesOf(original),
        }
    })
    expect(result.storedBytes).toBe(true)
    expect(result.storedType).toBe('image/webp')
    expect(result.storedBlob).toBe(false)
    expect(result.current).toEqual(result.expected)
})
