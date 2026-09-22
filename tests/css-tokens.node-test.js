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
