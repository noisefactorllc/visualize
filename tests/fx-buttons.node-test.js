// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('index.html: main FX buttons have correct type, aria-pressed, and data-state attributes', () => {
    const htmlPath = resolve(process.cwd(), 'index.html')
    const html = readFileSync(htmlPath, 'utf8')

    const mainFxMatch = html.match(/<div class="main-fx">([\s\S]*?)<\/div>/)
    assert.ok(mainFxMatch, '.main-fx container should exist in index.html')
    const mainFxHtml = mainFxMatch[1]

    const buttonMatches = [...mainFxHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    assert.equal(buttonMatches.length, 6, 'Should have exactly 6 FX buttons in .main-fx')

    const fxTypes = buttonMatches.map(m => {
        const attrs = m[1]
        const fx = attrs.match(/data-fx="([^"]+)"/)?.[1]
        const type = attrs.match(/type="([^"]+)"/)?.[1]
        const ariaPressed = attrs.match(/aria-pressed="([^"]+)"/)?.[1]
        const dataState = attrs.match(/data-state="([^"]+)"/)?.[1]
        const hasTooltip = /class="[^"]*\btooltip\b[^"]*"/.test(attrs)
        const hasFxButton = /class="[^"]*\bfx-button\b[^"]*"/.test(attrs)
        return { fx, type, ariaPressed, dataState, hasTooltip, hasFxButton }
    })

    const latchingFx = ['strobe', 'invert', 'bw', 'zoom', 'freeze']
    for (const name of latchingFx) {
        const item = fxTypes.find(f => f.fx === name)
        assert.ok(item, `Button for FX ${name} should exist`)
        assert.equal(item.type, 'button', `${name} button should have type="button"`)
        assert.equal(item.hasFxButton, true, `${name} button should have .fx-button class`)
        assert.equal(item.hasTooltip, true, `${name} button should have .tooltip class`)
        assert.equal(item.ariaPressed, 'false', `${name} toggle button should have aria-pressed="false" initially`)
        assert.equal(item.dataState, 'off', `${name} toggle button should have data-state="off" initially`)
    }

    const flashItem = fxTypes.find(f => f.fx === 'flash')
    assert.ok(flashItem, 'Flash button should exist')
    assert.equal(flashItem.type, 'button', 'Flash button should have type="button"')
    assert.equal(flashItem.hasFxButton, true, 'Flash button should have .fx-button class')
    assert.equal(flashItem.hasTooltip, true, 'Flash button should have .tooltip class')
    assert.equal(flashItem.ariaPressed, undefined, 'Flash momentary trigger should not have aria-pressed')
})

test('css/app.css: FX buttons follow Handfish token discipline and high-contrast active state', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const css = readFileSync(cssPath, 'utf8')

    // Base button styling uses semantic tokens
    assert.match(css, /\.fx-button\s*\{[^}]*position:\s*relative/)
    assert.match(css, /\.fx-button\s*\{[^}]*var\(--hf-bg-base\)/)
    assert.match(css, /\.fx-button\s*\{[^}]*var\(--hf-text-dim\)/)
    assert.match(css, /\.fx-button\s*\{[^}]*var\(--hf-border-subtle\)/)
    assert.match(css, /\.fx-button\s*\{[^}]*var\(--hf-radius-sm\)/)
    assert.match(css, /\.fx-button\s*\{[^}]*var\(--hf-font-family-mono\)/)

    // Hardware indicator slot styling
    assert.match(css, /\.fx-button::before\s*\{[^}]*position:\s*absolute/)
    assert.match(css, /\.fx-button::before\s*\{[^}]*var\(--hf-radius-pill\)/)
    assert.match(css, /\.fx-button::before\s*\{[^}]*var\(--hf-border-subtle\)/)

    // Active state styling includes high-contrast tokens, bold weight, and accent glow
    const activeSection = css.match(/\.fx-button\.active[^{]*\{[^}]*\}/)?.[0] || ''
    assert.ok(activeSection, '.fx-button.active rule should exist')
    assert.match(activeSection, /var\(--hf-accent\)/, 'Active state must use --hf-accent')
    assert.match(activeSection, /var\(--hf-bg-base\)/, 'Active text must use high-contrast --hf-bg-base')
    assert.match(activeSection, /var\(--hf-weight-bold\)/, 'Active text must be bold')
    assert.match(activeSection, /var\(--hf-glow-accent/, 'Active state must include accent glow')

    // Active indicator slot lights up with high contrast
    const activeBeforeSection = css.match(/\.fx-button\.active::before[^{]*\{[^}]*\}/)?.[0] || ''
    assert.ok(activeBeforeSection, '.fx-button.active::before rule should exist')
    assert.match(activeBeforeSection, /var\(--hf-bg-base\)/, 'Active indicator must light up with high contrast')

    // Active hover preserves high-contrast active state instead of washing out
    const activeHoverSection = css.match(/\.fx-button\.active:hover[^{]*\{[^}]*\}/)?.[0] || ''
    assert.ok(activeHoverSection, '.fx-button.active:hover rule should exist')
    assert.match(activeHoverSection, /var\(--hf-bg-base\)/, 'Active hover text must remain --hf-bg-base')
    assert.match(activeHoverSection, /var\(--hf-accent-hover/, 'Active hover must use --hf-accent-hover')

    // General hover rule excludes active/latched buttons
    assert.match(
        css,
        /\.fx-button:hover:not\(\.active\):not\(\[aria-pressed="true"\]\)/,
        'Idle hover rule must exclude active and latched buttons'
    )

    // Momentary flash feedback styling
    assert.match(css, /\.fx-button\[data-fx="flash"\]\.flash-active\s*\{[^}]*var\(--hf-accent\)/)
})

test('toggleFx logic: synchronizes active class, aria-pressed, and data-state', () => {
    // Mock element representing an FX button
    function createMockFxButton(fx, initialActive = false) {
        let active = initialActive
        const attrs = {
            'type': 'button',
            'data-fx': fx,
            'aria-pressed': fx === 'flash' ? undefined : (active ? 'true' : 'false'),
            'data-state': active ? 'on' : 'off'
        }
        const classes = new Set(['fx-button', 'tooltip'])
        if (active) classes.add('active')

        return {
            dataset: { fx, state: attrs['data-state'] },
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                toggle: (c, val) => {
                    if (val) classes.add(c); else classes.delete(c)
                },
                contains: (c) => classes.has(c),
            },
            getAttribute: (k) => attrs[k] ?? null,
            setAttribute: (k, v) => { attrs[k] = String(v) },
        }
    }

    // Harness mirroring toggleFx in js/app.js
    function runToggleFx(fxName, btn, compositorMock, forceState) {
        const fx = btn ? btn.dataset.fx : fxName
        if (fx === 'flash') {
            compositorMock.flash()
            if (btn) btn.classList.add('flash-active')
            return
        }
        const active = typeof forceState === 'boolean'
            ? forceState
            : (btn ? !btn.classList.contains('active') : !compositorMock[fx])
        if (fx === 'strobe') compositorMock.setStrobe(active)
        else if (fx === 'invert') compositorMock.setInvert(active)
        else if (fx === 'bw') compositorMock.setBW(active)
        else if (fx === 'zoom') compositorMock.setZoom(active)
        else if (fx === 'freeze') compositorMock.setFreeze(active)

        if (btn) {
            btn.classList.toggle('active', active)
            btn.setAttribute('aria-pressed', active ? 'true' : 'false')
            btn.dataset.state = active ? 'on' : 'off'
        }
    }

    const compositorMock = {
        strobe: false,
        invert: false,
        flashed: false,
        setStrobe(val) { this.strobe = val },
        setInvert(val) { this.invert = val },
        flash() { this.flashed = true },
    }

    const strobeBtn = createMockFxButton('strobe')
    assert.equal(strobeBtn.getAttribute('aria-pressed'), 'false')
    assert.equal(strobeBtn.dataset.state, 'off')
    assert.equal(strobeBtn.classList.contains('active'), false)

    // Toggle ON
    runToggleFx('strobe', strobeBtn, compositorMock)
    assert.equal(compositorMock.strobe, true)
    assert.equal(strobeBtn.classList.contains('active'), true)
    assert.equal(strobeBtn.getAttribute('aria-pressed'), 'true')
    assert.equal(strobeBtn.dataset.state, 'on')

    // Toggle OFF
    runToggleFx('strobe', strobeBtn, compositorMock)
    assert.equal(compositorMock.strobe, false)
    assert.equal(strobeBtn.classList.contains('active'), false)
    assert.equal(strobeBtn.getAttribute('aria-pressed'), 'false')
    assert.equal(strobeBtn.dataset.state, 'off')

    // Force state ON (scene recall)
    runToggleFx('strobe', strobeBtn, compositorMock, true)
    assert.equal(compositorMock.strobe, true)
    assert.equal(strobeBtn.classList.contains('active'), true)
    assert.equal(strobeBtn.getAttribute('aria-pressed'), 'true')
    assert.equal(strobeBtn.dataset.state, 'on')

    // Force state OFF (scene recall)
    runToggleFx('strobe', strobeBtn, compositorMock, false)
    assert.equal(compositorMock.strobe, false)
    assert.equal(strobeBtn.classList.contains('active'), false)
    assert.equal(strobeBtn.getAttribute('aria-pressed'), 'false')
    assert.equal(strobeBtn.dataset.state, 'off')

    // DOM-less fallback (e.g. headless window.__visualize.toggleFx calls)
    runToggleFx('invert', null, compositorMock)
    assert.equal(compositorMock.invert, true)
    runToggleFx('invert', null, compositorMock)
    assert.equal(compositorMock.invert, false)

    // Momentary flash
    const flashBtn = createMockFxButton('flash')
    runToggleFx('flash', flashBtn, compositorMock)
    assert.equal(compositorMock.flashed, true)
    assert.equal(flashBtn.classList.contains('flash-active'), true)
    assert.equal(flashBtn.classList.contains('active'), false)
    assert.equal(flashBtn.getAttribute('aria-pressed'), null)
})
