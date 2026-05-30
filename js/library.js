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
import { setTooltip } from './tooltips.js'
import { buildDefaultPrograms } from './defaultPrograms.js'

const INCLUDE_STORAGE_KEY = 'visualize.library.included.v1'

// Section ordering for the grid. Each program is assigned a category
// at load time via Library.categoryFor(); render() emits a <details>
// section per non-empty category in this exact order.
//
// `user` sits between the engine-default sections and the curated
// list so an operator's imported portable effects get prominent
// visibility (right under particles + sims) without crowding the
// engine-defaults at the very top.
const CATEGORY_ORDER = Object.freeze([
    'default-particles',
    'default-sim',
    'user',
    'built-in',
    'noiseblaster',
    'util',
])

const CATEGORY_LABELS = Object.freeze({
    'default-particles': 'particles',
    'default-sim': 'sims',
    'user': 'user',
    'built-in': 'built-in',
    'noiseblaster': 'noiseblaster',
    'util': 'utility',
})

export class Library {
    constructor() {
        this.programs = []
        this._filter = ''
        this._rootEl = null
        this._gridEl = null
        this._countEl = null
        this._searchEl = null
        this._onLoadToDeck = null

        // Per-title include flag for the Auto-VJ random pool.
        // Default for any non-util title: included. Operator toggles
        // via per-card checkbox. Util titles are never in the pool
        // regardless. Storage holds only the EXCLUDED set so the
        // default-on semantics stay correct as new titles ship.
        this._excluded = this._loadExcluded()

        // Lazy-render machinery
        this._observer = null
        this._blobUrls = []       // tracked so we can revoke on re-render
        this._thumbnailsEnabled = false
        this._pendingThumbCards = new Set()
    }

    async load(path = 'data/programs.json', { renderer = null } = {}) {
        const fetched = fetch(path, { cache: 'no-cache' }).then(async resp => {
            if (!resp.ok) throw new Error(`Failed to load library: ${resp.status}`)
            return resp.json()
        })

        // Engine defaults (points namespace + sim tag) need a renderer
        // with a resolved manifest. When no renderer is supplied
        // (tests, headless tooling) the default sections stay empty —
        // the curated list is still served as before.
        const defaults = renderer
            ? buildDefaultPrograms(renderer).catch(err => {
                console.warn('[library] default programs failed:', err)
                return []
            })
            : Promise.resolve([])

        const [curated, defs] = await Promise.all([fetched, defaults])
        // Default-particles + default-sim go to the front so the
        // sections render in the configured order regardless of
        // search filter behaviour. Internal ordering still flows
        // through Library.categoryFor() at render time.
        this.programs = [...defs, ...curated]
        return this.programs
    }

    /** True if a program is in the "util" category — these are user-
     *  selected only (camera input, solid fills, scope, etc.) and never
     *  show up via random() / auto-VJ. */
    static isUtil(program) {
        return !!program?.tags?.includes('util')
    }

    /**
     * Group a program into one of the five top-level sections. The
     * order of these checks matters: an engine-default entry that
     * happened to be tagged "util" upstream should still land in its
     * default-particles / default-sim section, not in utility.
     */
    static categoryFor(program) {
        if (program?.source?.kind === 'engine-default') {
            if (program.source.namespace === 'user') return 'user'
            if (program.source.namespace === 'points') return 'default-particles'
            return 'default-sim'
        }
        if (Library.isUtil(program)) return 'util'
        if (program?.source?.feed === 'noiseblaster') return 'noiseblaster'
        return 'built-in'
    }

    /**
     * Rebuild only the engine-default entries (particles, sims, user)
     * by re-running buildDefaultPrograms against the renderer. Used by
     * the user-effects manager's onChange path so installing or
     * deleting a portable effect updates the library without a full
     * fetch of programs.json. Keeps non-default (curated) entries in
     * place.
     */
    async reloadDefaults(renderer) {
        if (!renderer) return
        const defaults = await buildDefaultPrograms(renderer)
        const curated = this.programs.filter(p => p?.source?.kind !== 'engine-default')
        this.programs = [...defaults, ...curated]
    }

    /** True if this title is currently eligible for the Auto-VJ random
     *  pool: non-util AND not in the operator's exclude set. */
    isIncluded(title) {
        const p = this.byTitle(title)
        if (!p || Library.isUtil(p)) return false
        return !this._excluded.has(title)
    }

    /** Toggle the include flag for `title`. No-op for util titles. */
    setIncluded(title, included) {
        const p = this.byTitle(title)
        if (!p || Library.isUtil(p)) return
        if (included) this._excluded.delete(title)
        else this._excluded.add(title)
        this._saveExcluded()
    }

    /** The pool the Auto-VJ random picker draws from: non-util AND
     *  not excluded by the operator. */
    _randomPool() {
        return this.programs.filter(p =>
            !Library.isUtil(p) && !this._excluded.has(p.title))
    }

    /** Pick a random included program. */
    random() {
        const pool = this._randomPool()
        if (!pool.length) return null
        return pool[Math.floor(Math.random() * pool.length)]
    }

    /**
     * Pick a random included program whose title is not in `exclude`.
     * Accepts a single title or an array of titles. Falls back to a
     * plain random pick if the exclusion list covers all eligible.
     */
    randomExcept(exclude) {
        const pool = this._randomPool()
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

        // Bucket by category, preserving in-array order within each.
        const buckets = new Map(CATEGORY_ORDER.map(c => [c, []]))
        for (const p of filtered) {
            const cat = Library.categoryFor(p)
            if (!buckets.has(cat)) buckets.set(cat, [])
            buckets.get(cat).push(p)
        }

        this._gridEl.innerHTML = ''
        for (const category of CATEGORY_ORDER) {
            const programs = buckets.get(category) || []
            if (programs.length === 0) continue

            const section = document.createElement('details')
            section.className = 'lib-section'
            section.dataset.category = category
            section.open = true

            const summary = document.createElement('summary')
            summary.className = 'lib-section-summary'

            const label = document.createElement('span')
            label.className = 'lib-section-label'
            label.textContent = CATEGORY_LABELS[category] || category
            summary.appendChild(label)

            const count = document.createElement('span')
            count.className = 'lib-section-count'
            count.textContent = String(programs.length)
            summary.appendChild(count)

            section.appendChild(summary)

            const sectionGrid = document.createElement('div')
            sectionGrid.className = 'lib-section-grid'
            for (const p of programs) {
                const card = this._renderCard(p)
                sectionGrid.appendChild(card)
                if (this._observer) this._observer.observe(card)
            }
            section.appendChild(sectionGrid)
            this._gridEl.appendChild(section)
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
        setTooltip(titleEl, tooltipParts.filter(Boolean).join('\n'))
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

        // Per-card include toggle: drives Library.random() /
        // randomExcept() (= Auto-VJ's pool). Util programs are never
        // in the pool, so they don't get a toggle.
        if (!Library.isUtil(p)) {
            const incBox = document.createElement('toggle-switch')
            incBox.className = 'pc-include'
            setTooltip(incBox, 'Include in Auto-VJ pool')
            if (!this._excluded.has(p.title)) incBox.setAttribute('checked', '')
            // Stop click from also triggering the card's load-on-click
            // behaviours (drag, dblclick).
            incBox.addEventListener('click', (e) => e.stopPropagation())
            incBox.addEventListener('change', () => {
                this.setIncluded(p.title, incBox.checked)
                card.dataset.excluded = incBox.checked ? '0' : '1'
            })
            actions.appendChild(incBox)
            card.dataset.excluded = this._excluded.has(p.title) ? '1' : '0'
        }

        const loadA = document.createElement('button')
        loadA.className = 'pc-load'
        loadA.dataset.deck = 'A'
        loadA.textContent = 'A'
        setTooltip(loadA, 'Load into Deck A')
        loadA.addEventListener('click', (e) => {
            e.stopPropagation()
            this._onLoadToDeck?.('A', p)
        })

        const loadB = document.createElement('button')
        loadB.className = 'pc-load'
        loadB.dataset.deck = 'B'
        loadB.textContent = 'B'
        setTooltip(loadB, 'Load into Deck B')
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

    _loadExcluded() {
        try {
            const raw = localStorage.getItem(INCLUDE_STORAGE_KEY)
            const arr = raw ? JSON.parse(raw) : []
            return new Set(Array.isArray(arr) ? arr : [])
        } catch {
            return new Set()
        }
    }
    _saveExcluded() {
        try {
            localStorage.setItem(INCLUDE_STORAGE_KEY,
                JSON.stringify([...this._excluded]))
        } catch { /* private mode quota — best-effort */ }
    }

}
