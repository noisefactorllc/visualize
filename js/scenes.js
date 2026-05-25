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
 *   - Master FX state (which toggles are active)
 *   - Auto-mix config (enabled, bars-per-scene, fade curve)
 *
 * Scenes persist to localStorage. The first 9 scenes are hotkey-recallable
 * via the number row 1-9 (modified with Shift to avoid clashing with the
 * existing 1-6 master FX shortcuts). Saving a scene with the same name
 * overwrites.
 *
 * Recall is a snap — no animation between current and target state. For
 * smooth scene-to-scene transitions, use Auto-VJ mode instead.
 */

const STORAGE_KEY = 'visualize.scenes.v1'
const MAX_SCENES = 16

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
    static snapshot({ decks, getXfade, getCurve, scheduler, getFxState, getAutoMixConfig }) {
        return {
            createdAt: Date.now(),
            decks: {
                A: {
                    title: decks.A.currentName,
                    dsl: decks.A.currentDsl,
                    speed: decks.A._speed ?? 1
                },
                B: {
                    title: decks.B.currentName,
                    dsl: decks.B.currentDsl,
                    speed: decks.B._speed ?? 1
                }
            },
            xfade: getXfade(),
            curve: getCurve(),
            bpm: scheduler.bpm,
            fx: getFxState(),
            autoMix: getAutoMixConfig()
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
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, refreshAudio }) {
        const errors = []
        // Decks first (compile may take a beat)
        for (const id of ['A', 'B']) {
            const d = snapshot.decks?.[id]
            if (!d || !d.dsl) continue
            try {
                const res = await decks[id].load(d.dsl, d.title || '')
                if (!res.success) errors.push(`deck ${id}: ${res.error}`)
                decks[id].setSpeed(d.speed ?? 1)
            } catch (err) {
                errors.push(`deck ${id}: ${err?.message || err}`)
            }
        }
        refreshAudio?.()
        if (typeof snapshot.bpm === 'number') scheduler.bpm = snapshot.bpm
        if (snapshot.curve) setCurve(snapshot.curve)
        if (typeof snapshot.xfade === 'number') setXfade(snapshot.xfade)
        if (snapshot.fx) setFx(snapshot.fx)
        if (snapshot.autoMix) setAutoMixConfig(snapshot.autoMix)
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
