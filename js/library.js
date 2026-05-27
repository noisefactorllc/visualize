/**
 * Library — loads curated DSL programs and renders the side-panel grid.
 *
 * Each program has { title, tagline, tint, tags, dsl } plus an optional
 * `source` field on imported entries:
 *   source: { feed, code, username, app, createdAt, importedAt }
 *
 * The grid:
 *   - lazy-renders a single-frame thumbnail per card (IntersectionObserver
 *     → thumbnailRenderer → IndexedDB cache); cards out of view never
 *     trigger renders, cached thumbs paint immediately on re-show.
 *   - shows a "by <username>" attribution chip on imported entries so
 *     credit is visible right on the card.
 */

import { getCachedThumb, putCachedThumb, hashDsl } from './thumbnailCache.js'
import { getThumbnailRenderer } from './thumbnailRenderer.js'

export class Library {
    constructor() {
        this.programs = []
        this._filter = ''
        this._rootEl = null
        this._gridEl = null
        this._countEl = null
        this._searchEl = null
        this._onLoadToDeck = null

        // Lazy-render machinery
        this._observer = null
        this._blobUrls = []       // tracked so we can revoke on re-render
        this._thumbnailsEnabled = false
        this._pendingThumbCards = new Set()
    }

    async load(path = 'data/programs.json') {
        const resp = await fetch(path, { cache: 'no-cache' })
        if (!resp.ok) throw new Error(`Failed to load library: ${resp.status}`)
        this.programs = await resp.json()
        return this.programs
    }

    /** True if a program is in the "util" category — these are user-
     *  selected only (camera input, solid fills, scope, etc.) and never
     *  show up via random() / auto-VJ. */
    static isUtil(program) {
        return !!program?.tags?.includes('util')
    }

    /** Pick a random NON-util program. */
    random() {
        const pool = this.programs.filter(p => !Library.isUtil(p))
        if (!pool.length) return null
        return pool[Math.floor(Math.random() * pool.length)]
    }

    /**
     * Pick a random non-util program whose title is not in `exclude`.
     * Accepts a single title or an array of titles. Falls back to a
     * plain random pick if the exclusion list covers all eligible.
     */
    randomExcept(exclude) {
        const pool = this.programs.filter(p => !Library.isUtil(p))
        if (!pool.length) return null
        const excludeSet = new Set(
            (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean)
        )
        const eligible = pool.filter(p => !excludeSet.has(p.title))
        if (eligible.length === 0) return this.random()
        return eligible[Math.floor(Math.random() * eligible.length)]
    }

    /** Find a program by title. */
    byTitle(title) {
        return this.programs.find(p => p.title === title) || null
    }

    /**
     * Mount the library grid into rootEl. Calls `onLoadToDeck(deckId, program)`
     * when the user clicks a card or its A/B button.
     */
    mount({ rootEl, gridEl, countEl, searchEl, onLoadToDeck, onRandomBoth }) {
        this._rootEl = rootEl
        this._gridEl = gridEl
        this._countEl = countEl
        this._searchEl = searchEl
        this._onLoadToDeck = onLoadToDeck
        this._onRandomBoth = onRandomBoth

        if (searchEl) {
            searchEl.addEventListener('input', () => {
                this._filter = searchEl.value.trim().toLowerCase()
                this.render()
            })
        }
        this._initObserver()
        this.render()
    }

    setRandomBothButton(button) {
        if (!button) return
        button.addEventListener('click', () => {
            this._onRandomBoth?.()
        })
    }

    _initObserver() {
        if (!('IntersectionObserver' in window)) return
        this._observer = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue
                const card = e.target
                this._observer.unobserve(card)
                if (this._thumbnailsEnabled) {
                    this._loadThumb(card).catch(() => {})
                } else {
                    // Park visible cards; we'll flush them when the host
                    // app calls enableThumbnails() (typically right after
                    // the user clicks START, so we don't fight the live
                    // deck init for GPU + manifest bandwidth at boot).
                    this._pendingThumbCards.add(card)
                }
            }
        }, {
            root: this._gridEl,
            // Start rendering thumbs slightly before they enter the
            // viewport so the user sees a populated card the moment it
            // scrolls in, not a blank tile that fills a frame later.
            rootMargin: '120px 0px',
            threshold: 0.01,
        })
    }

    /**
     * Permit thumbnail rendering. Call this after the live decks are up
     * (i.e. after the boot gesture resolves) so the offscreen thumbnail
     * renderer doesn't compete with the live decks for the shader
     * manifest fetch or GPU resources during initial load.
     *
     * Idempotent. Flushes any cards that have already intersected.
     */
    enableThumbnails() {
        if (this._thumbnailsEnabled) return
        this._thumbnailsEnabled = true
        for (const card of this._pendingThumbCards) {
            this._loadThumb(card).catch(() => {})
        }
        this._pendingThumbCards.clear()
    }

    async _loadThumb(card) {
        const dsl = card.dataset.dsl
        if (!dsl) return
        const imgEl = card.querySelector('.pc-thumb-img')
        if (!imgEl) return

        const key = await hashDsl(dsl)
        let blob = await getCachedThumb(key)
        if (!blob) {
            blob = await getThumbnailRenderer().render(dsl)
            if (blob) putCachedThumb(key, blob)    // fire and forget
        }
        if (!blob) {
            card.classList.add('pc-thumb-failed')
            return
        }
        const url = URL.createObjectURL(blob)
        this._blobUrls.push(url)
        imgEl.src = url
        imgEl.addEventListener('load', () => {
            card.classList.add('pc-thumb-ready')
        }, { once: true })
    }

    render() {
        if (!this._gridEl) return

        // Release any prior render's blob URLs so they don't leak when
        // the user filters or the library reloads.
        for (const url of this._blobUrls) URL.revokeObjectURL(url)
        this._blobUrls = []
        if (this._observer) this._observer.disconnect()
        this._pendingThumbCards.clear()

        const filtered = this.programs.filter(p => this._matches(p))
        this._gridEl.innerHTML = ''
        for (const p of filtered) {
            const card = this._renderCard(p)
            this._gridEl.appendChild(card)
            if (this._observer) this._observer.observe(card)
        }
        if (this._countEl) {
            this._countEl.textContent = `${filtered.length} program${filtered.length === 1 ? '' : 's'}`
        }
    }

    _matches(p) {
        if (!this._filter) return true
        const sourceText = p.source ? `${p.source.username} ${p.source.app}` : ''
        const hay = (p.title + ' ' + (p.tagline || '') + ' ' + (p.tags || []).join(' ') + ' ' + sourceText).toLowerCase()
        return hay.includes(this._filter)
    }

    _renderCard(p) {
        const card = document.createElement('div')
        card.className = 'program-card'
        card.style.setProperty('--card-tint', p.tint || '#3a3a55')
        card.draggable = true
        card.dataset.title = p.title
        card.dataset.dsl = p.dsl

        // Thumbnail layer — fills the entire card. Stays blank until
        // the IntersectionObserver triggers a render or hits the
        // IndexedDB cache; CSS draws a tinted skeleton meanwhile.
        const thumb = document.createElement('div')
        thumb.className = 'pc-thumb'
        const img = document.createElement('img')
        img.className = 'pc-thumb-img'
        img.alt = ''
        img.loading = 'lazy'
        img.decoding = 'async'
        thumb.appendChild(img)
        card.appendChild(thumb)

        // Overlay: title / tagline / attribution / load buttons stacked
        // on top of the thumbnail with a bottom-up dark gradient so the
        // text stays legible regardless of how bright the program
        // renders. Pointer events are disabled on the overlay itself so
        // dragging the card from a blank patch still works; the buttons
        // re-enable pointer events for themselves.
        const overlay = document.createElement('div')
        overlay.className = 'pc-overlay'

        const titleEl = document.createElement('div')
        titleEl.className = 'pc-title'
        titleEl.textContent = p.title
        // Move full tagline / attribution into the tooltip so the
        // compact card stays readable while losing no information.
        const tooltipParts = [p.tagline]
        if (p.source?.username) {
            tooltipParts.push(`by ${p.source.username} · ${p.source.app || 'noisedeck'} · ${p.source.code}`)
        }
        titleEl.title = tooltipParts.filter(Boolean).join('\n')
        overlay.appendChild(titleEl)

        const tagEl = document.createElement('div')
        tagEl.className = 'pc-tagline'
        tagEl.textContent = p.tagline || ''
        overlay.appendChild(tagEl)

        if (p.source?.username) {
            card.dataset.imported = '1'
        }

        const actions = document.createElement('div')
        actions.className = 'pc-actions'

        const loadA = document.createElement('button')
        loadA.className = 'pc-load'
        loadA.dataset.deck = 'A'
        loadA.textContent = 'A'
        loadA.title = 'Load into Deck A'
        loadA.addEventListener('click', (e) => {
            e.stopPropagation()
            this._onLoadToDeck?.('A', p)
        })

        const loadB = document.createElement('button')
        loadB.className = 'pc-load'
        loadB.dataset.deck = 'B'
        loadB.textContent = 'B'
        loadB.title = 'Load into Deck B'
        loadB.addEventListener('click', (e) => {
            e.stopPropagation()
            this._onLoadToDeck?.('B', p)
        })

        actions.appendChild(loadA)
        actions.appendChild(loadB)
        overlay.appendChild(actions)

        card.appendChild(overlay)

        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/program-title', p.title)
            e.dataTransfer.effectAllowed = 'copy'
        })

        // Double-click loads to whichever deck the crossfader is hidden from
        card.addEventListener('dblclick', () => {
            this._onLoadToDeck?.('auto', p)
        })

        return card
    }

}
