// SPDX-License-Identifier: MIT
/**
 * User effects: portable-effect import, persistence, library
 * integration, deletion, and the ?code= path that bundles effects in
 * a shared composition.
 *
 * Fixtures are built in-browser using the app's vendored JSZip so
 * the test stays hermetic (no Node-side zip dep, no on-disk
 * artifact). The trade-off is each test waits for boot + JSZip load
 * before it can stage a zip — small price for not needing a build
 * step.
 */
import { test, expect } from '@playwright/test'

// Engine effect-registration completes over the shader CDN; on slow-CDN
// days the install → "row visible" round-trip is borderline past 15s, so
// every post-install effect-registration wait gets generous headroom —
// zip import AND ?code= share-bundle install (whose preceding deck-title
// wait gates on the composition rendering, NOT on the bundled effect
// registering). Test-only: a genuinely broken install still fails, just
// a bit later.
const REGISTER_TIMEOUT = 30_000

/**
 * Minimal valid portable effect: a starter (no inputs) that paints a
 * solid colour. The shader is intentionally trivial — we don't care
 * whether it compiles cleanly on the test's headless WebGL2 stack,
 * we care that the import/registration/persistence path works.
 *
 * Returns { name, files } where files maps a relative path → text
 * content, matching the shape the manager's processZip emits.
 */
function makeFixture(name = 'testEffect', color = [0.5, 0.2, 0.8]) {
    const definition = {
        name,
        func: name,
        namespace: 'user',
        description: `test fixture ${name}`,
        tags: ['user'],
        globals: {
            intensity: {
                type: 'float',
                default: 1.0,
                uniform: 'u_intensity',
                min: 0,
                max: 2,
                ui: { label: 'intensity', control: 'slider' },
            },
        },
        passes: [
            { name: 'main', program: 'main', outputs: { color: 'outputTex' } },
        ],
    }
    const glsl = `precision highp float;
out vec4 fragColor;
uniform float u_intensity;
void main() {
    fragColor = vec4(${color[0]}, ${color[1]}, ${color[2]}, 1.0) * u_intensity;
}
`
    return { definition, glsl }
}

/**
 * Build a zip Blob inside the browser using the vendored JSZip, then
 * set it as the file input's value and fire the change event so the
 * import handler runs. Cleaner than building the zip in Node and
 * shuttling bytes across — the page already has JSZip.
 */
async function importFixture(page, fixture) {
    await page.evaluate(async ({ defJson, glsl }) => {
        // Ensure JSZip is loaded — the user-effects manager will load
        // it the first time uploadFromZip is called, but for the test
        // fixture build we need it explicitly.
        if (typeof window.JSZip === 'undefined') {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script')
                s.src = 'js/lib/jszip.min.js'
                s.onload = resolve
                s.onerror = reject
                document.head.appendChild(s)
            })
        }
        const zip = new window.JSZip()
        zip.file('definition.json', defJson)
        zip.file('glsl/main.glsl', glsl)
        const blob = await zip.generateAsync({ type: 'blob' })
        const file = new File([blob], `${JSON.parse(defJson).func}.zip`, { type: 'application/zip' })

        // Stash on a known DataTransfer so we can set the file input
        // programmatically (Playwright's setInputFiles wants a host-
        // side path; building in-browser is faster).
        const input = document.getElementById('user-effect-file')
        const dt = new DataTransfer()
        dt.items.add(file)
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
    }, { defJson: JSON.stringify(fixture.definition), glsl: fixture.glsl })
}

/**
 * Build a macOS-Finder-"Compress"-style zip: the real effect under a
 * top-level folder, PLUS the __MACOSX/ AppleDouble sidecars and a
 * .DS_Store that Finder adds. The junk `._definition.json` is written
 * FIRST so it's the first entry whose name ends in "definition.json" —
 * which is exactly the ordering that made the old `endsWith()` detector
 * pick the sidecar (basePath "__MACOSX/<folder>/._") and fail the import.
 */
async function importMacZip(page, fixture, folder = 'macFx') {
    await page.evaluate(async ({ defJson, glsl, folder }) => {
        if (typeof window.JSZip === 'undefined') {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script')
                s.src = 'js/lib/jszip.min.js'
                s.onload = resolve
                s.onerror = reject
                document.head.appendChild(s)
            })
        }
        const zip = new window.JSZip()
        // Junk first — the ordering that broke the old detector.
        zip.file(`__MACOSX/${folder}/._definition.json`, 'AppleDouble-sidecar-not-json')
        zip.file(`__MACOSX/${folder}/glsl/._main.glsl`, 'AppleDouble-sidecar')
        zip.file(`${folder}/.DS_Store`, 'ds-store')
        // Real effect under the top-level folder.
        zip.file(`${folder}/definition.json`, defJson)
        zip.file(`${folder}/glsl/main.glsl`, glsl)
        const blob = await zip.generateAsync({ type: 'blob' })
        const file = new File([blob], `${folder}.zip`, { type: 'application/zip' })
        const input = document.getElementById('user-effect-file')
        const dt = new DataTransfer()
        dt.items.add(file)
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
    }, { defJson: JSON.stringify(fixture.definition), glsl: fixture.glsl, folder })
}

test.describe('user effects', () => {
    test.beforeEach(async ({ page }) => {
        // Clear the user-effects IndexedDB between tests so each runs
        // against a clean slate. indexedDB.deleteDatabase fires
        // onsuccess once any open connections close — we wait for
        // that to ensure subsequent open() lands in a fresh state.
        await page.goto('/')
        await page.evaluate(() => new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase('visualize-user-effects')
            req.onsuccess = resolve
            req.onerror = reject
            req.onblocked = resolve  // best-effort
        }))
    })

    test('import zip → installs, lists, and appears in library user section', async ({ page }) => {
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))

        await page.goto('/')
        await page.click('#boot-start')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent !== '—', { timeout: 30_000 })

        // Open settings, import the fixture.
        await page.click('#settings-toggle')
        await importFixture(page, makeFixture('myTestFx'))

        // Status hint flips to ok; list row shows the new effect id.
        await expect(page.locator('#user-effect-status')).toContainText('installed user/myTestFx', { timeout: REGISTER_TIMEOUT })
        await expect(page.locator('.user-effect-row[data-id="user/myTestFx"]')).toBeVisible()

        // Library now has a "user" section with at least our effect.
        await expect(page.locator('.lib-section[data-category="user"]')).toBeVisible({ timeout: 10_000 })
        // prettify() turns `myTestFx` into `My Test Fx` for the card
        // title — same camelCase-split rule the engine-default cards
        // use (reactionDiffusion → Reaction Diffusion).
        const userCards = await page.$$eval(
            '.lib-section[data-category="user"] .program-card',
            els => els.map(el => el.dataset.title)
        )
        expect(userCards).toContain('My Test Fx')

        expect(pageErrors, pageErrors.join('\n')).toEqual([])
    })

    test('import zip with macOS __MACOSX / AppleDouble sidecars still installs', async ({ page }) => {
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))

        await page.goto('/')
        await page.click('#boot-start')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent !== '—', { timeout: 30_000 })
        await page.click('#settings-toggle')

        // The real <folder>/definition.json must win over the
        // __MACOSX/<folder>/._definition.json sidecar (regression: the
        // old detector matched the sidecar and threw on import).
        await importMacZip(page, makeFixture('macFx'))

        await expect(page.locator('#user-effect-status')).toContainText('installed user/macFx', { timeout: REGISTER_TIMEOUT })
        await expect(page.locator('.user-effect-row[data-id="user/macFx"]')).toBeVisible()
        await expect(page.locator('.lib-section[data-category="user"] .program-card[data-title="Mac Fx"]')).toBeVisible({ timeout: 10_000 })

        expect(pageErrors, pageErrors.join('\n')).toEqual([])
    })

    test('delete user effect → row removed, library updates', async ({ page }) => {
        await page.goto('/')
        await page.click('#boot-start')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent !== '—', { timeout: 30_000 })
        await page.click('#settings-toggle')

        await importFixture(page, makeFixture('disposable'))
        await expect(page.locator('.user-effect-row[data-id="user/disposable"]')).toBeVisible({ timeout: REGISTER_TIMEOUT })

        // Accept the confirm() prompt automatically.
        page.once('dialog', d => d.accept())
        await page.click('.user-effect-row[data-id="user/disposable"] .user-effect-delete')

        await expect(page.locator('.user-effect-row[data-id="user/disposable"]')).toHaveCount(0, { timeout: 10_000 })

        // Library's user section either drops the card or hides
        // entirely (since this was the only user effect). The
        // library re-renders asynchronously after delete (manager
        // emits onChange → app calls library.reloadDefaults +
        // render), so wait for the card to actually leave.
        await expect(
            page.locator('.lib-section[data-category="user"] .program-card[data-title="Disposable"]')
        ).toHaveCount(0, { timeout: 10_000 })
    })

    test('persistence: reload survives an imported effect', async ({ page }) => {
        // Two full boots (import → reload → re-hydrate) push the total past
        // the 120s budget on slow-CDN days; test.slow() triples it. The
        // per-assertion REGISTER_TIMEOUT below covers the registration wait
        // itself — test.slow() scales the overall timeout, not fixed waits.
        test.slow()
        await page.goto('/')
        await page.click('#boot-start')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent !== '—', { timeout: 30_000 })
        await page.click('#settings-toggle')

        await importFixture(page, makeFixture('persisty'))
        await expect(page.locator('.user-effect-row[data-id="user/persisty"]')).toBeVisible({ timeout: REGISTER_TIMEOUT })

        // Reload — boot hydration should re-register the effect.
        await page.reload()
        await page.click('#boot-start')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent !== '—', { timeout: 30_000 })
        await page.click('#settings-toggle')

        await expect(page.locator('.user-effect-row[data-id="user/persisty"]')).toBeVisible({ timeout: 10_000 })

        // And it's back in the library's user section.
        const titles = await page.$$eval(
            '.lib-section[data-category="user"] .program-card',
            els => els.map(el => el.dataset.title)
        )
        expect(titles).toContain('Persisty')
    })

    test('share-loader: ?code= with bundled effect installs + persists', async ({ page }) => {
        const fixture = makeFixture('sharedFx')
        // The sharing API would return effects as an array of payload
        // objects (the same shape uploadFromPayload accepts).
        await page.route('https://sharing.noisedeck.app/api/composition/**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    code: 'WITHFX',
                    title: 'with custom fx',
                    description: '',
                    dsl: fixture.definition.defaultProgram
                        || 'search user, synth, render\n\nnoise().write(o0)\n\nrender(o0)',
                    hasEffects: true,
                    effects: [{
                        name: fixture.definition.name,
                        func: fixture.definition.func,
                        namespace: fixture.definition.namespace,
                        description: fixture.definition.description,
                        tags: fixture.definition.tags,
                        globals: fixture.definition.globals,
                        passes: fixture.definition.passes,
                        shaders: { main: { glsl: fixture.glsl } },
                    }],
                }),
            })
        })

        await page.goto('/?code=WITHFX')
        await expect(page.locator('#boot-share-hint')).toContainText('1 custom effect', { timeout: 20_000 })
        await page.click('#boot-share-a')

        // After the gesture: deck A title is the shared title; the
        // user-effects panel lists the bundled effect; library has it.
        await page.waitForFunction(
            () => document.getElementById('deck-a-name')?.textContent === 'with custom fx',
            { timeout: 30_000 }
        )

        await page.click('#settings-toggle')
        await expect(page.locator('.user-effect-row[data-id="user/sharedFx"]')).toBeVisible({ timeout: REGISTER_TIMEOUT })

        // ?code= cleared from URL after the loader finished.
        expect(new URL(page.url()).searchParams.has('code')).toBe(false)
    })
})
