// SPDX-License-Identifier: MIT
/**
 * Verifies the library renders as collapsible category sections in the
 * expected order, that all sections open by default, and that section
 * toggles work.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

// Serve the local handfish build (with <tempo-bar> + industrial.css) when
// HANDFISH_LOCAL is set; otherwise hit the real CDN. No machine path committed.
installHandfishLocal(test)

const EXPECTED_ORDER = [
    'user', 'curated', 'util',
]

test('library renders sectioned + ordered', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/')

    // Wait for curated categories to appear (loaded from programs.json).
    await page.waitForSelector('.lib-section[data-category="curated"]', { timeout: 30_000 * SCALE })

    const sections = await page.$$eval('.lib-section', els =>
        els.map(el => el.dataset.category))

    // Sections appear in the configured order. Sections with no
    // matching programs are simply omitted; this assertion verifies
    // ordering on the categories that DO render.
    const ordered = sections.filter(c => EXPECTED_ORDER.includes(c))
    const expectedSubset = EXPECTED_ORDER.filter(c => sections.includes(c))
    expect(ordered).toEqual(expectedSubset)

    // `user` only renders when the operator has imported portable
    // effects; with a clean IndexedDB it's correctly absent. Every
    // other category ships populated by default and must be present.
    const REQUIRED_SECTIONS = EXPECTED_ORDER.filter(c => c !== 'user')
    for (const cat of REQUIRED_SECTIONS) {
        expect(sections, `missing section: ${cat}`).toContain(cat)
    }

    expect(sections).not.toContain('user')

    // All sections open by default
    const allOpen = await page.$$eval('.lib-section', els => els.every(el => el.open))
    expect(allOpen).toBe(true)

    // Summary toggles a section
    await page.click('.lib-section[data-category="curated"] > summary')
    const builtInOpen = await page.$eval(
        '.lib-section[data-category="curated"]',
        el => el.open
    )
    expect(builtInOpen).toBe(false)

    // Cards land in the right section. Util programs (camera, solid,
    // scope) should NOT appear in the curated grid.
    const utilTitlesInUtilSection = await page.$$eval(
        '.lib-section[data-category="util"] .program-card',
        els => els.map(el => el.dataset.title)
    )
    expect(utilTitlesInUtilSection.length).toBeGreaterThan(0)

    const utilTitlesInBuiltIn = await page.$$eval(
        '.lib-section[data-category="curated"] .program-card',
        els => els.map(el => el.dataset.title)
    )
    for (const title of utilTitlesInUtilSection) {
        expect(utilTitlesInBuiltIn).not.toContain(title)
    }

    const curatedTitles = await page.$$eval(
        '.lib-section[data-category="curated"] .program-card',
        els => els.map(el => el.dataset.title)
    )
    expect(curatedTitles).toHaveLength(157)
    expect(curatedTitles).toContain('chaos voxicles 2')
    expect(curatedTitles).toContain('aqua fresh')
    expect(curatedTitles).not.toContain('Bass Bloom')

    // Footer count reflects the sum across sections
    const libCount = await page.textContent('#library-count')
    const totalCards = await page.$$eval('.program-card', els => els.length)
    expect(libCount).toContain(String(totalCards))

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
})
