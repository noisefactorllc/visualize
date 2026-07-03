// SPDX-License-Identifier: MIT
//
// Pre-release helper: serve the Handfish CDN from HANDFISH_LOCAL, or from a
// sibling ../handfish/dist checkout when present, so new component APIs can be
// exercised before they ship to handfish.noisefactor.io. No machine path is
// committed; with neither local source available these tests hit the real CDN.
//
// Mirrors the page.route shim from drone-synth/tests/smoke.spec.js. Call
// routeHandfishLocal(page) immediately after a page is created (before the
// first navigation), or use installHandfishLocal(test) to register a
// beforeEach for specs that use the bare { page } fixture.
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

function defaultHandfishLocal() {
    const local = resolve(process.cwd(), '../handfish/dist')
    return existsSync(resolve(local, 'handfish.esm.min.js')) ? local : ''
}

export async function routeHandfishLocal(page) {
    const local = process.env.HANDFISH_LOCAL || defaultHandfishLocal()
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

export function installHandfishLocal(test) {
    test.beforeEach(async ({ page }) => {
        await routeHandfishLocal(page)
    })
}
