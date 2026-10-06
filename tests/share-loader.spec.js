// SPDX-License-Identifier: MIT
/**
 * Share-loader path: when the URL carries ?code=, the boot dialog
 * swaps to a "Load program {title} into which deck?" prompt with two
 * deck-tinted buttons. Picking a deck loads the shared composition
 * into that deck and strips ?code= from the URL.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
import { IMAGE_TEXT, solidPng } from './sharingLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

// Serve the local handfish build (with <tempo-bar> + industrial.css) when
// HANDFISH_LOCAL is set; otherwise hit the real CDN. No machine path committed.
installHandfishLocal(test)

const SAMPLE_DSL = 'search synth, render\n\nnoise(seed: 7, ridges: true)\n  .write(o0)\n\nrender(o0)'
const SAMPLE_TITLE = 'sample share program'

test('share-loader: ?code= → pick B → deck B has shared program', async ({ page }) => {
    // Stub the sharing API so the test stays hermetic — no dependency
    // on the live sharing.noisedeck.app service or whatever DSL its
    // database happens to hold.
    await page.route('https://sharing.noisedeck.app/api/composition/**', async (route) => {
        const url = new URL(route.request().url())
        expect(url.searchParams.get('images')).toBe('files')
        const code = url.pathname.split('/').pop()
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code,
                title: SAMPLE_TITLE,
                description: 'a thing',
                dsl: SAMPLE_DSL,
                hasEffects: false,
                effects: [],
            }),
        })
    })

    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto('/?code=TESTXYZ')

    // Default boot UI hides; share UI shows
    await expect(page.locator('#boot-default')).toBeHidden()
    await expect(page.locator('#boot-share')).toBeVisible()

    // Wait for the prompt to populate with the fetched title and for
    // the deck buttons to become clickable.
    await expect(page.locator('#boot-share-prompt')).toContainText(SAMPLE_TITLE, { timeout: 20_000 * SCALE })
    await expect(page.locator('#boot-share-a')).toBeEnabled()
    await expect(page.locator('#boot-share-b')).toBeEnabled()

    // Pick B. Wait for the post-gesture loadProgram to land its label.
    await page.click('#boot-share-b')

    await page.waitForFunction(
        (expected) => document.getElementById('deck-b-name')?.textContent === expected,
        SAMPLE_TITLE,
        { timeout: 30_000 * SCALE }
    )

    // Deck A should have its random initial pick — not the shared one.
    const deckAName = await page.textContent('#deck-a-name')
    expect(deckAName).not.toBe(SAMPLE_TITLE)
    expect(deckAName).not.toBe('—')

    // ?code= stripped from the URL so a reload doesn't re-prompt.
    expect(new URL(page.url()).searchParams.has('code')).toBe(false)

    expect(pageErrors, pageErrors.join('\n')).toEqual([])
})

test('share-loader: image files listed with the composition are read as binary and drawn', async ({ page }) => {
    const red = solidPng([255, 0, 0])
    const sent = []
    page.on('request', request => sent.push(request.postData() || ''))
    await page.route('https://sharing.noisedeck.app/api/composition/**', async (route) => {
        expect(new URL(route.request().url()).searchParams.get('images')).toBe('files')
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 'REDIMG',
                title: 'shared red image',
                dsl: `search synth\nmedia(url: "image:${red.id}").write(o0)\nrender(o0)`,
                hasEffects: false,
                effects: [],
                images: [{ id: red.id, url: `https://sharing.noisedeck.app/api/images/${red.id}`, mimeType: 'image/png', width: 2, height: 2 }],
            }),
        })
    })
    let imageReads = 0
    await page.route(`https://sharing.noisedeck.app/api/images/${red.id}`, async (route) => {
        imageReads++
        await route.fulfill({ status: 200, contentType: 'image/png', body: red.bytes })
    })

    await page.goto('/?code=REDIMG')
    await expect(page.locator('#boot-share-a')).toBeEnabled({ timeout: 20_000 * SCALE })
    await page.click('#boot-share-a')
    await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent === 'shared red image',
        null, { timeout: 30_000 * SCALE })
    await expect.poll(() => page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(window.__visualize.decks.A.canvas, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
    expect(imageReads).toBe(1)
    for (const body of sent) expect(body).not.toMatch(IMAGE_TEXT)
})

test('share-loader: composition with hasEffects=true announces install', async ({ page }) => {
    await page.route('https://sharing.noisedeck.app/api/composition/**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                code: 'CUSTOMFX',
                title: 'has portable effects',
                dsl: 'search synth, render\n\nnoise().write(o0)\n\nrender(o0)',
                hasEffects: true,
                effects: [{
                    name: 'fakeFx', func: 'fakeFx', namespace: 'user',
                    description: 'demo', tags: ['user'],
                    globals: {}, passes: [], shaders: {},
                }],
            }),
        })
    })

    await page.goto('/?code=CUSTOMFX')

    // Buttons are enabled; hint mentions the bundled-effects install.
    await expect(page.locator('#boot-share-prompt')).toContainText('has portable effects', { timeout: 20_000 * SCALE })
    await expect(page.locator('#boot-share-hint')).toContainText('1 custom effect')
    await expect(page.locator('#boot-share-a')).toBeEnabled()
    await expect(page.locator('#boot-share-b')).toBeEnabled()
})

test('share-loader: failed fetch surfaces the error inline', async ({ page }) => {
    await page.route('https://sharing.noisedeck.app/api/composition/**', async (route) => {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })
    })

    await page.goto('/?code=MISSING')

    await expect(page.locator('#boot-share-prompt')).toContainText('MISSING', { timeout: 20_000 * SCALE })
    await expect(page.locator('#boot-share-a')).toBeDisabled()
    await expect(page.locator('#boot-share-b')).toBeDisabled()
})

test('no ?code= keeps the original single start button', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#boot-default')).toBeVisible()
    await expect(page.locator('#boot-share')).toBeHidden()
    await expect(page.locator('#boot-start')).toBeVisible()
})
