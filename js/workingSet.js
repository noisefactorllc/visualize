/**
 * WorkingSet — automatic persistence of the live set, so a reload or
 * crash restores the operator's state instead of silently losing it.
 *
 * The scenes feature already knows how to capture the whole live state
 * (Scenes.snapshot) and re-apply it (Scenes.apply); this module is only
 * the storage side of that payload, under its own localStorage key. The
 * app fingerprints the live snapshot continuously and saves it
 * (debounced) whenever it drifts; on boot a saved snapshot is re-applied
 * in place of the random pre-fill.
 *
 * Storage rules mirror scene saves: images a deck shows are stored as
 * files by sceneImages.js and named `image:<sha256>` in the DSL — never
 * as bytes or base64 text here.
 */

const STORAGE_KEY = 'visualize.workingSet.v1'
const VERSION = 1

export { STORAGE_KEY as WORKING_SET_STORAGE_KEY }

/**
 * Minimal shape check for a snapshot we would dare re-apply on boot:
 * known version, deck entries (when present) shaped like deck snapshots,
 * and at least one deck actually carrying a program — both decks empty
 * is the pre-start state, not a set worth restoring.
 *
 * @param {unknown} value - The parsed value to check.
 * @returns {boolean}
 */
export function isValidWorkingSet(value) {
    if (!value || typeof value !== 'object' || value.version !== VERSION) return false
    const decks = value.decks
    if (!decks || typeof decks !== 'object') return false
    for (const id of ['A', 'B']) {
        const deck = decks[id]
        if (deck !== undefined && (typeof deck !== 'object' || deck === null || typeof deck.dsl !== 'string')) {
            return false
        }
    }
    return (typeof decks.A?.dsl === 'string' && decks.A.dsl.trim() !== '') ||
        (typeof decks.B?.dsl === 'string' && decks.B.dsl.trim() !== '')
}

/**
 * The stored working set, or null when absent, unreadable, or not
 * restorable. Never throws: a corrupt entry must not break boot.
 *
 * @param {Storage|null} [storage] - Defaults to window.localStorage.
 * @returns {object|null}
 */
export function loadWorkingSet(storage) {
    try {
        storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
        if (!storage) return null
        const raw = storage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return isValidWorkingSet(parsed) ? parsed : null
    } catch {
        return null
    }
}

/**
 * Store a snapshot with the current version stamp. Returns false when
 * storage refused the write (e.g. the quota is full) — the caller keeps
 * running, it just is not protected by a saved set until the next save.
 *
 * @param {object} snapshot - A Scenes.snapshot payload.
 * @param {Storage|null} [storage] - Defaults to window.localStorage.
 * @returns {boolean}
 */
export function saveWorkingSet(snapshot, storage) {
    try {
        storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null)
        if (!storage) return false
        storage.setItem(STORAGE_KEY, JSON.stringify({ ...snapshot, version: VERSION }))
        return true
    } catch {
        return false
    }
}
