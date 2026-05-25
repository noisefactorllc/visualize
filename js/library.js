/**
 * Library — loads curated DSL programs and renders the side-panel grid.
 *
 * Each program has { title, tagline, tint, tags, dsl }. The library
 * provides:
 *   - load() / programs (data access)
 *   - random() / randomMatching(predicate) for auto-VJ
 *   - mount(rootEl, { onLoadToDeck, onFilterCount }) for the UI panel
 */

export class Library {
    constructor() {
        this.programs = []
        this._filter = ''
        this._rootEl = null
        this._gridEl = null
        this._countEl = null
        this._searchEl = null
        this._onLoadToDeck = null
    }

    async load(path = 'data/programs.json') {
        const resp = await fetch(path, { cache: 'no-cache' })
        if (!resp.ok) throw new Error(`Failed to load library: ${resp.status}`)
        this.programs = await resp.json()
        return this.programs
    }

    /** Pick a random program. */
    random() {
        if (!this.programs.length) return null
        return this.programs[Math.floor(Math.random() * this.programs.length)]
    }

    /**
     * Pick a random program whose title is not in `exclude`. Accepts a
     * single title or an array of titles. Falls back to a plain random
     * pick if the exclusion list covers (almost) the whole library.
     */
    randomExcept(exclude) {
        if (!this.programs.length) return null
        const excludeSet = new Set(
            (Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean)
        )
        // If excluding would eliminate every option, just pick randomly.
        const eligible = this.programs.filter(p => !excludeSet.has(p.title))
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
        this.render()
    }

    setRandomBothButton(button) {
        if (!button) return
        button.addEventListener('click', () => {
            this._onRandomBoth?.()
        })
    }

    render() {
        if (!this._gridEl) return
        const filtered = this.programs.filter(p => this._matches(p))
        this._gridEl.innerHTML = ''
        for (const p of filtered) {
            this._gridEl.appendChild(this._renderCard(p))
        }
        if (this._countEl) {
            this._countEl.textContent = `${filtered.length} program${filtered.length === 1 ? '' : 's'}`
        }
    }

    _matches(p) {
        if (!this._filter) return true
        const hay = (p.title + ' ' + (p.tagline || '') + ' ' + (p.tags || []).join(' ')).toLowerCase()
        return hay.includes(this._filter)
    }

    _renderCard(p) {
        const card = document.createElement('div')
        card.className = 'program-card'
        card.style.setProperty('--card-tint', p.tint || '#3a3a55')
        card.draggable = true
        card.dataset.title = p.title

        const titleEl = document.createElement('div')
        titleEl.className = 'pc-title'
        titleEl.textContent = p.title
        card.appendChild(titleEl)

        const tagEl = document.createElement('div')
        tagEl.className = 'pc-tagline'
        tagEl.textContent = p.tagline || ''
        card.appendChild(tagEl)

        const actions = document.createElement('div')
        actions.className = 'pc-actions'

        const loadA = document.createElement('button')
        loadA.className = 'pc-load'
        loadA.dataset.deck = 'A'
        loadA.textContent = '→ A'
        loadA.addEventListener('click', (e) => {
            e.stopPropagation()
            this._onLoadToDeck?.('A', p)
        })

        const loadB = document.createElement('button')
        loadB.className = 'pc-load'
        loadB.dataset.deck = 'B'
        loadB.textContent = '→ B'
        loadB.addEventListener('click', (e) => {
            e.stopPropagation()
            this._onLoadToDeck?.('B', p)
        })

        actions.appendChild(loadA)
        actions.appendChild(loadB)
        card.appendChild(actions)

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
