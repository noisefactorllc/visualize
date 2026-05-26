/**
 * MainCompositor — owns the main canvas and blends deck A and deck B
 * into it every frame using a configurable crossfade curve.
 *
 * Both deck canvases are real DOM <canvas> elements rendered by their
 * own CanvasRenderer; we sample them with drawImage(). This is cheaper
 * than running a third GPU pipeline and means the main stays just a
 * 2D context the recorder / fullscreen logic can hand off freely.
 *
 * FX (strobe/invert/B&W/flash/zoom/freeze) are applied as either CSS
 * filters on the canvas element (invert/bw) or as fillRect/composite
 * operations during the draw (strobe/flash). The freeze state simply
 * stops the redraw loop so the last frame stays on screen.
 */

const XFADE_CURVES = {
    linear: (x) => x,
    sharp: (x) => x < 0.5 ? x * x * 2 : 1 - (1 - x) * (1 - x) * 2,
    dipped: (x) => {
        // Equal-power: ensures combined energy doesn't dip in the middle
        const a = Math.cos(x * Math.PI / 2)
        const b = Math.cos((1 - x) * Math.PI / 2)
        return { a, b, equalPower: true }
    },
    cut: (x) => x < 0.5 ? 0 : 1
}

export class MainCompositor {
    constructor(canvas, deckA, deckB, options = {}) {
        this.canvas = canvas
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
        this.deckA = deckA
        this.deckB = deckB
        // Optional: a MixerRenderer whose canvas already holds a blended
        // A+B frame. When present, we drawImage from that single canvas
        // instead of compositing the deck canvases ourselves. Falls back
        // to the equal-power 2D xfade if absent (used during boot before
        // the mixer is online, and as a safety net if the mixer pipeline
        // fails to compile).
        this.mixer = options.mixer || null
        this.width = options.width || 1280
        this.height = options.height || 720
        this.canvas.width = this.width
        this.canvas.height = this.height

        this._xfade = 0           // 0 = full A, 1 = full B
        this._curve = 'dipped'
        this._rafId = null
        this._running = false

        // FX state
        this._flashAlpha = 0      // momentary white flash, decays per frame
        this._strobeActive = false
        this._strobeOnUntilMs = 0 // strobe stays "on" until this timestamp
        this._strobeDurMs = 40    // duration of each strobe flash
        this._invert = false
        this._bw = false
        this._zoomActive = false
        this._freeze = false

        this._onFrame = null

        // Track last frame stats for FPS UI
        this._lastFrameMs = performance.now()
        this._frameCount = 0
        this._fps = 0
    }

    setCrossfade(value01) {
        this._xfade = Math.max(0, Math.min(1, value01))
        // Mirror the (curved) value into the mixer so its driver param
        // tracks the slider live. Use the same curve so a 'dipped' curve
        // still feels equal-power even through a shader mixer.
        if (this.mixer) {
            this.mixer.setMix(this._effectiveXfade())
        }
    }

    /** Bind a MixerRenderer late (post-boot, once it's initialized). */
    setMixer(mixer) {
        this.mixer = mixer || null
        if (this.mixer) this.mixer.setMix(this._effectiveXfade())
    }

    /** Apply the active curve to the raw xfade and return a scalar. */
    _effectiveXfade() {
        const curved = XFADE_CURVES[this._curve](this._xfade)
        // dipped returns {a,b,equalPower}; convert to mix-equivalent so
        // the mixer's mix param has a sensible 0..1 reading. Use the
        // B-share directly as the scalar (matches what alphaB would be).
        if (typeof curved === 'object' && curved.equalPower) return curved.b
        return curved
    }

    get crossfade() { return this._xfade }

    setCurve(name) {
        if (XFADE_CURVES[name]) this._curve = name
    }

    onFrame(cb) { this._onFrame = cb }

    /** Resize the main canvas. */
    resize(width, height) {
        this.width = width
        this.height = height
        this.canvas.width = width
        this.canvas.height = height
    }

    start() {
        if (this._running) return
        this._running = true
        const tick = () => {
            if (!this._running) return
            if (!this._freeze) this._draw()
            this._tickFps()
            this._rafId = requestAnimationFrame(tick)
        }
        tick()
    }

    stop() {
        this._running = false
        if (this._rafId) cancelAnimationFrame(this._rafId)
        this._rafId = null
    }

    get fps() { return this._fps }

    _tickFps() {
        this._frameCount++
        const now = performance.now()
        const dt = now - this._lastFrameMs
        if (dt >= 1000) {
            this._fps = Math.round(this._frameCount * 1000 / dt)
            this._frameCount = 0
            this._lastFrameMs = now
        }
    }

    _draw() {
        const ctx = this.ctx
        const w = this.width
        const h = this.height

        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)

        // Mixer path: a MixerRenderer (third noisemaker pipeline) has
        // already blended deck A and deck B via the user-selected mixer
        // effect, so the compositor just blits the result. The `ready`
        // flag gates the swap-over — the mixer's output canvas has
        // non-zero dimensions the moment we create it, but is *blank*
        // until init + compile + first-frame-upload all land. Until
        // then we keep the 2D equal-power crossfade alive so the main
        // canvas never goes black during the boot handoff.
        if (this.mixer?.ready) {
            ctx.drawImage(this.mixer.canvas, 0, 0, w, h)
        } else {
            const result = XFADE_CURVES[this._curve](this._xfade)
            let alphaA, alphaB
            if (typeof result === 'object' && result.equalPower) {
                alphaA = result.a
                alphaB = result.b
            } else {
                const t = result
                alphaA = 1 - t
                alphaB = t
            }

            if (alphaA > 0.001 && this.deckA?.canvas?.width > 0 && this.deckA.canvas.height > 0) {
                ctx.globalAlpha = alphaA
                ctx.drawImage(this.deckA.canvas, 0, 0, w, h)
            }
            if (alphaB > 0.001 && this.deckB?.canvas?.width > 0 && this.deckB.canvas.height > 0) {
                ctx.globalAlpha = alphaB
                ctx.globalCompositeOperation = 'lighter'
                ctx.drawImage(this.deckB.canvas, 0, 0, w, h)
                ctx.globalCompositeOperation = 'source-over'
            }
            ctx.globalAlpha = 1
        }

        // Strobe: fires on each beat tick (see strobeBlink()) and stays
        // visible for _strobeDurMs. Frame-rate independent, so a 120-BPM
        // strobe is exactly 2 Hz regardless of whether we render at 30
        // or 144 fps.
        if (this._strobeActive && performance.now() < this._strobeOnUntilMs) {
            ctx.fillStyle = 'rgba(255,255,255,0.95)'
            ctx.fillRect(0, 0, w, h)
        }

        // One-shot flash (decays over a few frames)
        if (this._flashAlpha > 0.01) {
            ctx.fillStyle = `rgba(255,255,255,${this._flashAlpha})`
            ctx.fillRect(0, 0, w, h)
            this._flashAlpha *= 0.78
        }

        if (this._onFrame) this._onFrame()
    }

    // ── FX controls ───────────────────────────────────────────────────────
    flash() {
        this._flashAlpha = 1
    }

    setStrobe(active) {
        this._strobeActive = !!active
        this._strobeOnUntilMs = 0
    }

    /**
     * Trigger one strobe flash. Called per beat by the app so the
     * strobe rate is exactly the BPM (PSE-safe at typical tempos: a
     * 1/8th-note strobe at 180 BPM is 6 Hz, well below the 3 Hz/8 Hz
     * danger zone but reasonable to use; users should still be warned).
     * The flash fades over _strobeDurMs (default 40ms) so the main
     * looks like a real strobe rather than a steady white block.
     */
    strobeBlink() {
        if (!this._strobeActive) {
            // When strobe FX is off, treat as a single one-shot flash
            this._flashAlpha = 0.9
            return
        }
        this._strobeOnUntilMs = performance.now() + this._strobeDurMs
    }

    setInvert(active) {
        this._invert = !!active
        this.canvas.classList.toggle('invert', this._invert)
    }

    setBW(active) {
        this._bw = !!active
        this.canvas.classList.toggle('bw', this._bw)
    }

    setZoom(active) {
        this._zoomActive = !!active
        this.canvas.parentElement?.classList.toggle('zoomed', this._zoomActive)
    }

    setFreeze(active) {
        this._freeze = !!active
    }

    get freeze() { return this._freeze }
    get invert() { return this._invert }
    get bw() { return this._bw }
    get zoom() { return this._zoomActive }
    get strobe() { return this._strobeActive }
}
