/**
 * Sharing loader — fetches compositions from sharing.noisedeck.app
 * given a short code, matching the ?code= URL convention used across
 * the rest of the Noise Factor platform (noisedeck, polymorphic,
 * foundry, shade).
 *
 * Compositions that ship portable (custom) effects via the sharing
 * API's `effects` array are supported: fetchComposition returns the raw
 * response, and the share-loader boot path installs each effect through
 * the user-effects manager (persisted + registered with the engine)
 * before compiling the DSL.
 */

const SHARING_API_BASE = 'https://sharing.noisedeck.app'

/**
 * Pull the ?code= short code from the current URL, or null if absent.
 */
export function getCodeFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search)
        return params.get('code')
    } catch {
        return null
    }
}

/**
 * Strip ?code= from the URL bar without reloading, so a manual reload
 * doesn't re-prompt the share-loader dialog. Other query params are
 * preserved.
 */
export function clearCodeFromUrl() {
    try {
        const url = new URL(window.location.href)
        if (!url.searchParams.has('code')) return
        url.searchParams.delete('code')
        window.history.replaceState({}, '', url.toString())
    } catch { /* best-effort */ }
}

/**
 * Fetch composition metadata + DSL by short code. Throws on network
 * failure or 4xx/5xx; returns the parsed response on success. The
 * response shape (from sharing.noisedeck.app/api/composition/:code):
 *   { code, dsl, title, description, hasEffects, effects, ... }
 */
export async function fetchComposition(code) {
    const resp = await fetch(`${SHARING_API_BASE}/api/composition/${encodeURIComponent(code)}?images=files`)
    if (!resp.ok) {
        if (resp.status === 404) throw new Error('composition not found or expired')
        throw new Error(`failed to fetch composition (${resp.status})`)
    }
    return loadSharedImages(await resp.json())
}

export const PORTABLE_IMAGES_URL = 'https://sharing.noisedeck.app/js/portableImages.js?v=images-20261006'
const IMAGE_ID = /^[a-f0-9]{64}$/
const IMAGE_TIMEOUT_MS = 10000

/**
 * Ready a composition fetched with ?images=files for a deck: load its image
 * files with loadSharedImageFiles. A media effect whose image could not be
 * loaded loses its image URL and draws the default image, as shares did
 * before they carried their images. A program that names an image inline,
 * as a base64 data: URL, gets it as a file named image:<id> instead.
 */
export async function loadSharedImages(composition) {
    if (!composition) return composition
    composition.images = await loadSharedImageFiles(composition.images)
    if (typeof composition.dsl === 'string' && /\burl\b/.test(composition.dsl)) {
        const tools = await import(PORTABLE_IMAGES_URL)
        const inline = await fileInlineImages(composition.dsl, tools, { skipInvalid: true })
        for (const image of inline.images) {
            if (!composition.images.some(asset => asset.id === image.id)) composition.images.push(image)
        }
        const loaded = new Set(composition.images.map(image => image.id))
        composition.dsl = tools.replaceMediaUrls(inline.dsl, url =>
            url?.startsWith('image:') && !loaded.has(url.slice(6)) ? null : undefined)
    }
    return composition
}

/**
 * Shared compositions list their images as { id, url } files. Load each file
 * as binary into the { id, blob, ... } image the renderer binds, checked
 * against its id. Responses from before image files list { id, dataUrl }
 * images; each is read from that text once, as bytes. An image that cannot
 * be loaded is left out and logged.
 */
export async function loadSharedImageFiles(images = []) {
    if (!Array.isArray(images)) return []
    if (!images.some(image => image?.url || image?.dataUrl !== undefined)) return images
    const { imageToBlob, prepareImageFile } = await import(PORTABLE_IMAGES_URL)
    const loaded = await Promise.all(images.map(async image => {
        if (!image?.url && image?.dataUrl === undefined) return image
        try {
            if (!IMAGE_ID.test(image.id)) throw new Error('invalid image id')
            let blob
            if (image.dataUrl !== undefined) blob = imageToBlob(image)
            else {
                // Time-boxed like the composition fetch, so a hung file cannot hold the share prompt.
                const response = await fetch(image.url, { signal: AbortSignal.timeout?.(IMAGE_TIMEOUT_MS) })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                blob = await response.blob()
            }
            const prepared = await prepareImageFile(blob)
            if (prepared.id !== image.id) throw new Error('the image bytes do not match their id')
            return prepared
        } catch (error) {
            console.warn(`Shared image ${image.id} was not loaded:`, error)
            return null
        }
    }))
    return loaded.filter(Boolean)
}

/**
 * Turn each image a program names inline, as a base64 data: URL, into an
 * image file: { id, blob, mimeType, width, height }, named image:<id> in the
 * returned program. Other media URLs are left as they are. An inline image
 * that is not a valid image throws, or with skipInvalid loses its URL and
 * draws the default image.
 *
 * @param {string} dsl
 * @param {object} tools the portableImages module
 * @returns {Promise<{dsl: string, images: Array<{id: string, blob: Blob}>}>}
 */
export async function fileInlineImages(dsl, tools, { skipInvalid = false } = {}) {
    if (typeof dsl !== 'string' || !dsl.includes('data:')) return { dsl, images: [] }
    const files = new Map(), replacements = new Map()
    for (const { url, mediaIndex } of tools.getMediaSources(dsl)) {
        if (!url?.startsWith('data:')) continue
        try {
            const image = await tools.prepareImageFile(tools.imageToBlob({ dataUrl: url }))
            files.set(image.id, image)
            replacements.set(mediaIndex, `image:${image.id}`)
        } catch (error) {
            if (!skipInvalid) throw error
            console.warn('An inline image was not loaded:', error)
            replacements.set(mediaIndex, null)
        }
    }
    if (!replacements.size) return { dsl, images: [] }
    return {
        dsl: tools.replaceMediaUrls(dsl, (url, index) => replacements.has(index) ? replacements.get(index) : url),
        images: [...files.values()],
    }
}
