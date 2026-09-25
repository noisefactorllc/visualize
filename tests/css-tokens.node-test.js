// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

test('css/app.css contains zero raw hex literals', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')
    const codeOnly = stripCssComments(rawCss)

    const hexMatches = codeOnly.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    assert.deepEqual(
        hexMatches,
        [],
        `Found raw hex color literals in css/app.css: ${hexMatches.join(', ')}. Use semantic Handfish --hf-* tokens.`
    )
})

test('css/app.css contains zero !important declarations', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')
    const codeOnly = stripCssComments(rawCss)

    const importantMatches = codeOnly.match(/!important/g) || []
    assert.deepEqual(
        importantMatches,
        [],
        `Found !important in css/app.css (${importantMatches.length} occurrences). Handfish enforces zero-!important styling.`
    )
})

test('css/app.css contains zero raw rgb or rgba function calls', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')
    const codeOnly = stripCssComments(rawCss)

    const rgbMatches = codeOnly.match(/\brgba?\s*\(/g) || []
    assert.deepEqual(
        rgbMatches,
        [],
        `Found raw rgb/rgba calls in css/app.css: ${rgbMatches.join(', ')}. Use color-mix with --hf-* tokens or Handfish semantic tokens.`
    )
})

test('css/app.css uses semantic Handfish tokens for key UI elements', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')

    // Deck meta uses Handfish text tokens within their rule block
    assert.match(rawCss, /\.deck-meta \.deck-program\s*\{[^}]*var\(--hf-text-bright\)/)
    assert.match(rawCss, /\.deck-meta \.deck-tagline\s*\{[^}]*var\(--hf-text-dim\)/)

    // Program card overlay uses semantic background and text tokens
    assert.match(rawCss, /\.program-card \.pc-overlay\s*\{[^}]*var\(--hf-text-bright\)/)
    assert.match(rawCss, /\.program-card \.pc-overlay\s*\{[^}]*var\(--hf-bg-base\)/)

    // Deck error uses semantic error red
    assert.match(rawCss, /\.deck-editor-error\s*\{[^}]*var\(--hf-red\)/)

    // Sync output dialog uses semantic shadow, backdrop, and badge tokens
    assert.match(rawCss, /\.sync-output-dialog\s*\{[^}]*var\(--hf-shadow-xl\)/)
    assert.match(rawCss, /\.sync-output-dialog::backdrop\s*\{[^}]*var\(--hf-backdrop\)/)
    assert.match(rawCss, /\.sync-output-live\s*\{[^}]*var\(--hf-red\)/)

    // Native range sliders use semantic accent, full radius, and semantic shadows
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)\s*\{[^}]*var\(--hf-accent\)/)
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)::-webkit-slider-thumb\s*\{[^}]*var\(--hf-radius-full\)/)
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)::-webkit-slider-thumb\s*\{[^}]*var\(--hf-shadow-sm\)/)
})

test('index.html mobile guard adheres to Handfish token conventions', () => {
    const htmlPath = resolve(process.cwd(), 'index.html')
    const html = readFileSync(htmlPath, 'utf8')

    const guardMatch = html.match(/<div id="mobile-guard"[\s\S]*?<\/div>/)
    assert.ok(guardMatch, 'mobile-guard element subtree should exist in index.html')
    const guardSubtree = guardMatch[0]

    assert.doesNotMatch(
        guardSubtree,
        /#[0-9a-fA-F]{3,8}/,
        'mobile-guard subtree should not contain raw hex fallbacks'
    )
    assert.match(guardSubtree, /var\(--hf-bg-base\)/)
    assert.match(guardSubtree, /var\(--hf-text-normal\)/)
    assert.match(guardSubtree, /var\(--hf-radius-lg\)/)
    assert.match(guardSubtree, /var\(--hf-link-color,\s*var\(--hf-accent\)\)/)
})

test('audio band meters maintain high contrast and accessibility semantics across themes', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')
    const htmlPath = resolve(process.cwd(), 'index.html')
    const html = readFileSync(htmlPath, 'utf8')

    // Track trough has defined border, background, and radius tokens
    assert.match(rawCss, /\.main-meter\s*\{[^}]*gap:\s*var\(--hf-space-1\)/)
    assert.match(rawCss, /\.audio-band\s*\{[^}]*height:\s*var\(--hf-space-2\)/)
    assert.match(rawCss, /\.audio-band\s*\{[^}]*background:\s*var\(--hf-bg-base\)/)
    assert.match(rawCss, /\.audio-band\s*\{[^}]*border:\s*var\(--hf-border-width\)\s+solid\s+var\(--hf-border\)/)
    assert.match(rawCss, /\.audio-band\s*\{[^}]*border-radius:\s*var\(--hf-radius-sm\)/)
    assert.match(rawCss, /\.audio-band\s*\{[^}]*box-shadow:[^}]*var\(--hf-border-subtle\)/)

    // Audio band fills use Handfish semantic color tokens
    assert.match(rawCss, /\.audio-band\.low\s+b\s*\{[^}]*background:\s*var\(--hf-blue\)/)
    assert.match(rawCss, /\.audio-band\.mid\s+b\s*\{[^}]*background:\s*var\(--hf-accent\)/)
    assert.match(rawCss, /\.audio-band\.high\s+b\s*\{[^}]*background:\s*var\(--hf-red\)/)

    // index.html carries accessible role and descriptive band labels with Handfish tooltips
    assert.match(html, /<span\s+class="main-meter"\s+role="group"\s+aria-label="Audio level meters:[^"]*">/)
    assert.match(html, /class="[^"]*\baudio-band\s+low\s+tooltip\b[^"]*"[^>]*id="meter-low"[^>]*data-title="Low \/ Bass \(0–200 Hz\)"/)
    assert.match(html, /class="[^"]*\baudio-band\s+mid\s+tooltip\b[^"]*"[^>]*id="meter-mid"[^>]*data-title="Mid \(200–2000 Hz\)"/)
    assert.match(html, /class="[^"]*\baudio-band\s+high\s+tooltip\b[^"]*"[^>]*id="meter-high"[^>]*data-title="High \/ Treble \(2000\+ Hz\)"/)
})

test('native range sliders and speed faders maintain high-contrast track boundaries and distinct thumb rings', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')

    // Track trough uses structured background and border token for contrast across light and dark themes
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)\s*\{[^}]*border:\s*var\(--hf-border-width\)\s+solid\s+var\(--hf-border-subtle\)/)
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--hf-accent\)\s+15%,\s*var\(--hf-bg-base\)\)/)

    // Slider thumb has distinct contrast ring separating thumb from track and background
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)::-webkit-slider-thumb\s*\{[^}]*border:\s*2px\s+solid\s+var\(--hf-bg-surface\)/)
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\)::-moz-range-thumb\s*\{[^}]*border:\s*2px\s+solid\s+var\(--hf-bg-surface\)/)

    // Active dragging state sets grabbing cursor on both WebKit and Gecko
    assert.match(rawCss, /input\[type="range"\]:not\(\.slider\):active::-moz-range-thumb\s*\{[^}]*cursor:\s*grabbing;/)
})

test('program card tiles maintain readable contrast over shader previews across themes', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')

    // Scrim overlay uses high-contrast bottom-up gradient and backdrop blur
    assert.match(rawCss, /\.program-card\s+\.pc-overlay\s*\{[^}]*backdrop-filter:\s*blur\(2px\)/)

    // Program title and tagline use solid semantic text tokens
    assert.match(rawCss, /\.program-card\s+\.pc-title\s*\{[^}]*color:\s*var\(--hf-text-bright\)/)
    assert.match(rawCss, /\.program-card\s+\.pc-tagline\s*\{[^}]*color:\s*var\(--hf-text-normal\)/)

    // Program load buttons use solid elevated background token rather than raw translucent mix
    assert.match(rawCss, /\.program-card\s+\.pc-load\s*\{[^}]*background:\s*var\(--hf-bg-elevated\)/)
    assert.match(rawCss, /\.program-card\s+\.pc-load\s*\{[^}]*border:\s*var\(--hf-border-width\)\s+solid\s+var\(--hf-border-subtle\)/)
    assert.match(rawCss, /\.program-card\s+\.pc-load:hover\s*\{[^}]*background:\s*var\(--hf-accent\)/)
})

test('FX buttons and surface overlays follow Handfish spacing and z-index token discipline', () => {
    const cssPath = resolve(process.cwd(), 'css/app.css')
    const rawCss = readFileSync(cssPath, 'utf8')

    // FX button padding adheres to Handfish spacing scale
    assert.match(rawCss, /\.fx-button\s*\{[^}]*padding:\s*var\(--hf-space-1\)/)

    // Overlays, sticky rails, and popovers strictly use Handfish z-index scale
    assert.match(rawCss, /\.topbar\s*\{[^}]*z-index:\s*var\(--hf-z-sticky,\s*200\)/)
    assert.match(rawCss, /\.toast\s*\{[^}]*z-index:\s*var\(--hf-z-popover,\s*600\)/)
    assert.match(rawCss, /\.mixer-controls:has\(select-dropdown\.dropdown-open\)\s*\{[^}]*z-index:\s*var\(--hf-z-dropdown,\s*100\)/)
    assert.match(rawCss, /#app\.fullscreen-main\s+\.main\s*\{[^}]*z-index:\s*var\(--hf-z-fixed,\s*300\)/)
})


