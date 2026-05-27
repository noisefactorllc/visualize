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
 * Recall is a snap — no animation between current and target state. For
 * smooth scene-to-scene transitions, use Auto-VJ mode instead.
 */

const STORAGE_KEY = 'visualize.scenes.v1'
const MAX_SCENES = 16

/** Snapshot a deck's rebind state. Overrides are pure AST nodes —
 *  JSON-clone is safe (no functions, no cycles). */
function cloneRebind(rebind) {
    if (!rebind) return { originalDsl: '', bandpass: true, overrides: {} }
    return {
        originalDsl: rebind.originalDsl || '',
        bandpass: rebind.bandpass !== false,
        overrides: JSON.parse(JSON.stringify(rebind.overrides || {}))
    }
}

export class Scenes {
    constructor() {
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

    save(name, snapshot) {
        if (!name) return false
        const trimmed = name.trim().slice(0, 40)
        if (!trimmed) return false
        const existing = this._scenes.findIndex(s => s.name === trimmed)
        const entry = { name: trimmed, ...snapshot }
        if (existing >= 0) {
            this._scenes[existing] = entry
        } else {
            if (this._scenes.length >= MAX_SCENES) {
                // Drop the oldest non-pinned scene
                this._scenes.shift()
            }
            this._scenes.push(entry)
        }
        this._persist()
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
     * Apply a scene to the live app state via supplied applicators.
     * Returns a list of any errors encountered (per-deck load failures
     * mostly), but always applies as much as it can.
     */
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, setAutoXfadeConfig, setMixerState, setDeckDensity, refreshAudio, refreshRebind }) {
        const errors = []
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
                const res = await decks[id].load(originalDsl, d.title || '')
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

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            const list = raw ? JSON.parse(raw) : []
            return Array.isArray(list) ? list : []
        } catch {
            return []
        }
    }

    _persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._scenes))
        } catch (err) {
            // QuotaExceededError — most likely scenes filled the budget
            console.warn('[Scenes] persist failed', err)
        }
    }
}
