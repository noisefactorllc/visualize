// SPDX-License-Identifier: MIT
/**
 * Global typeface verification. Atkinson Hyperlegible is the project-wide
 * font — leaned into across every theme and loaded with zero layout shift
 * via its metric-matched Blank companion. Guards against a future theme or
 * handfish change silently overriding the global font. Verifies:
 *
 *   1. The default chain resolves to 'Atkinson Hyperlegible' → its Blank.
 *   2. The !important global override beats a theme's own --hf-font-family
 *      (inject a Cabin rule like 'dusk' ships; Atkinson must still win).
 *   3. All four real Atkinson faces (Regular/Bold/Italic/BoldItalic) are
 *      declared, and the Regular face actually loads from the CDN.
 *   4. Mono is untouched (Noto Sans Mono) so the code editor / DSL stay
 *      monospace.
 */
import { test, expect } from '@playwright/test'

test.describe.configure({ timeout: 120_000, retries: 1 })

test('global font: Atkinson Hyperlegible wins across themes, zero-CLS chain', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize, null, { timeout: 30_000 })

    // 1. Default chain is Atkinson → Atkinson Blank.
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(bodyFont).toMatch(/Atkinson Hyperlegible/)
    expect(bodyFont).toMatch(/Atkinson Hyperlegible Blank/)

    // 4. Mono untouched.
    const monoVar = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--hf-font-family-mono'))
    expect(monoVar).toMatch(/Noto Sans Mono/)

    // 2. Inject a competing theme rule (as handfish 'dusk' would) and confirm
    //    the !important global override still wins.
    await page.evaluate(() => {
        const s = document.createElement('style')
        s.textContent = `[data-theme="dusk"]{--hf-font-family:'Cabin','Cabin Blank';}`
        document.head.appendChild(s)
        document.documentElement.dataset.theme = 'dusk'
    })
    const themedFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily)
    expect(themedFont).toMatch(/Atkinson Hyperlegible/)
    expect(themedFont).not.toMatch(/Cabin/)

    // 3. All four real Atkinson faces declared (subset — the active theme may
    //    add its own), and the Regular face actually loads.
    const faces = await page.evaluate(() => {
        const out = []
        document.fonts.forEach(f => {
            if (f.family === 'Atkinson Hyperlegible') out.push(`${f.weight}/${f.style}`)
        })
        return out
    })
    for (const want of ['400/normal', '700/normal', '400/italic', '700/italic']) {
        expect(faces).toContain(want)
    }

    await page.waitForFunction(() =>
        document.fonts.check('16px "Atkinson Hyperlegible"'),
        null, { timeout: 20_000 })

    await context.close()
})
