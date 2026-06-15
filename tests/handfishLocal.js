// SPDX-License-Identifier: MIT
//
// Pre-release helper: when HANDFISH_LOCAL points at a local handfish build
// (e.g. HANDFISH_LOCAL=../handfish/dist), serve the handfish CDN from it so the
// new components (<tempo-bar>, industrial.css, forms.css, menus-and-toolbars.css)
// can be exercised before they ship to handfish.noisefactor.io. No machine path
// is committed; with the env var unset these tests run against the real CDN.
//
// Mirrors the page.route shim from drone-synth/tests/smoke.spec.js. Call
// routeHandfishLocal(page) immediately after a page is created (before the
// first navigation), or use installHandfishLocal(test) to register a
// beforeEach for specs that use the bare { page } fixture.
import { readFileSync } from 'fs'

export async function routeHandfishLocal(page) {
    const local = process.env.HANDFISH_LOCAL
    if (!local) return
    await page.route('https://handfish.noisefactor.io/0/**', async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\/0\//, '')
        try {
            const body = readFileSync(`${local}/${rel}`)
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
