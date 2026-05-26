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
 * It intentionally doesn't handle text/media textures (Polymorphic does);
 * the curated Visualize library uses synth + filter effects only so we can
 * keep the deck small.
 */

import {
    CanvasRenderer,
    CDN_BASE,
    extractEffectNamesFromDsl
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
        this._currentDsl = ''
        this._currentName = ''
        this._speed = 1
        this._pixelDensity = 1.0    // 1.0 = full mainRes; 0.5 = half-res buffer upscaled
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
        const clamped = Math.max(0.1, Math.min(1.0, density))
        if (clamped === this._pixelDensity) return
        this._pixelDensity = clamped
        const bufW = Math.max(1, Math.round(this.width * clamped))
        const bufH = Math.max(1, Math.round(this.height * clamped))
        this.canvas.width = bufW
        this.canvas.height = bufH
        this._renderer.resize(bufW, bufH)
    }

    get inner() { return this._renderer }
    get isRunning() { return !!this._renderer.isRunning }
    get currentFPS() { return this._renderer.currentFPS || 0 }
    get currentName() { return this._currentName }
    get currentDsl() { return this._currentDsl }
    get backend() {
        const b = this._renderer.backend
        return b === 'wgsl' ? 'webgpu' : (b || 'webgl2')
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
     * Compile and run a DSL program. On error, keeps the previous program
     * running and surfaces the message to the caller.
     */
    async load(dsl, name = '') {
        if (!this._initialized) await this.init()

        try {
            const effectData = extractEffectNamesFromDsl(dsl, this._renderer.manifest || {})
            const effectIds = effectData.map(e => e.effectId)
            if (effectIds.length > 0) {
                await this._renderer.loadEffects(effectIds)
            }
            await this._renderer.compile(dsl)
            this._currentDsl = dsl
            this._currentName = name
            this._normalizeColorUniforms()
            if (!this._renderer.isRunning) this._renderer.start()
            return { success: true }
        } catch (err) {
            const msg = typeof err === 'string' ? err
                : err?.message || err?.error || 'Unknown compile error'
            console.error(`[${this.id}] load error:`, err)
            return { success: false, error: msg }
        }
    }

    /**
     * Set effective playback speed by adjusting loop duration.
     * speed > 1 = faster (shorter loop), < 1 = slower.
     */
    setSpeed(speed) {
        this._speed = Math.max(0.05, speed)
        const dur = this.loopDuration / this._speed
        this._renderer.setLoopDuration(dur)
    }

    /**
     * Replace the base loop duration (e.g. when user changes "loop duration"
     * in settings). Reapplies current speed.
     */
    setBaseLoopDuration(seconds) {
        this.loopDuration = seconds
        this.setSpeed(this._speed)
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

    resize(width, height) {
        this.width = width
        this.height = height
        const bufW = Math.max(1, Math.round(width * this._pixelDensity))
        const bufH = Math.max(1, Math.round(height * this._pixelDensity))
        this.canvas.width = bufW
        this.canvas.height = bufH
        this._renderer.resize(bufW, bufH)
    }

    dispose() {
        this.stop()
        if (this._renderer.dispose) this._renderer.dispose()
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
