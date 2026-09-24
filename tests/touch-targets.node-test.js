// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const appCssPath = resolve(process.cwd(), 'css/app.css')
const appCss = readFileSync(appCssPath, 'utf8')

test('touch targets: .quick-cut buttons enforce minimum 44px dimensions and expanded pseudo hit area', () => {
    // Quick-cut buttons (#cut-a, #auto-fade, #cut-b) must meet Handfish 44px touch target discipline
    const quickCutMatch = appCss.match(/\.quick-cut\s*\{([^}]+)\}/)
    assert.ok(quickCutMatch, '.quick-cut rule must exist in app.css')
    const quickCutBody = quickCutMatch[1]

    assert.match(quickCutBody, /min-width:\s*44px/, '.quick-cut must have min-width: 44px')
    assert.match(quickCutBody, /min-height:\s*44px/, '.quick-cut must have min-height: 44px')

    const quickCutAfterMatch = appCss.match(/\.quick-cut::after\s*\{([^}]+)\}/)
    assert.ok(quickCutAfterMatch, '.quick-cut::after pseudo-element must exist for rock-solid tap interception')
    const afterBody = quickCutAfterMatch[1]
    assert.match(afterBody, /min-width:\s*44px/, '.quick-cut::after must guarantee at least 44px width')
    assert.match(afterBody, /min-height:\s*44px/, '.quick-cut::after must guarantee at least 44px height')
})

test('touch targets: button.status-pill provides centered ::after hit target meeting 44x44px minimum', () => {
    // Status pills (Audio, MIDI, Auto-Mixer, Auto-VJ, Scenes, REC) are compact visually
    // but must offer 44x44px touch targets on tablet/touch displays
    const statusPillAfter = appCss.match(/button\.status-pill::after\s*\{([^}]+)\}/)
    assert.ok(statusPillAfter, 'button.status-pill::after must exist')
    const afterBody = statusPillAfter[1]

    assert.match(afterBody, /min-width:\s*44px/, 'button.status-pill::after must have min-width: 44px')
    assert.match(afterBody, /min-height:\s*44px/, 'button.status-pill::after must have min-height: 44px')
    assert.match(afterBody, /position:\s*absolute/, 'button.status-pill::after must be absolute')
})

test('touch targets: .fx-button provides at least 44px min-height for tactile hardware feel and touch accuracy', () => {
    const fxMatch = appCss.match(/\.fx-button\s*\{([^}]+)\}/)
    assert.ok(fxMatch, '.fx-button rule must exist in app.css')
    const fxBody = fxMatch[1]
    assert.match(fxBody, /min-height:\s*44px/, '.fx-button must enforce min-height: 44px')
})

test('touch targets: deck header action buttons provide expanded 44x44px touch targets via ::after', () => {
    // Deck action buttons (random, edit, rebind EQ, rebind MIDI, bandpass)
    const deckAfterMatch = appCss.match(/(\.deck-(?:head-actions\s+button|load-random|edit-toggle|rebind-eq|rebind-midi|bandpass)[^{]*)::after\s*\{([^}]+)\}/)
    assert.ok(deckAfterMatch, 'deck action buttons must have an expanded ::after touch target')
    const afterBody = deckAfterMatch[2]
    assert.match(afterBody, /min-width:\s*44px/, 'deck head buttons ::after must enforce min-width: 44px')
    assert.match(afterBody, /min-height:\s*44px/, 'deck head buttons ::after must enforce min-height: 44px')
})

test('touch targets: tempo bar tap button provides 44x44px touch target', () => {
    // Tempo tap button is touched rhythmically live; must be at least 44x44px
    const tempoTapMatch = appCss.match(/(?:\.vz-tempo\s+\.tempo-bar__tap|\.tempo-bar__tap)[^{]*::after\s*\{([^}]+)\}/)
        || appCss.match(/(?:\.vz-tempo\s+\.tempo-bar__tap|\.tempo-bar__tap)\s*\{([^}]+)\}/)
    assert.ok(tempoTapMatch, 'tempo-bar tap button must have touch target rules in app.css')
    const body = tempoTapMatch[1]
    assert.match(body, /min-width:\s*44px|width:\s*(?:44px|[0-9]{2,}px)/, 'tempo-bar tap must have min-width: 44px')
    assert.match(body, /min-height:\s*44px|height:\s*(?:44px|[0-9]{2,}px)/, 'tempo-bar tap must have min-height: 44px')
})

test('touch targets: preset scene action buttons provide expanded 44x44px touch targets and non-overlapping safety margins', () => {
    // In scenes drawer: rename and delete action buttons
    const sceneActionAfter = appCss.match(/\.scene-row\s+\.sr-actions\s+button::after\s*\{([^}]+)\}/)
        || appCss.match(/\.sr-actions\s+button::after\s*\{([^}]+)\}/)
    assert.ok(sceneActionAfter, 'scene action buttons must have ::after touch target')
    const afterBody = sceneActionAfter[1]
    assert.match(afterBody, /min-width:\s*44px/, 'scene action button ::after must have min-width: 44px')
    assert.match(afterBody, /min-height:\s*44px/, 'scene action button ::after must have min-height: 44px')

    const srActionsMatch = appCss.match(/\.scene-row\s+\.sr-actions\s*\{([^}]+)\}/)
    assert.ok(srActionsMatch, '.scene-row .sr-actions rule must exist')
    assert.match(srActionsMatch[1], /gap:\s*var\(--hf-space-2\)/, '.sr-actions must have gap: var(--hf-space-2) to prevent touch overlap')

    const srDeleteMatch = appCss.match(/\.scene-row\s+\.sr-delete\s*\{([^}]+)\}/)
    assert.ok(srDeleteMatch, '.scene-row .sr-delete rule must exist')
    assert.match(srDeleteMatch[1], /margin-left:\s*var\(--hf-space-2\)/, '.sr-delete must have margin-left: var(--hf-space-2) as a destructive action safety margin')
})

test('touch targets: deck head actions enforce var(--hf-space-2) spacing to prevent touch overlap', () => {
    const deckHeadActions = appCss.match(/\.deck-head-actions\s*\{([^}]+)\}/)
    assert.ok(deckHeadActions, '.deck-head-actions rule must exist')
    assert.match(deckHeadActions[1], /gap:\s*var\(--hf-space-2\)/, '.deck-head-actions must have gap: var(--hf-space-2)')
})

test('touch targets: zero !important across all touch target rules', () => {
    const targetSelectors = [
        /\.quick-cut[^{]*\{[^}]+\}/g,
        /button\.status-pill[^{]*\{[^}]+\}/g,
        /\.deck-(?:load-random|edit-toggle|rebind-eq|rebind-midi|bandpass)[^{]*\{[^}]+\}/g,
        /\.fx-button[^{]*\{[^}]+\}/g,
        /\.tempo-bar__tap[^{]*\{[^}]+\}/g,
        /\.scene-row\s+\.sr-actions[^{]*\{[^}]+\}/g,
    ]
    for (const pattern of targetSelectors) {
        const matches = appCss.match(pattern) || []
        for (const block of matches) {
            assert.doesNotMatch(block, /!important/, `rule block "${block.slice(0, 30)}..." must not contain !important`)
        }
    }
})
