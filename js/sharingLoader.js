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

const PORTABLE_IMAGES_URL = 'https://sharing.noisedeck.app/js/portableImages.js?v=images-20260929'
const IMAGE_ID = /^[a-f0-9]{64}$/
const IMAGE_TIMEOUT_MS = 10000

/**
 * Ready a composition fetched with ?images=files for a deck: load its image
 * files with loadSharedImageFiles. A media effect whose image could not be
 * loaded loses its image URL and draws the default image, as shares did
 * before they carried their images.
 */
export async function loadSharedImages(composition) {
    if (!composition) return composition
    composition.images = await loadSharedImageFiles(composition.images)
    if (typeof composition.dsl === 'string' && /\burl\b/.test(composition.dsl)) {
        const { replaceMediaUrls } = await import(PORTABLE_IMAGES_URL)
        const loaded = new Set((composition.images || []).map(image => image.id))
        composition.dsl = replaceMediaUrls(composition.dsl, url =>
            url?.startsWith('image:') && !loaded.has(url.slice(6)) ? null : undefined)
    }
    return composition
}

/**
 * Shared compositions list their images as { id, url } files. Load each file
 * as binary into the { id, dataUrl, ... } image the renderer binds, checked
 * against its id. A file that cannot be loaded is left out and logged.
 */
export async function loadSharedImageFiles(images = []) {
    if (!Array.isArray(images)) return []
    if (!images.some(image => image?.url && image.dataUrl === undefined)) return images
    const { prepareImage } = await import(PORTABLE_IMAGES_URL)
    const loaded = await Promise.all(images.map(async image => {
        if (!image?.url || image.dataUrl !== undefined) return image
        try {
            if (!IMAGE_ID.test(image.id)) throw new Error('invalid image id')
            // Time-boxed like the composition fetch, so a hung file cannot hold the share prompt.
            const response = await fetch(image.url, { signal: AbortSignal.timeout?.(IMAGE_TIMEOUT_MS) })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const prepared = await prepareImage(await response.blob())
            if (prepared.id !== image.id) throw new Error('the image bytes do not match their id')
            return prepared
        } catch (error) {
            console.warn(`Shared image ${image.id} was not loaded:`, error)
            return null
        }
    }))
    return loaded.filter(Boolean)
}
