// SPDX-License-Identifier: MIT
//
// Use the published Handfish CDN unless a local distribution is explicitly
// selected with HANDFISH_DIST or HANDFISH_LOCAL. An unrelated sibling build
// must not silently replace the published components under test.
//
// Mirrors the page.route shim from drone-synth/tests/smoke.spec.js. Call
// routeHandfishLocal(page) immediately after a page is created (before the
// first navigation), or use installHandfishLocal(test) to register a
// beforeEach for specs that use the bare { page } fixture.
import { readFileSync } from 'fs'
import { resolve } from 'path'

export async function routeHandfishLocal(page) {
    const local = process.env.HANDFISH_DIST || process.env.HANDFISH_LOCAL || ''
    if (!local) return
    await page.route('https://handfish.noisefactor.io/0/**', async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\/0\//, '')
        try {
            const body = readFileSync(resolve(local, rel))
            const type = rel.endsWith('.css')
                ? 'text/css'
                : rel.endsWith('.js')
                    ? 'text/javascript'
                    : 'application/octet-stream'
            await route.fulfill({ status: 200, contentType: type, body })
        } catch {
            await route.fulfill({ status: 404, body: 'missing ' + rel })
        }
    })
}

export async function routeEngineLocal(page) {
    const local = process.env.ENGINE_LOCAL || ''
    if (!local) return
    await page.route('https://shaders.noisedeck.app/**', async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\//, '')
        try {
            const body = readFileSync(resolve(local, rel))
            await route.fulfill({ status: 200, contentType: 'text/javascript', body })
        } catch {
            await route.fulfill({ status: 404, body: 'missing ' + rel })
        }
    })
}

export function installHandfishLocal(test) {
    test.beforeEach(async ({ page }) => {
        await routeHandfishLocal(page)
    })
}
