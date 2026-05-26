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
import { MIXERS, getMixer, DEFAULT_MIXER_ID } from './mixers.js'

export { MIXERS, DEFAULT_MIXER_ID } from './mixers.js'

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
    }

    /** All available mixer descriptors — exposed for the UI picker. */
    get mixers() { return MIXERS }

    /** Currently selected mixer descriptor. */
    get currentMixer() { return getMixer(this._currentMixerId) }

    /** Load the manifest + media effect + the default mixer effect. */
    async init() {
        if (this._initialized) return
        await this.renderer.loadManifest()
        await this.renderer.loadEffects(['synth/media', DEFAULT_MIXER_ID])
        this._loadedMixerIds.add(DEFAULT_MIXER_ID)
        await this._recompile()
        this._initialized = true
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

    /** Set the crossfader value [0,1]; cheap, no recompile. */
    setMix(xfade) {
        this._currentXfade = Math.max(0, Math.min(1, xfade))
        // Hot-path: the cheapest mixers expose a single scalar uniform
        // for the driver param. Recompile is overkill for that — instead
        // we patch the uniform directly via the renderer's ProgramState.
        // (Falls through to recompile if the mixer doesn't fit the cheap
        // pattern; that's still fine, just slower.)
        if (!this._tryFastPathSetMix(this._currentXfade)) {
            // Recompile is genuinely needed (params that fold into the
            // DSL, like `mode: multiply`). Debounce so we don't recompile
            // 60×/second when a MIDI knob is wiggling.
            this._scheduleRecompile()
        }
    }

    _tryFastPathSetMix(xfade) {
        const mixer = this.currentMixer
        const pipeline = this.renderer._pipeline
        if (!pipeline || !mixer) return false
        try {
            // The mixer is the third step (after the two media inputs).
            // ProgramState keys effect values by `step_<index>`.
            const stepKey = 'step_2'
            const driver = mixer.driver
            const value = this._driverValue(mixer, xfade)
            if (typeof pipeline._programState?.setValue !== 'function') return false
            pipeline._programState.setValue(stepKey, driver, value)
            return true
        } catch {
            return false
        }
    }

    _driverValue(mixer, xfade) {
        // Mirror the dsl-driver mappings in mixers.js so the fast-path
        // patches the *same* value the recompile path would.
        switch (mixer.id) {
            case 'mixer/blendMode':
            case 'mixer/alphaMask':
            case 'mixer/applyMode':
            case 'mixer/centerMask':
                return xfade
            case 'mixer/split':
                return xfade
            case 'mixer/patternMix':
                return xfade
            case 'mixer/shapeMask':
                return xfade * 0.9
            case 'mixer/cellSplit':
                return 0.001 + (0.5 - 0.001) * xfade
            default:
                return xfade
        }
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
        const args = mixer.dslArgs(this._currentXfade, this._currentOverrides)
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
        if (!this.renderer.isRunning) this.renderer.start()
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
        if (!this._initialized || !this._deckACanvas || !this._deckBCanvas) return
        try {
            if (this._deckACanvas.width > 0 && this._deckACanvas.height > 0) {
                this.renderer.updateTextureFromSource('imageTex_step_0', this._deckACanvas, { flipY: false })
            }
            if (this._deckBCanvas.width > 0 && this._deckBCanvas.height > 0) {
                this.renderer.updateTextureFromSource('imageTex_step_1', this._deckBCanvas, { flipY: false })
            }
        } catch (err) {
            // Pipeline mid-recompile — skip this frame, try again next.
        }
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
