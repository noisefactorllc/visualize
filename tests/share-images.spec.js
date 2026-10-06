// SPDX-License-Identifier: MIT
/**
 * A shared image program opens with its image. The share is made on a real
 * local sharing server (the sibling ../sharing checkout, or SHARING_SERVER):
 * a solid-red PNG is uploaded as a file and a program names it as
 * `image:<id>`. Visualize opens ?code= as a user does, loads the composition
 * with ?images=files, reads the image file as binary, and the deck draws red,
 * not the default media image. No request the page sends and no sharing API
 * response carries the image as text.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import {
    IMAGE_TEXT, SHARING_ORIGIN, routeSharing, seedComposition, sharingServerAvailable, sharingServerPath, solidPng, startSharingServer,
} from './sharingLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 180_000 * SCALE, retries: 0 })

const RED = solidPng([255, 0, 0])
const imageDsl = id => `search synth\nmedia(url: "image:${id}").write(o0)\nrender(o0)`

function deckPixel(page, deckId) {
    return page.evaluate(id => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(window.__visualize.decks[id].canvas, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }, deckId)
}

test.describe('shared image programs', () => {
    test.skip(!sharingServerAvailable, `needs the sharing server at ${sharingServerPath} (set SHARING_SERVER)`)

    let server
    test.beforeAll(async () => { server = await startSharingServer() })
    test.afterAll(async () => { await server?.stop() })

    test('?code= opens the shared image program with its image file in the chosen deck', async ({ page, baseURL }) => {
        const code = await seedComposition(server, { dsl: imageDsl(RED.id), title: 'red image share', images: [RED] })

        // The service keeps only the id; the image is a file.
        const plain = await (await fetch(`${server.url}/api/composition/${code}`)).json()
        expect(plain.dsl).not.toContain(RED.id)

        await routeHandfishLocal(page)
        await routeEngineLocal(page)
        const traffic = await routeSharing(page, server, new URL(baseURL).origin)
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))

        await page.goto(`/?code=${code}`)
        await expect(page.locator('#boot-share-prompt')).toContainText('red image share', { timeout: 30_000 * SCALE })
        await expect(page.locator('#boot-share-b')).toBeEnabled()
        await page.click('#boot-share-b')
        await page.waitForFunction(() => document.getElementById('deck-b-name')?.textContent === 'red image share',
            null, { timeout: 60_000 * SCALE })

        expect(await page.evaluate(() => window.__visualize.decks.B.currentDsl)).toContain(`image:${RED.id}`)
        await expect.poll(() => deckPixel(page, 'B'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        console.log('deck B pixel:', JSON.stringify(await deckPixel(page, 'B')))

        // The composition was read with ?images=files and the image as a binary file.
        const composition = traffic.responses.find(r => r.url.includes(`/api/composition/${code}`))
        expect(new URL(composition.url).searchParams.get('images')).toBe('files')
        const image = traffic.responses.find(r => r.url === `${SHARING_ORIGIN}/api/images/${RED.id}`)
        expect(image.status).toBe(200)
        expect(image.type).toBe('image/png')
        expect(Buffer.compare(image.body, RED.bytes)).toBe(0)

        // No image text in any request the page sent or any sharing API response.
        for (const request of traffic.requests) expect(request.body).not.toMatch(IMAGE_TEXT)
        for (const response of traffic.responses.filter(r => new URL(r.url).pathname.startsWith('/api/'))) {
            expect(response.body.toString('latin1')).not.toMatch(IMAGE_TEXT)
        }
        expect(pageErrors, pageErrors.join('\n')).toEqual([])
    })

    test('a shared image that cannot be read draws the default image instead of failing the load', async ({ page, baseURL }) => {
        const code = await seedComposition(server, { dsl: imageDsl(RED.id), title: 'unreadable image share', images: [RED] })
        await routeHandfishLocal(page)
        await routeEngineLocal(page)
        await routeSharing(page, server, new URL(baseURL).origin)
        await page.route(`${SHARING_ORIGIN}/api/images/**`, route => route.fulfill({ status: 503, body: 'unavailable' }))

        await page.goto(`/?code=${code}`)
        await expect(page.locator('#boot-share-a')).toBeEnabled({ timeout: 30_000 * SCALE })
        await page.click('#boot-share-a')
        await page.waitForFunction(() => document.getElementById('deck-a-name')?.textContent === 'unreadable image share',
            null, { timeout: 60_000 * SCALE })
        const dsl = await page.evaluate(() => window.__visualize.decks.A.currentDsl)
        expect(dsl).toContain('media(')
        expect(dsl).not.toContain('image:')
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).not.toEqual([255, 0, 0, 255])
    })
})
