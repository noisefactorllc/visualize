// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTooltip, getTooltip, migrateBelow } from '../js/tooltips.js'

// Minimal DOM mock for Node.js unit testing of tooltip helpers
function createMockElement(tag = 'button', attrs = {}, classList = []) {
    const classes = new Set(classList)
    const attributes = { ...attrs }
    const dataset = {}
    for (const [key, val] of Object.entries(attrs)) {
        if (key.startsWith('data-')) {
            const prop = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
            dataset[prop] = String(val)
        }
    }
    const children = []

    return {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        dataset,
        classList: {
            add: (...cls) => cls.forEach(c => classes.add(c)),
            remove: (...cls) => cls.forEach(c => classes.delete(c)),
            contains: (c) => classes.has(c),
            get value() { return Array.from(classes).join(' ') },
        },
        hasAttribute: (name) => name in attributes,
        getAttribute: (name) => attributes[name] ?? null,
        setAttribute: (name, val) => {
            attributes[name] = String(val)
            if (name.startsWith('data-')) {
                const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
                dataset[prop] = String(val)
            }
        },
        removeAttribute: (name) => {
            delete attributes[name]
            if (name.startsWith('data-')) {
                const prop = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
                delete dataset[prop]
            }
        },
        appendChild: (child) => { children.push(child); return child },
        querySelectorAll: (selector) => {
            const results = []
            const traverse = (node) => {
                for (const ch of node.children || []) {
                    if (selector === '[title]' && ch.hasAttribute('title')) {
                        results.push(ch)
                    }
                    traverse(ch)
                }
            }
            traverse({ children })
            return results
        },
        children,
    }
}

test('setTooltip: sets data-title, adds .tooltip class, and strips native title attribute', () => {
    const el = createMockElement('button', { title: 'Old tooltip' })
    setTooltip(el, 'Cut to A (Z)')

    assert.equal(el.dataset.title, 'Cut to A (Z)')
    assert.equal(el.classList.contains('tooltip'), true)
    assert.equal(el.hasAttribute('title'), false)
})

test('setTooltip: clears tooltip attributes when text is empty or null', () => {
    const el = createMockElement('button', {}, ['tooltip'])
    el.dataset.title = 'Some hint'

    setTooltip(el, '')
    assert.equal(el.dataset.title, undefined)
    assert.equal(el.classList.contains('tooltip'), false)

    setTooltip(el, 'Temporary')
    assert.equal(el.dataset.title, 'Temporary')
    assert.equal(el.classList.contains('tooltip'), true)

    setTooltip(el, null)
    assert.equal(el.dataset.title, undefined)
    assert.equal(el.classList.contains('tooltip'), false)
})

test('getTooltip: resolves tooltip text following precedence (data-title > title > aria-label)', () => {
    const full = createMockElement('button', {
        'data-title': 'From data-title',
        title: 'From title',
        'aria-label': 'From aria-label',
    })
    assert.equal(getTooltip(full), 'From data-title')

    const titleOnly = createMockElement('button', {
        title: 'From title',
        'aria-label': 'From aria-label',
    })
    assert.equal(getTooltip(titleOnly), 'From title')

    const ariaOnly = createMockElement('button', {
        'aria-label': 'From aria-label',
    })
    assert.equal(getTooltip(ariaOnly), 'From aria-label')

    const empty = createMockElement('button')
    assert.equal(getTooltip(empty), '')
    assert.equal(getTooltip(null), '')
})

test('migrateBelow: converts subtree native title attributes to Handfish data-title and .tooltip', () => {
    const root = createMockElement('div')
    const child1 = createMockElement('button', { title: 'Child 1 hint' })
    const child2 = createMockElement('span', { title: 'Child 2 hint' })
    const child3 = createMockElement('div') // no title

    root.appendChild(child1)
    root.appendChild(child2)
    root.appendChild(child3)

    migrateBelow(root)

    assert.equal(child1.dataset.title, 'Child 1 hint')
    assert.equal(child1.classList.contains('tooltip'), true)
    assert.equal(child1.hasAttribute('title'), false)

    assert.equal(child2.dataset.title, 'Child 2 hint')
    assert.equal(child2.classList.contains('tooltip'), true)
    assert.equal(child2.hasAttribute('title'), false)

    assert.equal(child3.dataset.title, undefined)
    assert.equal(child3.classList.contains('tooltip'), false)
})

test('index.html: transport buttons carry .tooltip class and shortcut annotations in tooltips', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    const getElementById = (id) => {
        const regex = new RegExp(`<[^>]+id=["']${id}["'][^>]*>`, 'i')
        const match = html.match(regex)
        assert.ok(match, `Element with id="${id}" must exist in index.html`)
        return match[0]
    }

    // Auto-VJ: Space
    const automix = getElementById('automix-toggle')
    assert.match(automix, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(automix, /data-title="[^"]*\(Space\)"/)

    // Scenes drawer button: Shift+S
    const scenes = getElementById('scenes-open')
    assert.match(scenes, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(scenes, /data-title="[^"]*\(Shift\+S\)"/)

    // Record toggle: R
    const record = getElementById('record-toggle')
    assert.match(record, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(record, /data-title="[^"]*\(R\)"/)

    // Settings toggle: S
    const settings = getElementById('settings-toggle')
    assert.match(settings, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(settings, /data-title="[^"]*\(S\)"/)

    // Fullscreen toggle: F
    const fullscreen = getElementById('fullscreen-toggle')
    assert.match(fullscreen, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(fullscreen, /data-title="[^"]*\(F\)"/)

    // Quick cuts: Z, X, C
    const cutA = getElementById('cut-a')
    assert.match(cutA, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(cutA, /data-title="Cut to A \(Z\)"/)

    const autoFade = getElementById('auto-fade')
    assert.match(autoFade, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(autoFade, /data-title="Auto-fade \(X\)"/)

    const cutB = getElementById('cut-b')
    assert.match(cutB, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(cutB, /data-title="Cut to B \(C\)"/)

    // Crossfader: arrow nudge hints
    const crossfader = getElementById('crossfader')
    assert.match(crossfader, /class="[^"]*\btooltip\b[^"]*"/)
    assert.match(crossfader, /data-title="[^"]*5%[^"]*1%/)
})

test('index.html: main FX toggles 1–6 carry .tooltip class and shortcut annotations', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    const fxList = [
        { fx: 'strobe', key: '1' },
        { fx: 'invert', key: '2' },
        { fx: 'bw', key: '3' },
        { fx: 'zoom', key: '4' },
        { fx: 'freeze', key: '5' },
        { fx: 'flash', key: '6' },
    ]

    for (const { fx, key } of fxList) {
        const regex = new RegExp(`<button[^>]+data-fx=["']${fx}["'][^>]*>`, 'i')
        const match = html.match(regex)
        assert.ok(match, `FX button data-fx="${fx}" must exist in index.html`)
        const tag = match[0]
        assert.match(tag, /class="[^"]*\btooltip\b[^"]*"/, `FX button ${fx} must have .tooltip class`)
        assert.match(tag, new RegExp(`data-title="[^"]*\\(${key}\\)`), `FX button ${fx} must have (${key}) in data-title`)
    }
})

test('index.html: deck head controls carry .tooltip and shortcut annotations (Q, W, E, Shift+E, M, Shift+M)', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    // Deck A random (Q) & Deck B random (W)
    const matchRandomA = html.match(/<button[^>]+class="[^"]*deck-load-random[^"]*"[^>]+data-deck="A"[^>]*>/)
    assert.ok(matchRandomA)
    assert.match(matchRandomA[0], /\btooltip\b/)
    assert.match(matchRandomA[0], /data-title="[^"]*\(Q\)"/)

    const matchRandomB = html.match(/<button[^>]+class="[^"]*deck-load-random[^"]*"[^>]+data-deck="B"[^>]*>/)
    assert.ok(matchRandomB)
    assert.match(matchRandomB[0], /\btooltip\b/)
    assert.match(matchRandomB[0], /data-title="[^"]*\(W\)"/)

    // Deck A rebind EQ (E) & Deck B rebind EQ (Shift+E)
    const matchEqA = html.match(/<button[^>]+class="[^"]*deck-rebind-eq[^"]*"[^>]+data-deck="A"[^>]*>/)
    assert.ok(matchEqA)
    assert.match(matchEqA[0], /\btooltip\b/)
    assert.match(matchEqA[0], /data-title="[^"]*\(E\)"/)

    const matchEqB = html.match(/<button[^>]+class="[^"]*deck-rebind-eq[^"]*"[^>]+data-deck="B"[^>]*>/)
    assert.ok(matchEqB)
    assert.match(matchEqB[0], /\btooltip\b/)
    assert.match(matchEqB[0], /data-title="[^"]*\(Shift\+E\)"/)

    // Deck A rebind MIDI (M) & Deck B rebind MIDI (Shift+M)
    const matchMidiA = html.match(/<button[^>]+class="[^"]*deck-rebind-midi[^"]*"[^>]+data-deck="A"[^>]*>/)
    assert.ok(matchMidiA)
    assert.match(matchMidiA[0], /\btooltip\b/)
    assert.match(matchMidiA[0], /data-title="[^"]*\(M\)"/)

    const matchMidiB = html.match(/<button[^>]+class="[^"]*deck-rebind-midi[^"]*"[^>]+data-deck="B"[^>]*>/)
    assert.ok(matchMidiB)
    assert.match(matchMidiB[0], /\btooltip\b/)
    assert.match(matchMidiB[0], /data-title="[^"]*\(Shift\+M\)"/)
})

test('index.html: drawer close buttons carry .tooltip and (Esc) shortcut annotation', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

    const getElementById = (id) => {
        const regex = new RegExp(`<[^>]+id=["']${id}["'][^>]*>`, 'i')
        const match = html.match(regex)
        assert.ok(match, `Element with id="${id}" must exist in index.html`)
        return match[0]
    }

    const settingsClose = getElementById('settings-close')
    assert.match(settingsClose, /\btooltip\b/)
    assert.match(settingsClose, /data-title="[^"]*\(Esc\)"/)

    const scenesClose = getElementById('scenes-close')
    assert.match(scenesClose, /\btooltip\b/)
    assert.match(scenesClose, /data-title="[^"]*\(Esc\)"/)
})

test('index.html: settings drawer keyboard section documents all performance shortcuts with discrete keycaps', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
    const gridMatch = html.match(/<div class="shortcut-grid">([\s\S]*?)<\/div>\s*<\/section>/)
    assert.ok(gridMatch, 'shortcut-grid must exist in index.html')
    const gridContent = gridMatch[1]

    const expectedPatterns = [
        /<kbd>Space<\/kbd>/,
        /<kbd>T<\/kbd>/,
        /<kbd>F<\/kbd>/,
        /<kbd>S<\/kbd>/,
        /<kbd>R<\/kbd>/,
        /<kbd>Z<\/kbd>\s*\/\s*<kbd>X<\/kbd>\s*\/\s*<kbd>C<\/kbd>/,
        /<kbd>←<\/kbd>\s*\/\s*<kbd>→<\/kbd>/,
        /<kbd>1<\/kbd>–<kbd>6<\/kbd>/,
        /<kbd>Q<\/kbd>\s*\/\s*<kbd>W<\/kbd>/,
        /<kbd>E<\/kbd>\s*\/\s*<kbd>Shift<\/kbd>\+<kbd>E<\/kbd>/,
        /<kbd>M<\/kbd>\s*\/\s*<kbd>Shift<\/kbd>\+<kbd>M<\/kbd>/,
        /<kbd>Shift<\/kbd>\+<kbd>S<\/kbd>/,
        /<kbd>Shift<\/kbd>\+<kbd>1<\/kbd>–<kbd>9<\/kbd>/,
        /<kbd>Esc<\/kbd>/,
    ]

    for (const pattern of expectedPatterns) {
        assert.match(gridContent, pattern, `Shortcut grid must contain pattern: ${pattern}`)
    }
})

test('js/app.js: renders scene names with Handfish tooltip class and data-title', () => {
    const appJs = readFileSync(resolve(process.cwd(), 'js/app.js'), 'utf8')
    assert.match(appJs, /class="sr-name tooltip"\s+data-title="Double-click to rename"/)
})
