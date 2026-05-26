// SPDX-License-Identifier: MIT
/**
 * MixerRenderer — a third noisemaker pipeline that blends deck A and
 * deck B through any of the noisemaker mixer/* effects.
 *
 * Architecture:
 *   - Two synth/media starter effects with no source pull deck A's
 *     and deck B's HTMLCanvasElement contents into surfaces o0 + o1
 *     via per-frame updateTextureFromSource() calls.
 *   - The chosen mixer effect reads o0, takes o1 as `tex`, writes o2.
 *   - render(o2) drives the renderer's output canvas.
 *
 * The CanvasRenderer's loop runs independently from the deck loops;
 * each MixerRenderer frame uploads whatever the deck canvases currently
 * have. The decks remain fully independent (per-deck speed, audio,
 * editor, etc.) — only their final pixel buffers feed the mixer.
 *
 * Why a separate file from compositor.js: the compositor still owns the
 * main canvas, FX overlays (strobe/flash/invert/B&W/freeze), and the
 * 2D drawImage path the recorder taps. The mixer is one stage upstream
 * of that — it produces a "pre-FX" blended frame that the compositor
 * then draws onto the main canvas.
 */

import { CanvasRenderer, CDN_BASE } from './noisemaker/bundle.js'
import { MIXERS, getMixer, DEFAULT_MIXER_ID, buildDslArgs } from './mixers.js'

export { MIXERS, DEFAULT_MIXER_ID, getMixer } from './mixers.js'

const MIX_W = 1280
const MIX_H = 720

export class MixerRenderer {
    constructor({ width = MIX_W, height = MIX_H } = {}) {
        this.width = width
        this.height = height

        // Hidden canvas — the compositor reads from it via drawImage.
        this.canvas = document.createElement('canvas')
        this.canvas.width = width
        this.canvas.height = height
        this.canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;'
        document.body.appendChild(this.canvas)

        this.renderer = new CanvasRenderer({
            canvas: this.canvas,
            width, height,
            basePath: CDN_BASE,
            useBundles: true,
            bundlePath: `${CDN_BASE}/effects`,
            onError: (err) => console.warn('[mixer]', err?.message || err),
        })

        this._initialized = false
        this._currentMixerId = DEFAULT_MIXER_ID
        this._currentXfade = 0
        this._currentOverrides = {}
        this._deckACanvas = null
        this._deckBCanvas = null
        this._rafId = null
        this._loadedMixerIds = new Set()

        // Step indices of the two synth/media effects in the compiled
        // pipeline + the mixer effect itself. `write()` calls bump step
        // indices too, so the layout isn't 0/1/2 — it's whatever the
        // compiler assigns. Re-derived after every _recompile().
        this._mediaStepA = null
        this._mediaStepB = null
        this._mixerStep = null
    }

    /** All available mixer descriptors — exposed for the UI picker. */
    get mixers() { return MIXERS }

    /** Currently selected mixer descriptor. */
    get currentMixer() { return getMixer(this._currentMixerId) }

    /**
     * True once the pipeline has compiled at least once AND the rAF
     * tick has uploaded a real frame from the deck canvases. Before
     * this is true the mixer's output canvas is still blank (just
     * cleared by the WebGL context) so the compositor must keep using
     * the 2D fallback rather than blit nothingness.
     */
    get ready() { return this._initialized && this._uploadedAtLeastOnce }

    /** Load the manifest + media effect + the default mixer effect. */
    async init() {
        if (this._initialized) return
        await this.renderer.loadManifest()
        await this.renderer.loadEffects(['synth/media', DEFAULT_MIXER_ID])
        this._loadedMixerIds.add(DEFAULT_MIXER_ID)
        await this._recompile()
        this._initialized = true
        this._uploadedAtLeastOnce = false
    }

    /** Hand off the two deck canvases that should feed the mixer. */
    bindDecks(deckACanvas, deckBCanvas) {
        this._deckACanvas = deckACanvas
        this._deckBCanvas = deckBCanvas
    }

    /**
     * Swap to a different noisemaker mixer effect. Loads the effect
     * bundle on first use, then recompiles the pipeline.
     */
    async setMixerEffect(id, overrides = {}) {
        const mixer = getMixer(id)
        if (!mixer) return
        this._currentMixerId = mixer.id
        this._currentOverrides = overrides
        if (!this._loadedMixerIds.has(mixer.id)) {
            await this.renderer.loadEffects([mixer.id])
            this._loadedMixerIds.add(mixer.id)
        }
        await this._recompile()
    }

    /**
     * Update a single override (e.g. from the mixer-controls panel)
     * and schedule a recompile so the new value flows into the
     * compiled DSL. Cheap relative to setMixerEffect() since the
     * effect bundle is already loaded.
     */
    setOverride(paramName, value) {
        this._currentOverrides = { ...this._currentOverrides, [paramName]: value }
        this._scheduleRecompile()
    }

    /** Read the active value of a non-driver parameter (override or default). */
    getOverride(paramName) {
        if (paramName in this._currentOverrides) return this._currentOverrides[paramName]
        return this.currentMixer.defaults?.[paramName]
    }

    /** Set the crossfader value [0,1]; uses fast-path uniform write when
     *  available, falls back to debounced recompile. */
    setMix(xfade) {
        this._currentXfade = Math.max(0, Math.min(1, xfade))
        if (!this._tryFastPathSetMix(this._currentXfade)) {
            this._scheduleRecompile()
        }
    }

    _tryFastPathSetMix(xfade) {
        const mixer = this.currentMixer
        const renderer = this.renderer
        if (!renderer || !mixer) return false
        if (this._mixerStep == null) return false
        if (typeof renderer.applyStepParameterValues !== 'function') return false
        try {
            const stepKey = `step_${this._mixerStep}`
            const driver = mixer.driver
            const value = this._driverValue(mixer, xfade)
            renderer.applyStepParameterValues({ [stepKey]: { [driver]: value } })
            return true
        } catch (err) {
            console.warn('[mixer] fast-path setMix failed:', err?.message || err)
            return false
        }
    }

    _driverValue(mixer, xfade) {
        // Map xfade∈[0,1] into the driver param's natural range. The
        // recompile path uses these via dslArgs(); the fast-path
        // setMix() must produce the SAME number or the slider jumps
        // when a real recompile next fires.
        const [lo, hi] = mixer.driverRange || [0, 1]
        return lo + (hi - lo) * xfade
    }

    _scheduleRecompile() {
        if (this._recompilePending) return
        this._recompilePending = true
        setTimeout(() => {
            this._recompilePending = false
            this._recompile().catch(() => {})
        }, 60)
    }

    async _recompile() {
        const mixer = this.currentMixer
        const args = buildDslArgs(mixer, this._currentXfade, this._currentOverrides)
        const dsl = [
            `search synth, mixer, render`,
            `media().write(o0)`,
            `media().write(o1)`,
            `read(o0).${effectShortName(mixer.id)}(${args}).write(o2)`,
            `render(o2)`,
        ].join('\n')
        try {
            await this.renderer.compile(dsl)
        } catch (err) {
            console.warn('[mixer] compile failed:', err?.message || err?.error || err)
            return
        }
        this._refreshStepIndices()
        // The new pipeline has fresh media steps with no imageSize set
        // — must push it again on the next frame, even if the deck
        // buffer dimensions haven't changed. Clear the cache so the
        // dirty check in _setImageSize doesn't silently no-op.
        this._lastImageSize = {}
        if (!this.renderer.isRunning) this.renderer.start()
    }

    /**
     * Walk the freshly-compiled pipeline and pull the stepIndex of each
     * synth/media effect (writes-to-o0 = deckA, writes-to-o1 = deckB)
     * plus the stepIndex of the mixer itself. `write()` calls count as
     * steps too so the layout isn't 0/1/2 — it's 0/1/2/3/4/5 in our
     * 5-line DSL, but the compiler may renumber. Trust the pipeline.
     */
    _refreshStepIndices() {
        this._mediaStepA = null
        this._mediaStepB = null
        this._mixerStep = null
        const pipeline = this.renderer._pipeline
        const passes = pipeline?.graph?.passes || []
        const mediaSteps = []
        let mixerStep = null
        for (const p of passes) {
            // synth/media writes a fragColor with `imageTex` as input
            if (p.inputs && Object.prototype.hasOwnProperty.call(p.inputs, 'imageTex')) {
                mediaSteps.push(p.stepIndex)
            }
            // Mixer step is the one with both inputTex AND tex
            if (p.inputs && 'inputTex' in p.inputs && 'tex' in p.inputs) {
                mixerStep = p.stepIndex
            }
        }
        // In order: first media writes to o0 (deck A); second to o1 (deck B).
        this._mediaStepA = mediaSteps[0] ?? null
        this._mediaStepB = mediaSteps[1] ?? null
        this._mixerStep = mixerStep
    }

    /**
     * Start the per-frame loop that uploads the deck canvases as the
     * mixer's input textures. Without this the textures stay frozen at
     * whatever they had on first compile.
     */
    start() {
        if (this._rafId) return
        const tick = () => {
            this._uploadDeckFrames()
            this._rafId = requestAnimationFrame(tick)
        }
        tick()
    }

    stop() {
        if (this._rafId) cancelAnimationFrame(this._rafId)
        this._rafId = null
        if (this.renderer.isRunning) this.renderer.stop()
    }

    _uploadDeckFrames() {
        if (!this._initialized) return
        if (this._mediaStepA == null || this._mediaStepB == null) return
        let uploadedA = false
        let uploadedB = false
        try {
            // imageSize must match the mixer's *output* resolution, not
            // the deck's buffer dimensions: the media shader uses
            //   st = gl_FragCoord.xy / imageSize
            // for its UV lookup, so size = output makes st sweep 0..1
            // across the canvas and the texture fills the frame. If
            // imageSize is smaller than output (e.g. a 50%-density deck
            // buffer of 640×360), the shader rejects fragCoords outside
            // [0,imageSize] and the right + bottom of the output stays
            // bgColor (black) — which is exactly the aspect-bug the
            // user was seeing after each mixer swap.
            if (this._deckACanvas?.width > 0 && this._deckACanvas.height > 0) {
                this.renderer.updateTextureFromSource(
                    `imageTex_step_${this._mediaStepA}`,
                    this._deckACanvas,
                    { flipY: false }
                )
                this._setImageSize(this._mediaStepA, this.width, this.height)
                uploadedA = true
            }
            if (this._deckBCanvas?.width > 0 && this._deckBCanvas.height > 0) {
                this.renderer.updateTextureFromSource(
                    `imageTex_step_${this._mediaStepB}`,
                    this._deckBCanvas,
                    { flipY: false }
                )
                this._setImageSize(this._mediaStepB, this.width, this.height)
                uploadedB = true
            }
        } catch (err) {
            // Pipeline mid-recompile — skip this frame, try again next.
        }
        if (uploadedA && uploadedB) this._uploadedAtLeastOnce = true
    }

    /**
     * Push imageSize into the media step's uniforms. The synth/media
     * shader uses imageSize for its aspect-ratio + crop math; without
     * this the input texture renders stretched (most visibly when the
     * deck buffer is at non-default resolution, e.g. 640×360 from
     * auto-step-down pixel density). Skips the write when the size
     * hasn't changed since last frame to avoid uniform churn.
     */
    _setImageSize(stepIndex, w, h) {
        const cache = (this._lastImageSize ||= {})
        if (cache[stepIndex] && cache[stepIndex][0] === w && cache[stepIndex][1] === h) return
        cache[stepIndex] = [w, h]
        try {
            this.renderer.applyStepParameterValues?.({
                [`step_${stepIndex}`]: { imageSize: [w, h] }
            })
        } catch {}
    }

    resize(width, height) {
        if (width === this.width && height === this.height) return
        this.width = width
        this.height = height
        this.canvas.width = width
        this.canvas.height = height
        this.renderer.resize(width, height)
    }
}

/** Strip namespace, return the bare effect name used in DSL chain calls. */
function effectShortName(id) {
    const slash = id.lastIndexOf('/')
    return slash < 0 ? id : id.slice(slash + 1)
}
