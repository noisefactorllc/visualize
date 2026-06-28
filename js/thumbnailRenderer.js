// SPDX-License-Identifier: MIT
/**
 * Offscreen single-frame renderer for library tile thumbnails.
 *
 * Maintains one dedicated Deck instance on a hidden 240×135 canvas.
 * `render(dsl)` returns a Promise<Blob|null> of a WebP capture taken
 * after the program has had a few hundred ms to settle into its loop —
 * the very first frame is usually blank/black before the renderer
 * accumulates any pattern.
 *
 * Single-flight queue: only one render in progress at a time. Multiple
 * concurrent `render()` calls serialize. This keeps GPU contention low
 * and stops the live decks from stalling while the library populates.
 *
 * Cancellation: callers don't get to cancel — the queue drains in FIFO
 * order. If the library is scrolled past a card before its thumb has
 * rendered, that's fine; the card is observed again when scrolled back
 * and the cache lookup that fired first time around will now hit.
 */

import { Deck } from './noisemaker/deck.js'

const THUMB_W = 240
const THUMB_H = 135
const SETTLE_MS = 300           // let the shader develop a frame (~18 frames at 60fps)
const WEBP_QUALITY = 0.78

let _instance = null

class ThumbnailRenderer {
    constructor() {
        this.canvas = document.createElement('canvas')
        this.canvas.width = THUMB_W
        this.canvas.height = THUMB_H
        this.canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;'
        document.body.appendChild(this.canvas)

        this.deck = new Deck(this.canvas, {
            id: 'thumb',
            width: THUMB_W,
            height: THUMB_H,
            loopDuration: 4,
            // Always WebGL2: the user's renderer preference is a hint for
            // the live decks, not this offscreen one-frame renderer.
            preferWebGPU: false,
            onError: () => {},      // swallow — caller handles null result
        })

        this._queue = []
        this._busy = false
        this._initPromise = null
    }

    async _ensureInit() {
        if (!this._initPromise) this._initPromise = this.deck.init()
        return this._initPromise
    }

    /**
     * Render a single frame of `dsl` and resolve with a WebP Blob. On
     * compile error or any other failure, resolves with null (callers
     * fall back to showing the program-card without a thumb).
     */
    render(dsl) {
        return new Promise((resolve) => {
            this._queue.push({ dsl, resolve })
            this._drain()
        })
    }

    async _drain() {
        if (this._busy) return
        const job = this._queue.shift()
        if (!job) return
        this._busy = true
        try {
            await this._ensureInit()
            const res = await this.deck.load(job.dsl, 'thumb')
            if (!res.success) {
                job.resolve(null)
                return
            }
            // Let the renderer paint a few frames before capture.
            await new Promise(r => setTimeout(r, SETTLE_MS))
            const blob = await new Promise((r) => {
                this.canvas.toBlob(b => r(b), 'image/webp', WEBP_QUALITY)
            })
            job.resolve(blob)
        } catch (err) {
            console.warn('[thumb] render failed:', err?.message || err)
            job.resolve(null)
        } finally {
            this._busy = false
            // Stop the offscreen deck's render loop between jobs. Deck.load()
            // starts a persistent rAF loop that nothing else stops, so without
            // this the thumb deck keeps re-rendering the last program forever
            // into a hidden canvas no one reads. The next job's load() restarts
            // it; capture already happens after SETTLE_MS, so thumbs are
            // unchanged. try/catch is generic belt-and-suspenders.
            try { this.deck.stop() } catch { /* ignore */ }
            // Yield then drain next so we don't starve other tasks.
            setTimeout(() => this._drain(), 0)
        }
    }

    queueDepth() { return this._queue.length + (this._busy ? 1 : 0) }
}

export function getThumbnailRenderer() {
    if (!_instance) _instance = new ThumbnailRenderer()
    return _instance
}
