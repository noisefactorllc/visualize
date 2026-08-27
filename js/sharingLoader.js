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
    const resp = await fetch(`${SHARING_API_BASE}/api/composition/${encodeURIComponent(code)}`)
    if (!resp.ok) {
        if (resp.status === 404) throw new Error('composition not found or expired')
        throw new Error(`failed to fetch composition (${resp.status})`)
    }
    return resp.json()
}
