// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'

test('thumbnail cache reads records stored earlier as Blobs', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
        const original = new Blob(['legacy thumbnail'], { type: 'image/webp' })
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('visualize-thumb-cache', 1)
            request.onupgradeneeded = () => request.result.createObjectStore('thumbnails')
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
            const tx = db.transaction('thumbnails', 'readwrite')
            tx.objectStore('thumbnails').put({ blob: original, ts: Date.now() }, 'legacy')
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()
        const { getCachedThumb } = await import('/js/thumbnailCache.js')
        const cached = await getCachedThumb('legacy')
        return {
            type: cached?.type,
            bytes: cached && [...new Uint8Array(await cached.arrayBuffer())],
            expected: [...new Uint8Array(await original.arrayBuffer())],
        }
    })
    expect(result.type).toBe('image/webp')
    expect(result.bytes).toEqual(result.expected)
})
