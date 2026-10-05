// SPDX-License-Identifier: MIT
/**
 * Saved scenes keep their images as files (Blobs) in IndexedDB and only
 * `image:<sha256>` references in localStorage. Scenes saved before that held
 * every image as base64 text in localStorage; loading the app moves those
 * images into IndexedDB, which frees a localStorage that the text filled.
 *
 * The images are solid-color PNGs stored without compression, so their size
 * is set by their dimensions and each one draws as a single exact color.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { routePortableImagesLocal } from './seanceLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 180_000 * SCALE, retries: 0 })

const SCENES_KEY = 'visualize.scenes.v1'
// Chrome's localStorage limit: characters of every key and value, per origin.
const QUOTA = 5_242_880
const MEDIA_DSL = 'search synth\nmedia().write(o0)\nrender(o0)'
const NOISE_DSL = 'search synth, render\n\nnoise(seed: 101, ridges: true)\n  .write(o0)\n\nrender(o0)'
const PROGRAMS = [
    { title: 'Noise A', tagline: 'test program', tint: '#4ea8ff', tags: ['abstract'], category: 'abstract', dsl: NOISE_DSL },
    { title: 'Noise B', tagline: 'test program', tint: '#ff6b8a', tags: ['abstract'], category: 'abstract', dsl: NOISE_DSL.replace('101', '303') },
]
const imageDsl = id => `search synth\nmedia(url: "image:${id}").write(o0)\nrender(o0)`

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
})

function crc32(bytes) {
    let c = 0xffffffff
    for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length)
    chunk.writeUInt32BE(data.length, 0)
    chunk.write(type, 4, 'latin1')
    data.copy(chunk, 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
    return chunk
}

/** A solid-color PNG file with its SHA-256 id and the base64 text old scenes kept. */
function solidPng(width, height, [r, g, b]) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header.set([8, 2, 0, 0, 0], 8)
    const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)), { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ])
    return {
        bytes, width, height,
        id: createHash('sha256').update(bytes).digest('hex'),
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }
}

/** What IndexedDB must hold for an image: its exact bytes, as a PNG file. */
const fileOf = image => ({ type: 'image/png', size: image.bytes.length, sha256: image.id })

/** A deck as scenes saved it before images had their own storage. */
function legacyDeck(image) {
    const dsl = image ? imageDsl(image.id) : NOISE_DSL
    return {
        title: image ? 'Media Input' : 'Noise A',
        dsl,
        images: image ? [{ id: image.id, dataUrl: image.dataUrl, mimeType: 'image/png', width: image.width, height: image.height }] : [],
        speed: 1,
        rebind: { originalDsl: dsl, bandpass: true, oscillatorCount: 0, overrides: {} },
    }
}

function legacyScene(name, imageA, imageB) {
    return {
        name,
        createdAt: Date.now(),
        decks: { A: legacyDeck(imageA), B: legacyDeck(imageB) },
        xfade: 0,
        curve: 'dipped',
        bpm: 120,
        divider: 1,
        fx: { strobe: false, invert: false, bw: false, zoom: false, freeze: false },
        autoMix: { enabled: false, barsPerScene: 8, curve: 'dipped' },
        autoXfade: null,
        mixer: null,
        deckDensity: { A: { mode: 'auto', value: 1 }, B: { mode: 'auto', value: 1 } },
    }
}

async function preparePage(page) {
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routePortableImagesLocal(page)
    await page.route('**/data/programs.json', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(PROGRAMS),
    }))
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
}

async function start(page) {
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize?.scenes && !!window.__visualize?.decks?.A?.currentDsl,
        null, { timeout: 45_000 * SCALE })
}

const storedScenes = page => page.evaluate(key => localStorage.getItem(key) || '[]', SCENES_KEY)

function usedCharacters(page) {
    return page.evaluate(() => {
        let used = 0
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i)
            used += key.length + localStorage.getItem(key).length
        }
        return used
    })
}

/** The files saved scenes keep in IndexedDB, or null where one is missing. */
function storedImages(page, ids) {
    return page.evaluate(async ids => {
        const { getSceneImage } = await import('/js/sceneImages.js')
        return Promise.all(ids.map(async id => {
            const blob = await getSceneImage(id)
            if (!blob) return null
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
            return { type: blob.type, size: blob.size, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') }
        }))
    }, ids)
}

function storedImageCount(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('visualize-scene-images')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
            const db = open.result
            const count = db.transaction('images', 'readonly').objectStore('images').count()
            count.onsuccess = () => { db.close(); resolve(count.result) }
            count.onerror = () => { db.close(); reject(count.error) }
        }
    }))
}

function deckPixel(page, deckId) {
    return page.evaluate(id => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(window.__visualize.decks[id].canvas, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }, deckId)
}

/**
 * Load the media program on a deck and choose an image file for it, as a
 * user would. `file` is a path on disk to pick instead of in-memory bytes.
 */
async function chooseImage(page, deckId, image, file = { name: 'image.png', mimeType: 'image/png', buffer: image.bytes }) {
    await page.evaluate(async ({ id, dsl }) => {
        const result = await window.__visualize.decks[id].load(dsl, 'Media Input')
        if (!result.success) throw new Error(result.error)
    }, { id: deckId, dsl: MEDIA_DSL })
    await page.locator(`#deck-${deckId.toLowerCase()}-media-file-input`).setInputFiles(file)
    await expect.poll(() => page.evaluate(id => window.__visualize.decks[id].currentDsl, deckId),
        { timeout: 30_000 * SCALE }).toContain(`image:${image.id}`)
}

/**
 * Hold every open of the scene image database until the test calls
 * window.__releaseImageStorage(), so reads and writes of image storage take
 * as long as the test needs. Also count writes of the saved scene list.
 */
async function holdImageStorage(page) {
    await page.addInitScript(key => {
        const open = IDBFactory.prototype.open
        let release
        const released = new Promise(resolve => { release = resolve })
        window.__releaseImageStorage = () => release()
        IDBFactory.prototype.open = function (name, ...rest) {
            if (name !== 'visualize-scene-images') return open.call(this, name, ...rest)
            const request = {}
            released.then(() => {
                const real = open.call(this, name, ...rest)
                real.onupgradeneeded = event => { request.result = real.result; request.onupgradeneeded?.(event) }
                real.onsuccess = event => { request.result = real.result; request.onsuccess?.(event) }
                real.onerror = event => { request.error = real.error; request.onerror?.(event) }
                real.onblocked = event => request.onblocked?.(event)
            })
            return request
        }
        window.__sceneWrites = 0
        const setItem = Storage.prototype.setItem
        Storage.prototype.setItem = function (name, value) {
            setItem.call(this, name, value)
            if (name === key) window.__sceneWrites++
        }
    }, SCENES_KEY)
}

const releaseImageStorage = page => page.evaluate(() => window.__releaseImageStorage())

async function openScenes(page) {
    if (await page.locator('#scenes-drawer').getAttribute('aria-hidden') !== 'false') await page.click('#scenes-open')
}

async function saveScene(page, name) {
    await openScenes(page)
    await page.fill('#scene-name-input', name)
    await page.click('#scene-save')
    await expect(page.locator('#toast')).toContainText(`saved: ${name}`, { timeout: 15_000 * SCALE })
}

async function recallScene(page, name) {
    await openScenes(page)
    const row = page.locator('#scenes-list .scene-row').filter({ has: page.locator('.sr-name', { hasText: new RegExp(`^${name}$`) }) })
    await row.locator('button', { hasText: 'recall' }).click()
}

test('a saved scene keeps its image as a file in IndexedDB and shows it again after a reload', async ({ browser }) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        await page.goto('/')
        await start(page)
        const red = solidPng(64, 36, [255, 0, 0])
        await chooseImage(page, 'A', red)
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        await saveScene(page, 'Red picture')

        const text = await storedScenes(page)
        expect(text).not.toContain('data:')
        const saved = JSON.parse(text).find(scene => scene.name === 'Red picture')
        expect(saved.decks.A.dsl).toContain(`image:${red.id}`)
        expect(saved.decks.A.images).toBeUndefined()
        expect(saved.decks.B.images).toBeUndefined()
        expect(await storedImages(page, [red.id])).toEqual([fileOf(red)])

        await page.reload()
        await start(page)
        expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).not.toContain(red.id)
        await recallScene(page, 'Red picture')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).toContain(`image:${red.id}`)
    } finally {
        await context.close()
    }
})

test('scenes that filled localStorage with image text move it to IndexedDB on load, and scenes save again', async ({ browser }) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        // Three ~915 KB images in four copies, as the old format stored them:
        // one copy per deck per scene.
        const red = solidPng(736, 414, [255, 0, 0])
        const green = solidPng(736, 414, [0, 255, 0])
        const blue = solidPng(736, 414, [0, 0, 255])
        const yellow = solidPng(480, 270, [255, 255, 0])
        const legacy = [legacyScene('Red and green', red, green), legacyScene('Red again', red), legacyScene('Blue', blue)]

        // Seed from a same-origin page that does not run the app.
        await page.goto('/data/programs.json')
        const seeded = await page.evaluate(({ key, value, probe }) => {
            localStorage.clear()
            localStorage.setItem(key, value)
            let refused = false
            try {
                localStorage.setItem('probe', 'x'.repeat(probe))
            } catch (error) {
                refused = error.name === 'QuotaExceededError'
            }
            localStorage.removeItem('probe')
            let used = 0
            for (let i = 0; i < localStorage.length; i++) used += localStorage.key(i).length + localStorage.getItem(localStorage.key(i)).length
            return { used, refused }
        }, { key: SCENES_KEY, value: JSON.stringify(legacy), probe: yellow.dataUrl.length })
        console.log(`[full quota] seeded ${seeded.used} of ${QUOTA} characters; a ${yellow.dataUrl.length}-character image text refused: ${seeded.refused}`)
        expect(seeded.used).toBeGreaterThan(4_850_000)
        expect(seeded.used).toBeLessThan(QUOTA)
        expect(seeded.refused, 'a scene holding one more image as text no longer fits').toBe(true)

        await page.goto('/')
        await start(page)
        await expect.poll(() => storedScenes(page), { timeout: 30_000 * SCALE }).not.toContain('data:')
        const freed = await usedCharacters(page)
        console.log(`[full quota] after moving the images: ${freed} characters in use, ${await storedImageCount(page)} images in IndexedDB`)
        expect(freed).toBeLessThan(20_000)
        const moved = JSON.parse(await storedScenes(page))
        expect(moved.map(scene => scene.name)).toEqual(['Red and green', 'Red again', 'Blue'])
        expect(moved[0].decks.A.dsl).toBe(imageDsl(red.id))
        expect(moved[0].decks.B.dsl).toBe(imageDsl(green.id))
        expect(moved[1].decks.A.dsl).toBe(imageDsl(red.id))
        expect(moved[2].decks.A.dsl).toBe(imageDsl(blue.id))
        expect(moved.flatMap(scene => [scene.decks.A.images, scene.decks.B.images]).filter(images => images?.length)).toEqual([])
        expect(await storedImages(page, [red.id, green.id, blue.id])).toEqual([fileOf(red), fileOf(green), fileOf(blue)])
        expect(await storedImageCount(page), 'one record per image').toBe(3)
        expect(await page.evaluate(length => {
            try {
                localStorage.setItem('probe', 'x'.repeat(length))
                return true
            } catch {
                return false
            } finally {
                localStorage.removeItem('probe')
            }
        }, 4_000_000), 'the quota is free again').toBe(true)

        await chooseImage(page, 'A', yellow)
        await saveScene(page, 'After moving')
        expect(await storedScenes(page)).not.toContain('data:')
        expect(await storedImages(page, [yellow.id])).toEqual([fileOf(yellow)])
        expect(await usedCharacters(page)).toBeLessThan(20_000)

        await page.reload()
        await start(page)
        await recallScene(page, 'After moving')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 255, 0, 255])
        await recallScene(page, 'Red and green')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        await expect.poll(() => deckPixel(page, 'B'), { timeout: 30_000 * SCALE }).toEqual([0, 255, 0, 255])
        await recallScene(page, 'Blue')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([0, 0, 255, 255])
    } finally {
        await context.close()
    }
})

test('a picked file that changes on disk after it is chosen still saves with the bytes that were chosen', async ({ browser }, testInfo) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        await page.goto('/')
        await start(page)
        const red = solidPng(64, 36, [255, 0, 0])
        const path = testInfo.outputPath('picked.png')
        writeFileSync(path, red.bytes)
        await chooseImage(page, 'A', red, path)
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        // The user edits the picked file after choosing it.
        writeFileSync(path, solidPng(64, 36, [0, 0, 255]).bytes)
        await saveScene(page, 'Picked then edited')
        expect(await storedImages(page, [red.id])).toEqual([fileOf(red)])

        await page.reload()
        await start(page)
        await recallScene(page, 'Picked then edited')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
    } finally {
        await context.close()
    }
})

test('a recall still reading its images from storage loses to a newer recall', async ({ browser }) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        await holdImageStorage(page)
        await page.goto('/')
        await start(page)
        await releaseImageStorage(page)
        const red = solidPng(64, 36, [255, 0, 0])
        await chooseImage(page, 'A', red)
        await saveScene(page, 'Red picture')
        // Not a library program, so the deck cannot show it after a reload.
        const plain = NOISE_DSL.replace('101', '505')
        await page.evaluate(async dsl => {
            const result = await window.__visualize.decks.A.load(dsl, 'Noise C')
            if (!result.success) throw new Error(result.error)
        }, plain)
        await saveScene(page, 'Plain')

        // Every page load holds image storage until the test releases it.
        await page.reload()
        await start(page)
        expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).not.toBe(plain)
        await recallScene(page, 'Red picture')
        await recallScene(page, 'Plain')
        await expect.poll(() => page.evaluate(() => window.__visualize.decks.A.currentDsl), { timeout: 30_000 * SCALE }).toBe(plain)
        await releaseImageStorage(page)
        // Let the first recall read its image, then drain deck A's loads.
        await expect.poll(() => storedImages(page, [red.id]), { timeout: 30_000 * SCALE }).toEqual([fileOf(red)])
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)))
        await page.evaluate(() => window.__visualize.decks.A._loadQueue)
        expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).toBe(plain)
    } finally {
        await context.close()
    }
})

test('a save made while older scenes\' images are still moving waits for them, then saves', async ({ browser }) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        await holdImageStorage(page)
        const red = solidPng(736, 414, [255, 0, 0])
        const green = solidPng(736, 414, [0, 255, 0])
        const blue = solidPng(736, 414, [0, 0, 255])
        await page.goto('/data/programs.json')
        await page.evaluate(({ key, value }) => {
            localStorage.clear()
            localStorage.setItem(key, value)
        }, { key: SCENES_KEY, value: JSON.stringify([legacyScene('Red and green', red, green), legacyScene('Blue', blue)]) })

        await page.goto('/')
        await start(page)
        // Image storage is held, so the images are still moving. Fill what
        // localStorage has left, as the old image text did.
        const headroom = await page.evaluate(quota => {
            let used = 0
            for (let i = 0; i < localStorage.length; i++) used += localStorage.key(i).length + localStorage.getItem(localStorage.key(i)).length
            for (let length = quota - used - 3; length > 0; length -= 64) {
                try {
                    localStorage.setItem('pad', 'x'.repeat(length))
                    return quota - used - 3 - length
                } catch {}
            }
            throw new Error('could not fill localStorage')
        }, QUOTA)
        console.log(`[save during migration] ${headroom} characters left before the save`)

        await openScenes(page)
        await page.fill('#scene-name-input', 'While moving')
        await page.click('#scene-save')
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)))
        await expect(page.locator('#toast')).not.toContainText('Could not save')
        expect(await storedScenes(page)).not.toContain('While moving')

        await releaseImageStorage(page)
        await expect(page.locator('#toast')).toContainText('saved: While moving', { timeout: 30_000 * SCALE })
        const saved = JSON.parse(await storedScenes(page))
        expect(saved.map(scene => scene.name)).toEqual(['Red and green', 'Blue', 'While moving'])
        expect(JSON.stringify(saved)).not.toContain('data:')
    } finally {
        await context.close()
    }
})

test('saves finish in click order and keep a name typed while they run', async ({ browser }) => {
    const context = await browser.newContext()
    try {
        const page = await context.newPage()
        await preparePage(page)
        await holdImageStorage(page)
        await page.goto('/')
        await start(page)
        const writes = await page.evaluate(() => window.__sceneWrites)
        const red = solidPng(64, 36, [255, 0, 0])
        await chooseImage(page, 'A', red)
        await openScenes(page)
        // The first save stores an image and waits on image storage.
        await page.fill('#scene-name-input', 'Same')
        await page.click('#scene-save')
        await page.evaluate(async dsl => {
            const result = await window.__visualize.decks.A.load(dsl, 'Noise A')
            if (!result.success) throw new Error(result.error)
        }, NOISE_DSL)
        // The second, without images, is clicked later and must land last.
        await page.fill('#scene-name-input', 'Same')
        await page.click('#scene-save')
        await page.fill('#scene-name-input', 'Draft')
        await releaseImageStorage(page)
        await expect.poll(() => page.evaluate(() => window.__sceneWrites), { timeout: 30_000 * SCALE }).toBe(writes + 2)
        const saved = JSON.parse(await storedScenes(page)).find(scene => scene.name === 'Same')
        expect(saved.decks.A.dsl).toBe(NOISE_DSL)
        await expect(page.locator('#scene-name-input')).toHaveValue('Draft')
        expect(await storedImages(page, [red.id])).toEqual([fileOf(red)])
    } finally {
        await context.close()
    }
})
