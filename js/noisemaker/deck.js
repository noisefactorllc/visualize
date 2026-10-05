/**
 * Deck — a single visualizer renderer instance.
 *
 * Wraps the Noisemaker CanvasRenderer with the surface the VJ stage needs:
 *
 *  - compile(dsl) loads required effects on-demand and starts the loop
 *  - audioState / midiState hooks (created lazily, shared by SharedInputs)
 *  - speed multiplier (loop duration shortcut)
 *  - one-shot freeze (renderer.stop / start)
 *
 * Image references retain original bytes for Sharing and Seance.
 */

import {
    CanvasRenderer,
    CDN_BASE,
    extractEffectNamesFromDsl,
    extractEffectsFromDsl
} from './bundle.js'

/**
 * Effect-namespace + tag heuristics for "compute-heavy" programs that
 * should auto-step-down their pixel density. Exposed as a module-level
 * pure function so the app's loadProgram path can ask "is this heavy?"
 * before the deck even compiles it.
 *
 *  - Anything in the points/* namespace runs a per-particle simulation
 *    every frame.
 *  - Effects tagged "sim" in the noisemaker manifest do per-pixel state
 *    evolution (cellular automata, reaction-diffusion, MNCA, etc.) and
 *    grow quadratically in cost with buffer size.
 *
 * Pass the renderer's manifest in for sim-tag lookup; effectIds alone
 * are enough to catch the points namespace.
 */
export function isHeavyDsl(dsl, manifest = {}) {
    let effects
    try {
        effects = extractEffectNamesFromDsl(dsl, manifest)
    } catch {
        return false
    }
    for (const e of effects) {
        const id = e.effectId || ''
        if (id.startsWith('points/')) return true
        const tags = manifest[id]?.tags || []
        if (tags.includes('sim')) return true
    }
    return false
}

function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return m ? [
        parseInt(m[1], 16) / 255,
        parseInt(m[2], 16) / 255,
        parseInt(m[3], 16) / 255
    ] : [1, 1, 1]
}

/**
 * Coerce an upstream/persisted numeric state to a finite number.
 * Accepts finite numbers and numeric strings ('0.5'); rejects NaN,
 * ±Infinity, booleans, null, and non-numeric strings. Returns null
 * when invalid so callers can keep their current live state instead
 * of stomping a running deck with NaN (a corrupt localStorage payload
 * or a NaN upstream computation must never zero the render buffer or
 * freeze the loop mid-set).
 */
export function toFiniteNumber(value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export class Deck {
    constructor(canvas, options = {}) {
        this.canvas = canvas
        this.id = options.id || 'deck'
        this.width = options.width || 1280
        this.height = options.height || 720
        this.loopDuration = options.loopDuration || 10
        this.preferWebGPU = !!options.preferWebGPU
        this.onError = options.onError || ((err) => console.error(`[${this.id}]`, err))

        this.canvas.width = this.width
        this.canvas.height = this.height

        this._renderer = new CanvasRenderer({
            canvas: this.canvas,
            width: this.width,
            height: this.height,
            basePath: CDN_BASE,
            preferWebGPU: this.preferWebGPU,
            useBundles: true,
            bundlePath: `${CDN_BASE}/effects`,
            onError: (err) => this.onError(err)
        })

        this._initialized = false
        this._disposed = false
        this._loadVersion = 0
        this._loadQueue = Promise.resolve()
        this._currentDsl = ''
        this.images = []
        // Original image files by id, so a saved scene stores the file, not text.
        this.imageBlobs = new Map()
        // id => Blob|null: a saved scene's image from image storage.
        this.storedImage = options.storedImage || null
        this.resolveImage = null
        this._imageTools = null
        this._currentName = ''
        this._speed = 1
        this._pixelDensity = 1.0    // 1.0 = full mainRes; 0.5 = half-res buffer upscaled

        // Per-deck rebind state. originalDsl is the pristine DSL from
        // the library entry; overrides is the last-rolled EQ/MIDI
        // override map (cleared on a fresh load(), preserved across
        // reloadDsl() calls so the rebind module can push regenerated
        // DSL without stomping its own state). bandpass is operator-set
        // and persisted to localStorage by the app.
        this.rebind = {
            originalDsl: '',
            bandpass: true,
            oscillatorCount: 0,   // 0..4 oscillators per rebind roll
            overrides: {}
        }
    }

    get pixelDensity() { return this._pixelDensity }

    /**
     * Set the render-buffer scale. 1.0 keeps the buffer at the deck's
     * logical width/height; 0.5 halves it (¼ the pixel work) and lets
     * the canvas display CSS upscale to fit the deck container. Use to
     * keep heavy programs (points/* simulations, MNCA, reaction-
     * diffusion) playable on modest GPUs.
     *
     * Logical (mainRes-aligned) width/height stay unchanged so the
     * compositor + recording paths keep working at full resolution; only
     * the underlying renderer's buffer shrinks.
     */
    setPixelDensity(density) {
        const d = toFiniteNumber(density)
        if (d === null) return
        const clamped = Math.max(0.1, Math.min(1.0, d))
        if (clamped === this._pixelDensity) return
        this._pixelDensity = clamped
        const bufW = Math.max(1, Math.round(this.width * clamped))
        const bufH = Math.max(1, Math.round(this.height * clamped))
        this.canvas.width = bufW
        this.canvas.height = bufH
        this._renderer.resize(bufW, bufH)
        this._rebindImages()
    }

    get inner() { return this._renderer }
    get isRunning() { return !!this._renderer.isRunning }
    get currentFPS() { return this._renderer.currentFPS || 0 }
    get currentName() { return this._currentName }
    get currentDsl() { return this._currentDsl }
    /**
     * The REQUESTED backend, normalized to 'webgpu' / 'webgl2'. This only
     * mirrors the renderer's preference flag — it does NOT prove WebGPU
     * actually engaged. The engine silently falls back to WebGL2 when
     * WebGPU is unavailable without clearing the flag, so this can read
     * 'webgpu' while WebGL2 is really running. For what's actually in use,
     * read `activeBackend`.
     */
    get backend() {
        const b = this._renderer.backend
        return b === 'wgsl' ? 'webgpu' : (b || 'webgl2')
    }

    /**
     * The backend ACTUALLY in use, read from the live pipeline's backend
     * object (WebGPUBackend / WebGL2Backend expose getName()), normalized
     * to 'webgpu' / 'webgl2'. The pipeline only exists after the first
     * successful compile, so before then (and on any engine that predates
     * getName()) we fall back to the requested preference. This is the
     * honest signal the settings "active renderer" indicator shows, so an
     * operator can tell when a WebGPU preference silently dropped to
     * WebGL2 (unsupported browser, adapter request failure).
     */
    get activeBackend() {
        const name = this._renderer.pipeline?.backend?.getName?.()
        if (name === 'WebGPU') return 'webgpu'
        if (name === 'WebGL2') return 'webgl2'
        return this.backend
    }

    async init() {
        if (this._initialized) return
        await this._renderer.loadManifest()
        this._renderer.setLoopDuration(this.loopDuration)
        this._initialized = true
    }

    start() { this._renderer.start() }
    stop() { this._renderer.stop() }

    /**
     * Invalidate any in-flight or queued compile operations on this deck.
     * Any pending load() or reloadDsl() call will resolve with
     * { success: false, superseded: true } so callers suppress UI and audio
     * rebind publication. If a compile has already reached the renderer,
     * hardware state remains tracked without publishing stale metadata.
     */
    cancelPending() {
        this._loadVersion++
    }

    /**
     * Load a DSL program by string. Returns { success, error } so caller
     * knows whether compile succeeded. On error, keeps the current program
     * running and surfaces the message to the caller.
     */
    async load(dsl, name = '') {
        return this._queueLoad(dsl, name, true)
    }

    getImageAssets(dsl = this._currentDsl) {
        if (!this._imageTools && /\burl\b/.test(dsl)) throw new Error('Images are still loading; try again shortly')
        return this._imageTools?.getReferencedImages(dsl, this.images) || []
    }

    /** The files of the images a DSL references, for a saved scene to store. */
    getImageFiles(dsl = this._currentDsl) {
        return this.getImageAssets(dsl).map(image => ({
            id: image.id,
            blob: this.imageBlobs.get(image.id) || this._imageTools.imageToBlob(image)
        }))
    }

    /**
     * Ready the images a saved scene's DSL references: one the deck does not
     * hold comes from image storage and is prepared like a chosen file.
     */
    async loadStoredImages(dsl) {
        if (!this.storedImage || !/\burl\b/.test(dsl)) return
        this._imageTools ||= await import('https://sharing.noisedeck.app/js/portableImages.js?v=images-20260929')
        for (const { url } of this._imageTools.getMediaSources(dsl)) {
            const id = url?.startsWith('image:') ? url.slice(6) : null
            if (!id || this.images.some(asset => asset.id === id)) continue
            const blob = await this.storedImage(id)
            if (!blob) continue
            const image = await this._imageTools.prepareImage(blob)
            if (image.id !== id) throw new Error(`Stored image bytes do not match their id: ${id}`)
            if (!this.images.some(asset => asset.id === id)) this.images.push(image)
            this.imageBlobs.set(id, blob)
        }
    }

    async setImage(blob, mediaIndex = 0) {
        const dsl = this._currentDsl, version = this._loadVersion
        this._imageTools ||= await import('https://sharing.noisedeck.app/js/portableImages.js?v=images-20260929')
        const image = await this._imageTools.prepareImage(blob)
        if (this._disposed || version !== this._loadVersion) return { success: false, superseded: true }
        if (!this._imageTools.getMediaSources(dsl)[mediaIndex]) throw new Error('Select a program with a media effect first')
        if (!this.images.some(asset => asset.id === image.id)) this.images.push(image)
        this.imageBlobs.set(image.id, blob.type === image.mimeType ? blob : new Blob([blob], { type: image.mimeType }))
        const updated = this._imageTools.replaceMediaUrls(dsl, (url, index) => index === mediaIndex ? `image:${image.id}` : url)
        return this.load(updated, this._currentName)
    }

    // CanvasRenderer mutates a shared pipeline across awaited compilation.
    // Run one load at a time and discard obsolete queued requests. Callers
    // must not publish or relabel a request that returns superseded: true.
    async _queueLoad(dsl, name, resetRebind) {
        const version = ++this._loadVersion
        const rebindSource = resetRebind ? null : {
            name: this._currentName,
            originalDsl: this.rebind.originalDsl,
            overrides: this.rebind.overrides,
        }
        const previous = this._loadQueue
        let release
        this._loadQueue = new Promise(resolve => { release = resolve })
        const superseded = () => ({ success: false, superseded: true })

        try {
            await previous
            if (this._disposed || version !== this._loadVersion) return superseded()
            if (!this._initialized) await this.init()
            if (version !== this._loadVersion) return superseded()
            if (/\burl\b/.test(dsl) && !this._imageTools) this._imageTools = await import('https://sharing.noisedeck.app/js/portableImages.js?v=images-20260929')
            const engineDsl = this._imageTools?.stripMediaUrls(dsl) ?? dsl
            const effectData = extractEffectNamesFromDsl(engineDsl, this._renderer.manifest || {})
            const effectIds = effectData.map(e => e.effectId)
            if (effectIds.length > 0) {
                await this._renderer.loadEffects(effectIds)
            }
            if (version !== this._loadVersion) return superseded()
            await this._renderer.compile(engineDsl)
            if (this._disposed) return superseded()
            // Compilation has installed this program even if another request
            // arrived meanwhile. Record the actual last successful render so
            // a failing next request cannot leave stale metadata behind.
            this._currentDsl = dsl
            // New program → rebind state resets to the author's
            // original. The rebind module's reloadDsl() path does NOT
            // touch this — it's how rebind can push regenerated DSL
            // without wiping its own overrides.
            if (resetRebind) {
                this._currentName = name
                this.rebind.originalDsl = dsl
                this.rebind.overrides = {}
            } else {
                this._currentName = rebindSource.name
                this.rebind.originalDsl = rebindSource.originalDsl
                this.rebind.overrides = rebindSource.overrides
            }
            this._normalizeColorUniforms()
            // recompile() preserves o0..oN textures so stateful effects
            // (reaction-diffusion, MNCA, CA, feedback) keep evolving on
            // recompile. For a fresh program load that's wrong — the
            // new program inherits the old's seed. Wipe surfaces here.
            if (resetRebind) this.clearSurfaces()
            if (this._imageTools) await this._imageTools.bindMediaImages(this._renderer, dsl, this.images, { extractEffectsFromDsl, resolveImage: this.resolveImage })
            if (this._disposed || version !== this._loadVersion) return superseded()
            if (!this._renderer.isRunning) this._renderer.start()
            if (version !== this._loadVersion) return superseded()
            return { success: true }
        } catch (err) {
            if (version !== this._loadVersion) return superseded()
            const msg = typeof err === 'string' ? err
                : err?.message || err?.error || 'Unknown compile error'
            console.error(`[${this.id}] load error:`, err)
            return { success: false, error: msg }
        } finally {
            release()
        }
    }

    /**
     * Reload the renderer with a new DSL string WITHOUT resetting the
     * deck's rebind state (originalDsl, overrides). Used by the rebind
     * module to push regenerated DSL.
     *
     * On compile error the deck keeps running the previous DSL — same
     * behaviour as load(). Returns { success, error? }.
     */
    async reloadDsl(dsl) {
        if (this._imageTools) dsl = this._imageTools.restoreMediaUrls(this.rebind.originalDsl, dsl)
        return this._queueLoad(dsl, '', false)
    }

    /** Current effective playback speed (the source of truth for MIDI takeover). */
    get speed() {
        return this._speed
    }

    /**
     * Set effective playback speed by adjusting loop duration.
     * speed > 1 = faster (shorter loop), < 1 = slower.
     */
    setSpeed(speed) {
        const s = toFiniteNumber(speed)
        if (s === null) return
        this._speed = Math.max(0.05, s)
        const dur = this.loopDuration / this._speed
        this._renderer.setLoopDuration(dur)
    }

    /**
     * Replace the base loop duration (e.g. when user changes "loop duration"
     * in settings). Reapplies current speed. Non-finite or non-positive
     * values are rejected so a NaN upstream computation (bpm 0, empty
     * input) can never install a zero or NaN loop duration.
     */
    setBaseLoopDuration(seconds) {
        const s = toFiniteNumber(seconds)
        if (s === null || s <= 0) return
        this.loopDuration = s
        this.setSpeed(this._speed)
    }

    syncTimeOrigin(originMs) {
        const ms = toFiniteNumber(originMs)
        if (ms === null) return
        this._renderer._loopStartTime = ms
    }

    /**
     * Ensure renderer has an audioState bag, returning it so the shared
     * audio manager can write FFT bands into it.
     */
    ensureAudioState() {
        if (typeof this._renderer.setAudioState === 'function') {
            return this._renderer.setAudioState()
        }
        return this._renderer._audioState || null
    }

    /**
     * Ensure renderer has a midiState bag, returning it.
     */
    ensureMidiState() {
        if (typeof this._renderer.setMidiState === 'function') {
            return this._renderer.setMidiState()
        }
        return this._renderer._midiState || null
    }

    /**
     * Runtime audio-input requirements of the compiled program (the same
     * view the shared runtime's capture manager consumes), or null when the
     * renderer has no pipeline yet.
     */
    audioRequirements() {
        return this._renderer?.pipeline?.getAudioInputRequirements?.() ?? null
    }

    resize(width, height) {
        const w = toFiniteNumber(width)
        const h = toFiniteNumber(height)
        if (w === null || h === null) return
        this.width = w
        this.height = h
        const bufW = Math.max(1, Math.round(w * this._pixelDensity))
        const bufH = Math.max(1, Math.round(h * this._pixelDensity))
        this.canvas.width = bufW
        this.canvas.height = bufH
        this._renderer.resize(bufW, bufH)
        this._rebindImages()
    }

    _rebindImages() {
        this._imageTools?.bindMediaImages(this._renderer, this._currentDsl, this.images, { extractEffectsFromDsl, resolveImage: this.resolveImage }).catch(this.onError)
    }

    dispose() {
        if (this._disposed) return
        this._disposed = true
        ++this._loadVersion
        this.stop()
        if (this._renderer.dispose) this._renderer.dispose()
    }

    /**
     * Clear all global o0..oN surface textures to transparent black.
     * Resets persistent state for stateful effects (reaction-diffusion,
     * MNCA, cellular automata, feedback loops) that ping-pong through
     * the named global textures. No-op for programs that regenerate
     * o0..oN from scratch every frame.
     *
     * The runtime's recompile() deliberately preserves these surfaces
     * across recompiles, so rebind + load paths call this explicitly
     * when they want a fresh seed instead of continuing the simulation.
     *
     * Robust across engine revisions: a surfaces registry that is a Map,
     * a keyed collection with .keys(), or missing entirely must never
     * throw here — clearSurfaces() runs inside the load path, and an
     * unexpected shape would otherwise abort a successful program load
     * mid-set.
     */
    clearSurfaces() {
        const pipeline = this._renderer?._pipeline
        if (!pipeline || typeof pipeline.clearSurface !== 'function') return
        const surfaces = pipeline.surfaces
        let names = null
        if (surfaces instanceof Map) names = [...surfaces.keys()]
        else if (Array.isArray(surfaces)) names = surfaces
        else if (surfaces && typeof surfaces.keys === 'function') names = [...surfaces.keys()]
        if (!names) return
        for (const name of names) {
            try {
                pipeline.clearSurface(name)
            } catch (err) {
                console.warn(`[${this.id}] clearSurface(${name}) failed`, err)
            }
        }
    }

    /**
     * Some shader DSLs declare colors as hex strings; the WebGL uniform
     * setter expects vec3 floats. Walk the compiled passes and coerce.
     */
    _normalizeColorUniforms() {
        const passes = this._renderer._pipeline?.graph?.passes
        if (!passes) return
        for (const pass of passes) {
            if (!pass.uniforms) continue
            for (const [name, value] of Object.entries(pass.uniforms)) {
                if (typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value)) {
                    pass.uniforms[name] = hexToRgb(value)
                }
            }
        }
    }
}
