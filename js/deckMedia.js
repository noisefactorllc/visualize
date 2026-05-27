// SPDX-License-Identifier: MIT
/**
 * DeckMedia — drives the synth/media effect's imageTex uniform from a
 * camera stream or a local file (image / video).
 *
 * The util programs "Camera Input" and "Media Input" both compile to
 *
 *     search synth
 *     media().write(o0)
 *     render(o0)
 *
 * Same DSL, different source — DeckMedia is what tells the renderer
 * which pixels to upload into that media() call's imageTex texture.
 *
 * Reuses the same updateTextureFromSource pattern the mixer uses to
 * pull deck canvases into its imageTex inputs (see js/mixer.js); the
 * call is cheap to repeat per frame on a stable source.
 */

import { extractEffectsFromDsl } from './noisemaker/bundle.js'

// The bundle resolves `media()` (with `search synth`) to "synth.media".
// Some other call sites in the noisemaker code use "synth/media"; we
// accept either to be defensive against future bundle changes.
const MEDIA_EFFECT_KEYS = new Set(['synth.media', 'synth/media'])

export class DeckMedia {
    constructor({ deck }) {
        this.deck = deck
        this._source = null         // 'camera' | 'file' | null
        this._label = ''            // device label or file name
        this._cameraDeviceId = ''   // settled deviceId of the live camera
        this._video = null          // <video>
        this._img = null            // <img>
        this._stream = null         // MediaStream
        this._mediaStepIndex = null // discovered from compiled pipeline
    }

    get active() { return this._source }
    get currentLabel() { return this._label }
    /** Best-effort deviceId of the currently-running camera. Empty
     *  when no camera is active or the browser didn't report one. */
    get currentCameraDeviceId() { return this._cameraDeviceId }

    /** True if the deck is currently running a program with media(). */
    isMediaProgram() {
        return this._discoverMediaStep() != null
    }

    /** Walk the deck's compiled pipeline to find the synth/media step
     *  index. Returns null if no media() in the current DSL. */
    _discoverMediaStep() {
        const dsl = this.deck._currentDsl
        if (!dsl) return null
        try {
            const effects = extractEffectsFromDsl(dsl) || []
            for (const e of effects) {
                if (MEDIA_EFFECT_KEYS.has(e.effectKey)) return e.stepIndex
            }
        } catch { /* ignore */ }
        return null
    }

    async listCameras() {
        if (!navigator.mediaDevices?.enumerateDevices) return []
        try {
            const devs = await navigator.mediaDevices.enumerateDevices()
            return devs.filter(d => d.kind === 'videoinput')
        } catch (err) {
            console.warn('[DeckMedia] enumerateDevices failed', err)
            return []
        }
    }

    async setCamera(deviceId = '') {
        this._stopStream()
        const constraints = {
            video: deviceId ? { deviceId: { exact: deviceId } } : true,
            audio: false
        }
        let stream
        try {
            stream = await navigator.mediaDevices.getUserMedia(constraints)
        } catch (err) {
            throw new Error(`camera access failed: ${err?.message || err.name}`)
        }
        const track = stream.getVideoTracks()[0]
        this._stream = stream
        this._label = track?.label || 'camera'
        // After getUserMedia, the track settles to a real deviceId
        // even when called with no constraint — use that so the UI
        // can re-select the active device after the next refresh.
        this._cameraDeviceId = track?.getSettings?.().deviceId || deviceId || ''
        this._ensureVideo()
        this._video.srcObject = stream
        await this._video.play().catch(() => { /* autoplay may need retry */ })
        this._source = 'camera'
        this._img = null
    }

    async setFile(file) {
        if (!file) return
        this._stopStream()
        const url = URL.createObjectURL(file)
        this._label = file.name
        if (file.type.startsWith('video/')) {
            this._ensureVideo()
            this._video.src = url
            this._video.loop = true
            await this._video.play().catch(() => {})
            this._img = null
        } else {
            this._ensureImg()
            this._img.src = url
            this._video = null
        }
        this._source = 'file'
    }

    /** Stop the camera stream + clear any video src. Idempotent. */
    stop() {
        this._stopStream()
        if (this._video) this._video.src = ''
        if (this._img) this._img.src = ''
        this._source = null
        this._label = ''
        this._cameraDeviceId = ''
    }

    /** Push the current source into the renderer. Cheap to call per
     *  frame; safe to call when there's no source — it just no-ops. */
    tick() {
        const step = this._discoverMediaStep()
        if (step == null) return
        const src = this._video?.readyState >= 2 ? this._video
                  : this._img?.complete ? this._img : null
        if (!src) return
        try {
            this.deck._renderer.updateTextureFromSource?.(
                `imageTex_step_${step}`, src, { flipY: false }
            )
            // The synth/media shader samples its texture via
            //   st = gl_FragCoord.xy / imageSize
            // so imageSize must match the canvas the shader writes
            // into — otherwise the texture lands in a fixed patch
            // sized by the manifest default and the rest reads
            // bgColor. Same trick mixer.js does for its deck-canvas
            // inputs. Read from `canvas.width/height` (the deck's
            // actual render-buffer size including pixel density)
            // since the bundled CanvasRenderer doesn't expose
            // public width/height getters. Cache to avoid uniform
            // churn between frames.
            const w = this.deck.canvas.width
            const h = this.deck.canvas.height
            if (w > 0 && h > 0 && (this._lastImageW !== w || this._lastImageH !== h || this._lastImageStep !== step)) {
                this.deck._renderer.applyStepParameterValues?.({
                    [`step_${step}`]: { imageSize: [w, h] }
                })
                this._lastImageW = w
                this._lastImageH = h
                this._lastImageStep = step
            }
        } catch { /* mid-recompile */ }
    }

    _stopStream() {
        if (this._stream) {
            for (const t of this._stream.getTracks()) {
                try { t.stop() } catch { /* ignore */ }
            }
            this._stream = null
        }
    }

    _ensureVideo() {
        if (!this._video) {
            const v = document.createElement('video')
            v.autoplay = true
            v.playsInline = true
            v.muted = true
            v.crossOrigin = 'anonymous'
            v.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;'
            document.body.appendChild(v)
            this._video = v
        }
    }

    _ensureImg() {
        if (!this._img) {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            this._img = img
        }
    }
}
