/**
 * Scenes — named snapshots of the whole VJ state, recallable on demand.
 *
 * What's captured:
 *   - Both decks: program title (so we don't bloat localStorage with
 *     the DSL string when the program is in the library) AND the
 *     raw DSL (so a tweaked-but-unsaved deck still round-trips)
 *   - Per-deck speed multiplier
 *   - Crossfader value + current curve
 *   - BPM
 *   - Main FX state (which toggles are active)
 *   - Auto-mix config (enabled, bars-per-scene, fade curve)
 *
 * Scenes persist to localStorage. The first 9 scenes are hotkey-recallable
 * via the number row 1-9 (modified with Shift to avoid clashing with the
 * existing 1-6 main FX shortcuts). Saving a scene with the same name
 * overwrites.
 *
 * A scene names each image its decks show as `image:<sha256>` in its DSL;
 * the image files are stored once each in IndexedDB by sceneImages.js,
 * never as text in the scene.
 *
 * Recall is a snap — no animation between current and target state. For
 * smooth scene-to-scene transitions, use Auto-VJ mode instead.
 */

const STORAGE_KEY = 'visualize.scenes.v1'
const MAX_SCENES = 16
// Counts recalls, so a recall that a newer one overtook stops.
let recallGeneration = 0

export { STORAGE_KEY as SCENES_STORAGE_KEY, MAX_SCENES }

/**
 * Validates a proposed scene name against empty/whitespace-only input,
 * length constraints, and duplicate names in existing scenes.
 *
 * @param {string} name - The proposed scene name.
 * @param {string|null} [currentName=null] - The current name of the scene if renaming.
 * @param {Array<Object|string>} [existingScenes=[]] - Existing scenes to check against.
 * @returns {{ ok: boolean, success: boolean, name?: string, unchanged?: boolean, error?: string, message?: string }}
 */
export function validateSceneName(name, currentName = null, existingScenes = []) {
    if (typeof name !== 'string') {
        return { ok: false, success: false, error: 'empty', message: 'Scene name cannot be empty' }
    }
    const trimmed = name.trim().slice(0, 40)
    if (!trimmed) {
        return { ok: false, success: false, error: 'empty', message: 'Scene name cannot be empty' }
    }

    const curTrimmed = typeof currentName === 'string' ? currentName.trim() : null
    if (curTrimmed && trimmed.toLowerCase() === curTrimmed.toLowerCase()) {
        return { ok: true, success: true, name: trimmed, unchanged: trimmed === curTrimmed }
    }

    const isDuplicate = existingScenes.some(s => {
        const sName = typeof s === 'string' ? s.trim() : (typeof s?.name === 'string' ? s.name.trim() : '')
        if (!sName) return false
        if (curTrimmed && sName.toLowerCase() === curTrimmed.toLowerCase()) return false
        return sName.toLowerCase() === trimmed.toLowerCase()
    })

    if (isDuplicate) {
        return { ok: false, success: false, error: 'duplicate', message: `A scene named "${trimmed}" already exists` }
    }

    return { ok: true, success: true, name: trimmed }
}

/** Snapshot a deck's rebind state. Overrides are pure AST nodes —
 *  JSON-clone is safe (no functions, no cycles). */
function cloneRebind(rebind) {
    if (!rebind) return { originalDsl: '', bandpass: true, oscillatorCount: 0, overrides: {} }
    return {
        originalDsl: rebind.originalDsl || '',
        bandpass: rebind.bandpass !== false,
        oscillatorCount: Math.max(0, Math.min(4, (rebind.oscillatorCount ?? 0) | 0)),
        overrides: JSON.parse(JSON.stringify(rebind.overrides || {}))
    }
}

export class Scenes {
    constructor(options = {}) {
        this._storage = options?.storage || (typeof localStorage !== 'undefined' ? localStorage : null)
        this._scenes = this._load()
        this._listeners = []
    }

    get scenes() { return [...this._scenes] }

    onChange(cb) { this._listeners.push(cb) }
    _emit() { for (const cb of this._listeners) cb(this._scenes) }

    /**
     * Build a snapshot from the current app state. The app supplies
     * accessors for everything; we don't poke at app internals.
     */
    static snapshot({ decks, getXfade, getCurve, scheduler, getFxState, getAutoMixConfig, getMixerState, getDeckDensity, getAutoXfadeConfig }) {
        return {
            createdAt: Date.now(),
            decks: {
                A: {
                    title: decks.A.currentName,
                    dsl: decks.A.currentDsl,
                    speed: decks.A._speed ?? 1,
                    rebind: cloneRebind(decks.A.rebind)
                },
                B: {
                    title: decks.B.currentName,
                    dsl: decks.B.currentDsl,
                    speed: decks.B._speed ?? 1,
                    rebind: cloneRebind(decks.B.rebind)
                }
            },
            xfade: getXfade(),
            curve: getCurve(),
            bpm: scheduler.bpm,
            divider: scheduler.divider,
            fx: getFxState(),
            autoMix: getAutoMixConfig(),
            autoXfade: getAutoXfadeConfig?.() || null,
            mixer: getMixerState?.() || null,
            deckDensity: getDeckDensity?.() || null
        }
    }

    /**
     * The image files a snapshot's decks show, for sceneImages.js to store
     * before the scene is saved. Call it right after snapshot(), so the
     * files match the DSL it captured.
     *
     * @returns {Array<{id: string, blob: Blob}>}
     */
    static imageFiles(snapshot, decks) {
        return ['A', 'B'].flatMap(id => decks[id]?.getImageFiles?.(snapshot.decks?.[id]?.dsl) ?? [])
    }

    save(name, snapshot) {
        if (!name) return false
        const trimmed = name.trim().slice(0, 40)
        if (!trimmed) return false
        const existing = this._scenes.findIndex(s => s.name === trimmed)
        const previous = [...this._scenes]
        const entry = { name: trimmed, ...snapshot }
        if (existing >= 0) {
            this._scenes[existing] = entry
        } else {
            if (this._scenes.length >= MAX_SCENES) {
                // At capacity: drop the oldest scene (FIFO). Note this
                // shifts every number-row hotkey (byIndex is positional),
                // so slot ⇧1 becomes what was ⇧2, etc.
                this._scenes.shift()
            }
            this._scenes.push(entry)
        }
        if (!this._persist()) { this._scenes = previous; return false }
        this._emit()
        return true
    }

    delete(name) {
        const before = this._scenes.length
        this._scenes = this._scenes.filter(s => s.name !== name)
        if (this._scenes.length !== before) {
            this._persist()
            this._emit()
            return true
        }
        return false
    }

    /** Scene at index 0..MAX_SCENES-1 (used for number-row hotkeys). */
    byIndex(i) {
        return this._scenes[i] || null
    }

    byName(name) {
        return this._scenes.find(s => s.name === name) || null
    }

    /**
     * Validate a proposed scene name against existing scenes.
     */
    static validateName(name, currentName = null, existingScenes = []) {
        return validateSceneName(name, currentName, existingScenes)
    }

    /**
     * Validate a proposed scene name against this instance's current scenes.
     */
    validateName(newName, currentName = null) {
        return validateSceneName(newName, currentName, this._scenes)
    }

    /**
     * Rename an existing scene, validating against empty and duplicate names.
     * Preserves scene order, index position (Shift+1..9 hotkeys), and snapshot contents.
     *
     * @param {string|Object} oldName - The current scene name or scene object.
     * @param {string} newName - The proposed new scene name.
     * @returns {{ ok: boolean, success: boolean, name?: string, prevName?: string, unchanged?: boolean, error?: string, message?: string }}
     */
    rename(oldName, newName) {
        if (!oldName || (typeof oldName !== 'string' && typeof oldName !== 'object')) {
            return { ok: false, success: false, error: 'not_found', message: 'Scene not found' }
        }
        let scene = null
        if (typeof oldName === 'object' && oldName !== null) {
            scene = this._scenes.find(s => s === oldName)
        }
        const lookup = typeof oldName === 'object' && oldName !== null ? oldName.name : oldName
        if (!scene && typeof lookup === 'string' && lookup.trim()) {
            const trimmedOld = lookup.trim()
            // Exact match pass first
            scene = this._scenes.find(s => s.name === trimmedOld)
            // Case-insensitive fallback
            if (!scene) {
                scene = this._scenes.find(s => s.name.toLowerCase() === trimmedOld.toLowerCase())
            }
        }
        if (!scene) {
            return { ok: false, success: false, error: 'not_found', message: `Scene "${lookup || oldName}" not found` }
        }

        const res = validateSceneName(newName, scene.name, this._scenes)
        if (!res.ok) return res

        if (res.name === scene.name) {
            return { ok: true, success: true, name: scene.name, unchanged: true }
        }

        const prevName = scene.name
        scene.name = res.name
        this._persist()
        this._emit()
        return { ok: true, success: true, name: res.name, prevName }
    }

    /**
     * Apply a scene to the live app state via supplied applicators.
     * Returns a list of any errors encountered (per-deck load failures
     * mostly), but always applies as much as it can.
     */
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, setAutoXfadeConfig, setMixerState, setDeckDensity, refreshAudio, refreshRebind }) {
        const errors = []
        const generation = ++recallGeneration
        // Per-deck density first — it affects the renderer's buffer
        // size and must be set before compile so the new program
        // renders at the right resolution from the first frame.
        if (snapshot.deckDensity && setDeckDensity) {
            try { setDeckDensity(snapshot.deckDensity) }
            catch (err) { errors.push(`density: ${err?.message || err}`) }
        }
        // Decks (compile may take a beat)
        for (const id of ['A', 'B']) {
            const d = snapshot.decks?.[id]
            if (!d || !d.dsl) continue
            try {
                // Load the original DSL first — load() resets rebind
                // state, so we have to do this BEFORE restoring the
                // override map. Snapshots from before rebind shipped
                // won't have rebind.originalDsl, so fall back to dsl.
                const originalDsl = d.rebind?.originalDsl || d.dsl
                decks[id].images = d.images || []
                const loadVersion = decks[id]._loadVersion
                // The scene names its images; their files are in image storage.
                await decks[id].loadStoredImages?.(originalDsl)
                // Reading image storage takes time. A newer recall owns the
                // decks now; a program loaded meanwhile owns this one.
                if (generation !== recallGeneration) return errors
                if (decks[id]._loadVersion !== loadVersion) continue
                const res = await decks[id].load(originalDsl, d.title || '')
                if (res.superseded) continue
                if (!res.success) {
                    errors.push(`deck ${id}: ${res.error}`)
                    continue
                }
                decks[id].setSpeed(d.speed ?? 1)
                // Restore the operator's bandpass + overrides choice,
                // then re-roll the regenerated DSL on top via the
                // rebind module (reloadDsl preserves the state we
                // just put back).
                if (d.rebind) {
                    decks[id].rebind.bandpass = d.rebind.bandpass !== false
                    decks[id].rebind.oscillatorCount = Math.max(0, Math.min(4, (d.rebind.oscillatorCount ?? 0) | 0))
                    decks[id].rebind.overrides = JSON.parse(JSON.stringify(d.rebind.overrides || {}))
                    if (Object.keys(decks[id].rebind.overrides).length > 0) {
                        const { regenerateDsl } = await import('./rebind.js')
                        const newDsl = regenerateDsl(decks[id].rebind.originalDsl, decks[id].rebind.overrides)
                        if (newDsl) await decks[id].reloadDsl(newDsl)
                    }
                }
            } catch (err) {
                errors.push(`deck ${id}: ${err?.message || err}`)
            }
        }
        refreshAudio?.()
        refreshRebind?.()
        if (typeof snapshot.bpm === 'number') scheduler.bpm = snapshot.bpm
        if (typeof snapshot.divider === 'number') scheduler.divider = snapshot.divider
        if (snapshot.curve) setCurve(snapshot.curve)
        if (typeof snapshot.xfade === 'number') setXfade(snapshot.xfade)
        if (snapshot.fx) setFx(snapshot.fx)
        if (snapshot.autoMix) setAutoMixConfig(snapshot.autoMix)
        // Apply autoXfade AFTER autoMix so the mutual-exclusion wiring
        // (autoXfade.setEnabled(true) → autoMix.setEnabled(false))
        // wins cleanly if a malformed snapshot has both enabled.
        if (snapshot.autoXfade && setAutoXfadeConfig) {
            try { setAutoXfadeConfig(snapshot.autoXfade) }
            catch (err) { errors.push(`autoXfade: ${err?.message || err}`) }
        }
        if (snapshot.mixer && setMixerState) {
            try { await setMixerState(snapshot.mixer) }
            catch (err) { errors.push(`mixer: ${err?.message || err}`) }
        }
        return errors
    }

    /**
     * Move images that older saves kept inside scenes, as base64 text, out
     * to image storage, then remove the text from the stored scenes.
     *
     * A deck loses its embedded images only after `store` has committed
     * every one of them, so a failure leaves it exactly as it was. Storage
     * is re-read after the writes, because a save made meanwhile, here or in
     * another tab, must not be overwritten by the list this started with.
     *
     * @param {(images: Array<{id: string, dataUrl: string}>) => Promise<void>} store
     * @returns {Promise<number>} how many decks' images were moved
     */
    async moveEmbeddedImages(store) {
        const embedded = scene => [scene?.decks?.A, scene?.decks?.B]
            .filter(deck => Array.isArray(deck?.images) && deck.images.length > 0)
        const stored = new Set()
        for (const scene of this._scenes) {
            for (const deck of embedded(scene)) {
                for (const image of deck.images) {
                    if (stored.has(image?.id)) continue
                    try {
                        await store([image])
                        stored.add(image.id)
                    } catch (err) {
                        console.error(`[Scenes] could not move an image of scene "${scene.name}"`, err)
                    }
                }
            }
        }
        if (!stored.size) return 0
        const scenes = this._read()
        if (!scenes) return 0
        let moved = 0
        for (const scene of scenes) {
            for (const deck of embedded(scene)) {
                if (deck.images.every(image => stored.has(image?.id))) {
                    delete deck.images
                    moved++
                }
            }
        }
        if (!moved) {
            // Another tab may have moved them already: take the list it
            // wrote, so the next save here does not write the text back.
            this._scenes = scenes
            this._emit()
            return 0
        }
        const previous = this._scenes
        this._scenes = scenes
        if (!this._persist()) {
            // Nothing was written: storage still holds the images as text.
            this._scenes = previous
            return 0
        }
        this._emit()
        return moved
    }

    _load() {
        return this._read() || []
    }

    /** The stored scene list, or null when storage cannot be read or parsed. */
    _read() {
        try {
            const storage = this._storage || (typeof localStorage !== 'undefined' ? localStorage : null)
            if (!storage) return null
            const raw = storage.getItem(STORAGE_KEY)
            const list = raw ? JSON.parse(raw) : []
            return Array.isArray(list) ? list : null
        } catch {
            return null
        }
    }

    _persist() {
        try {
            const storage = this._storage || (typeof localStorage !== 'undefined' ? localStorage : null)
            if (!storage) return false
            storage.setItem(STORAGE_KEY, JSON.stringify(this._scenes))
            return true
        } catch (err) {
            // QuotaExceededError — most likely scenes filled the budget
            console.warn('[Scenes] persist failed', err)
            return false
        }
    }
}
