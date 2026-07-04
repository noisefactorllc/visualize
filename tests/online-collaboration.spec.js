// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { routeHandfishLocal } from './handfishLocal.js'
import { FakeSeanceServer, routeSeanceSdkLocal } from './seanceLocal.js'

test.describe.configure({ timeout: 120_000, retries: 0 })

const DSL_A1 = 'search synth, render\n\nnoise(seed: 101, ridges: true)\n  .write(o0)\n\nrender(o0)'
const DSL_A2 = 'search synth, render\n\nnoise(seed: 202, ridges: false)\n  .write(o0)\n\nrender(o0)'
const DSL_B1 = 'search synth, render\n\nnoise(seed: 303, speed: 0.18)\n  .write(o0)\n\nrender(o0)'
const DSL_B2 = 'search synth, render\n\nnoise(seed: 404, speed: 0.32)\n  .write(o0)\n\nrender(o0)'
const INVALID_DSL = 'this is not valid noisemaker dsl'
const ONLINE_FEATURE = 'onlineCollaboration'

const LIGHT_PROGRAMS = [
    { title: 'Online A1', tagline: 'test program', tint: '#4ea8ff', tags: ['abstract'], category: 'abstract', dsl: DSL_A1 },
    { title: 'Online A2', tagline: 'test program', tint: '#7ddf96', tags: ['abstract'], category: 'abstract', dsl: DSL_A2 },
    { title: 'Online B1', tagline: 'test program', tint: '#ff6b8a', tags: ['abstract'], category: 'abstract', dsl: DSL_B1 },
    { title: 'Online B2', tagline: 'test program', tint: '#ffd24e', tags: ['abstract'], category: 'abstract', dsl: DSL_B2 },
]

function withOnlineFeature(path = '/') {
    const url = new URL(path, 'http://localhost:3070')
    url.searchParams.set('features', ONLINE_FEATURE)
    return `${url.pathname}${url.search}`
}

async function newOnlinePage(context, server, path = '/', { online = true } = {}) {
    const page = await context.newPage()
    await routeHandfishLocal(page)
    await routeSeanceSdkLocal(page)
    await server.install(page)
    await page.route('**/data/programs.json', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(LIGHT_PROGRAMS),
        })
    })
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto(online ? withOnlineFeature(path) : path)
    await page.click('#boot-start')
    if (online) {
        await page.waitForFunction(() =>
            !!window.__visualize?.online?.ready,
            null,
            { timeout: 45_000 }
        )
    } else {
        await page.waitForFunction(() => !!window.__visualize?.decks?.A?.currentDsl, null, { timeout: 45_000 })
    }
    return page
}

async function openEditor(page, deckId) {
    const selector = `.deck[data-deck="${deckId}"] .deck-editor`
    const hidden = await page.locator(selector).evaluate(el => el.hidden)
    if (hidden) await page.click(`.deck[data-deck="${deckId}"] .deck-edit-toggle`)
    await expect(page.locator(selector)).toBeVisible()
}

async function setEditorText(page, deckId, text) {
    await openEditor(page, deckId)
    await page.locator(`.deck[data-deck="${deckId}"] code-editor`).evaluate((editor, value) => {
        editor.value = value
        editor.dispatchEvent(new Event('input', { bubbles: true }))
    }, text)
}

async function editorText(page, deckId) {
    return page.locator(`.deck[data-deck="${deckId}"] code-editor`).evaluate(editor => editor.value)
}

async function currentDsl(page, deckId) {
    return page.evaluate(id => window.__visualize.decks[id].currentDsl, deckId)
}

async function takeOnline(page) {
    await page.click('#online-take')
    await expect(page.locator('#online-session-status')).toContainText('Online', { timeout: 30_000 })
    return page.evaluate(() => window.__visualize.online.getSessionId())
}

async function waitForOnlineJoin(page) {
    await expect(page.locator('#online-session-status')).toContainText('Online', { timeout: 30_000 })
    await page.waitForFunction(() => window.__visualize.online.getStatus() === 'online', null, { timeout: 30_000 })
}

test('deck A and deck B sync independently in one Seance session', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        const sessionId = await takeOnline(host)

        const guest = await newOnlinePage(context, server, `/?seance=${sessionId}`)
        await waitForOnlineJoin(guest)
        await openEditor(host, 'A')
        await openEditor(host, 'B')
        await openEditor(guest, 'A')
        await openEditor(guest, 'B')

        const originalGuestB = await editorText(guest, 'B')
        await setEditorText(host, 'A', DSL_A1)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)
        await expect.poll(() => currentDsl(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)
        expect(await editorText(guest, 'B')).toBe(originalGuestB)

        await setEditorText(host, 'B', DSL_B1)
        await expect.poll(() => editorText(guest, 'B'), { timeout: 45_000 }).toBe(DSL_B1)
        await expect.poll(() => currentDsl(guest, 'B'), { timeout: 45_000 }).toBe(DSL_B1)
        expect(await editorText(guest, 'A')).toBe(DSL_A1)
    } finally {
        await context.close()
    }
})

test('online collaboration controls are hidden and ?seance= is inert without the feature flag', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const page = await newOnlinePage(context, server, '/?seance=JOIN42', { online: false })

        await expect(page.locator('#online-take')).toBeHidden()
        await expect(page.locator('#online-join')).toBeHidden()
        await expect(page.locator('#online-session-status')).toBeHidden()
        expect(await page.evaluate(() => window.__visualize.online?.ready)).toBe(false)
        expect(server.sockets.size).toBe(0)
    } finally {
        await context.close()
    }
})

test('printed Seance URL restores both deck documents', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        await takeOnline(host)
        await setEditorText(host, 'A', DSL_A2)
        await setEditorText(host, 'B', DSL_B2)

        const shareUrl = await host.evaluate(() => window.__visualize.online.getShareUrl())
        expect(shareUrl).toContain('seance=')
        expect(shareUrl).toContain(`features=${ONLINE_FEATURE}`)
        const restorePath = new URL(shareUrl).pathname + new URL(shareUrl).search

        const restored = await newOnlinePage(context, server, restorePath)
        await waitForOnlineJoin(restored)

        await openEditor(restored, 'A')
        await openEditor(restored, 'B')
        await expect.poll(() => editorText(restored, 'A'), { timeout: 45_000 }).toBe(DSL_A2)
        await expect.poll(() => editorText(restored, 'B'), { timeout: 45_000 }).toBe(DSL_B2)
        await expect.poll(() => currentDsl(restored, 'A'), { timeout: 45_000 }).toBe(DSL_A2)
        await expect.poll(() => currentDsl(restored, 'B'), { timeout: 45_000 }).toBe(DSL_B2)
    } finally {
        await context.close()
    }
})

test('Join Session by ID adopts server state', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        const sessionId = await takeOnline(host)
        await setEditorText(host, 'A', DSL_A1)
        await setEditorText(host, 'B', DSL_B1)

        const guest = await newOnlinePage(context, server)
        await pageJoinById(guest, sessionId)
        await waitForOnlineJoin(guest)

        await openEditor(guest, 'A')
        await openEditor(guest, 'B')
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)
        await expect.poll(() => editorText(guest, 'B'), { timeout: 45_000 }).toBe(DSL_B1)
    } finally {
        await context.close()
    }
})

test('joining a different session closes the previous online connection', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const hostOne = await newOnlinePage(context, server)
        const sessionOne = await takeOnline(hostOne)
        await setEditorText(hostOne, 'A', DSL_A1)

        const hostTwo = await newOnlinePage(context, server)
        const sessionTwo = await takeOnline(hostTwo)
        await setEditorText(hostTwo, 'A', DSL_A2)

        const guest = await newOnlinePage(context, server, `/?seance=${sessionOne}`)
        await waitForOnlineJoin(guest)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)

        await pageJoinById(guest, sessionTwo)
        await waitForOnlineJoin(guest)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A2)

        await setEditorText(hostOne, 'A', DSL_B1)
        await guest.waitForTimeout(1000)
        expect(await editorText(guest, 'A')).toBe(DSL_A2)
    } finally {
        await context.close()
    }
})

async function pageJoinById(page, sessionId) {
    await page.click('#online-join')
    const dialog = page.locator('#online-join-dialog dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('input[name="sessionId"]').fill(sessionId)
    await dialog.locator('button[type="submit"]').click()
}

test('Go Offline preserves local editor text and stops publishing edits', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        const sessionId = await takeOnline(host)
        const guest = await newOnlinePage(context, server, `/?seance=${sessionId}`)
        await waitForOnlineJoin(guest)

        await setEditorText(host, 'A', DSL_A1)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)

        await host.click('#online-session-status [data-action="go-offline"]')
        await expect(host.locator('#online-session-status')).toContainText('Offline')
        expect(await editorText(host, 'A')).toBe(DSL_A1)

        await setEditorText(host, 'A', DSL_A2)
        expect(await editorText(host, 'A')).toBe(DSL_A2)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 3_000 }).toBe(DSL_A1)
    } finally {
        await context.close()
    }
})

test('invalid remote DSL updates editor text but preserves last-good deck render', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        const sessionId = await takeOnline(host)
        const guest = await newOnlinePage(context, server, `/?seance=${sessionId}`)
        await waitForOnlineJoin(guest)

        await setEditorText(host, 'A', DSL_A1)
        await expect.poll(() => currentDsl(guest, 'A'), { timeout: 45_000 }).toBe(DSL_A1)

        await setEditorText(host, 'A', INVALID_DSL)
        await expect.poll(() => editorText(guest, 'A'), { timeout: 45_000 }).toBe(INVALID_DSL)
        expect(await currentDsl(guest, 'A')).toBe(DSL_A1)
        await openEditor(guest, 'A')
        expect(await editorText(guest, 'A')).toBe(INVALID_DSL)
        await expect(guest.locator('.deck[data-deck="A"] .deck-editor-error')).toBeVisible()
    } finally {
        await context.close()
    }
})

test('Deck A is the SDK default document for single-editor bindings', async ({ browser }) => {
    const server = new FakeSeanceServer()
    const context = await browser.newContext()
    try {
        const host = await newOnlinePage(context, server)
        const sessionId = await takeOnline(host)
        await setEditorText(host, 'A', DSL_A1)
        await setEditorText(host, 'B', DSL_B1)

        const single = await newOnlinePage(context, server)
        const adoptedText = await single.evaluate(async (id) => {
            const cfg = window.__VISUALIZE_SEANCE_CONFIG__
            const { createOnlineDslLayer } = await import(cfg.sdkUrl)
            const editor = document.createElement('textarea')
            document.body.appendChild(editor)
            const online = createOnlineDslLayer({
                seanceUrl: cfg.seanceUrl,
                fetch: cfg.fetch,
                WebSocket: cfg.WebSocket,
                location: window.location,
                publicAppUrl: window.location.href,
            })
            online.bindEditor(editor)
            window.__singleEditorOnline = { online, editor }
            await online.joinSession(id)
            return editor.value
        }, sessionId)
        expect(adoptedText).toBe(DSL_A1)

        await single.evaluate((next) => {
            const { editor } = window.__singleEditorOnline
            editor.value = next
            editor.dispatchEvent(new Event('input', { bubbles: true }))
        }, DSL_A2)

        await expect.poll(() => currentDsl(host, 'A'), { timeout: 45_000 }).toBe(DSL_A2)
        expect(await currentDsl(host, 'B')).toBe(DSL_B1)
    } finally {
        await context.close()
    }
})
