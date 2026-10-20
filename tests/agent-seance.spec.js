// SPDX-License-Identifier: MIT
/**
 * The Seance route of the agent contract: a software agent joins the session
 * that a Visualize tab took online, runs commands in that tab through the
 * agent relay (js/agent/relay.js), and receives the canvas as an image that
 * the tab uploaded to the session as its own bytes. A real local Seance
 * server carries the session (see startSeanceServer in seanceLocal.js).
 */
import { test, expect } from '@playwright/test'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { SeanceAgentClient, routePortableImagesLocal, routeSeanceServer, startSeanceServer } from './seanceLocal.js'
import { solidPng } from './sharingLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 240_000 * SCALE, retries: 0 })

const RED = 'search synth\nsolid(color: [1, 0, 0]).write(o0)\nrender(o0)'
const GREEN = 'search synth\nsolid(color: [0, 1, 0]).write(o0)\nrender(o0)'
const CAMERA = 'search synth\nmedia().write(o0)\nrender(o0)'
const LIGHT_PROGRAMS = [
    { title: 'agent red', tagline: 'test program', tint: '#ff0000', tags: ['abstract'], category: 'abstract', dsl: RED },
    { title: 'agent green', tagline: 'test program', tint: '#00ff00', tags: ['abstract'], category: 'abstract', dsl: GREEN },
    { title: 'Camera Input', tagline: 'utility', tint: '#888888', tags: ['util'], mediaSource: 'camera', dsl: CAMERA },
]
// A 1x1 PNG as a data: URL, which no session request may carry.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function deckPixel(page, deckId) {
    return page.evaluate(id => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(window.__visualize.decks[id].canvas, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }, deckId)
}

async function openVisualize(page, server, url = '/') {
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routePortableImagesLocal(page)
    await routeSeanceServer(page, server.url)
    await page.route('**/data/programs.json', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(LIGHT_PROGRAMS),
    }))
    await page.goto(url)
    await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
    await page.evaluate(() => window.VisualizeAgent.ready)
}

// The person's steps: the Seance button, then Take Online.
async function takeOnline(page) {
    await page.click('#go-online-btn')
    await expect(page.locator('#seance-dialog dialog')).toBeVisible()
    await page.locator('#seance-dialog [data-action="take-online"]').click()
    await expect(page.locator('#seance-dialog .hf-seance-status-text')).toHaveText('Online', { timeout: 30_000 * SCALE })
    const code = await page.locator('#seance-dialog').evaluate(el => el.sessionId)
    await page.keyboard.press('Escape')
    await expect(page.locator('#seance-dialog dialog')).toBeHidden()
    return code
}

// The person loads Camera Input into deck B and picks a camera.
async function startCamera(page) {
    await page.evaluate(() => window.VisualizeAgent.loadProgram({ title: 'Camera Input', deck: 'B' }))
    const camera = page.locator('#deck-b-media-camera')
    await expect.poll(() => camera.evaluate(select => (select.getOptions?.() || []).filter(o => o.value).length),
        { timeout: 30_000 * SCALE }).toBeGreaterThan(0)
    await camera.evaluate(select => {
        select.value = select.getOptions().find(option => option.value).value
        select.dispatchEvent(new Event('change'))
    })
    await expect.poll(() => page.evaluate(() => window.VisualizeAgent._ctx.hasLiveMedia('B')), { timeout: 30_000 * SCALE }).toBe(true)
}

// Wait until the tab has nothing for deck B's document waiting to publish,
// then make a round trip on its connection, so any publish has arrived.
async function settled(page, ask) {
    await expect.poll(() => page.evaluate(() => {
        const doc = window.__visualize.online.online.docs.get('deck:B')
        return Boolean(doc && !doc.inFlight && !doc.proposalTimer && doc.text === doc.serverText)
    }), { timeout: 30_000 * SCALE }).toBe(true)
    await ask('getState')
}

test('an agent in the online session drives the owner\'s tab and sees its canvas as uploaded image bytes', async ({ page, browser, baseURL }) => {
    const origin = new URL(baseURL).origin
    const server = await startSeanceServer({ origins: [origin] })
    const agent = new SeanceAgentClient(server.url, origin)
    const guestContext = await browser.newContext()
    try {
        const sent = []
        page.on('websocket', socket => socket.on('framesent', frame => sent.push(String(frame.payload))))
        const uploads = []
        page.on('request', request => {
            if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/images')) {
                uploads.push({ type: request.headers()['content-type'], body: request.postDataBuffer() })
            }
        })
        // The page under test takes the set online, so its person owns the session.
        await openVisualize(page, server)
        const code = await takeOnline(page)
        expect(code).toBeTruthy()
        await agent.join(code)
        expect(agent.owner).toBeTruthy()

        // describe: the tab lists its commands and which ones need the person.
        const described = await agent.request('describe')
        expect(described.app).toBe('visualize')
        expect(described.envelope.ok).toBe(true)
        // The person had no connect-agent dialog open: the toast confirms.
        await expect(page.locator('#toast')).toHaveText('Agent connected')
        const commands = Object.fromEntries(described.envelope.result.commands.map(command => [command.name, command]))
        expect(commands.setProgram.args.required).toEqual(['dsl'])
        expect(commands.setProgram.args.properties.deck.enum).toEqual(['A', 'B'])
        expect(commands.getThumbnail.remote).toBe(true)
        expect(commands.record.remote).toBe(false)
        const firstTab = described.from

        // announce: a tab that joins the session tells the agent; a tab that
        // leaves says bye. The person reloads; the page rejoins from its URL.
        await page.reload()
        await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
        await page.waitForFunction(() => window.__visualize?.online?.getStatus?.() === 'online', null, { timeout: 60_000 * SCALE })
        await expect.poll(() => agent.events.some(event => event.kind === 'bye' && event.from === firstTab)).toBe(true)
        await expect.poll(() => agent.events.find(event => event.kind === 'announce' && event.from !== firstTab)?.body?.app,
            { timeout: 30_000 * SCALE }).toBe('visualize')
        // '*' reaches only describe; every other request names the tab.
        const tab = agent.events.find(event => event.kind === 'announce' && event.from !== firstTab).from
        const ask = (command, args = {}) => agent.request(command, args, { to: tab })

        // A read command returns what the session holds.
        await expect.poll(async () => (await ask('getProgram', { deck: 'B' })).envelope.result.dsl,
            { timeout: 30_000 * SCALE }).toBe(agent.docs.get('deck:B').text)
        const state = await ask('getState')
        expect(state.envelope.result.online).toBe('online')

        // A program change shows in the page and goes to the session document.
        const set = await ask('setProgram', { deck: 'B', dsl: RED })
        expect(set.envelope).toMatchObject({ ok: true, command: 'setProgram', result: { applied: true } })
        expect(await page.evaluate(() => window.__visualize.decks.B.currentDsl)).toBe(RED)
        await expect.poll(() => deckPixel(page, 'B'), { timeout: 30_000 * SCALE }).toEqual([255, 0, 0, 255])
        await expect.poll(() => agent.docs.get('deck:B')?.text, { timeout: 30_000 * SCALE }).toBe(RED)

        // A program that does not compile is refused and changes nothing.
        const refused = await ask('setProgram', { deck: 'B', dsl: 'search synth\nnoise(madeUp: 3).write(o0)\nrender(o0)' })
        expect(refused.envelope.ok).toBe(false)
        expect(refused.envelope.error.code).toBe('INVALID_PROGRAM')
        expect(refused.envelope.error.details.diagnostics.some(d => d.code === 'S001')).toBe(true)
        expect(await page.evaluate(() => window.__visualize.decks.B.currentDsl)).toBe(RED)
        await settled(page, ask)
        expect(agent.docs.get('deck:B').text).toBe(RED)

        // An image the agent adds to the session reaches a deck by its id.
        const blue = solidPng([0, 0, 255])
        expect((await agent.uploadImage(blue.bytes, 'image/png')).id).toBe(blue.id)
        const imageProgram = `search synth\nmedia(url: "image:${blue.id}").write(o0)\nrender(o0)`
        const shown = await ask('setProgram', { deck: 'A', dsl: imageProgram })
        expect(shown.envelope.ok, JSON.stringify(shown.envelope.error)).toBe(true)
        await expect.poll(() => deckPixel(page, 'A'), { timeout: 30_000 * SCALE }).toEqual([0, 0, 255, 255])
        // A session reads the program once the tab has published it.
        await expect.poll(async () => (await ask('getProgram', { deck: 'A' })).envelope.result.dsl,
            { timeout: 30_000 * SCALE }).toBe(imageProgram)
        expect(agent.docs.get('deck:A').text).toBe(imageProgram)

        // getThumbnail: the tab uploads the PNG as bytes and names it by id.
        const look = await ask('getThumbnail', { maxDimension: 48, format: 'png', source: 'B' })
        expect(look.envelope.ok).toBe(true)
        const result = look.envelope.result
        expect(result).toMatchObject({ mimeType: 'image/png', source: 'B', width: 48 })
        expect(result.bytes).toBeUndefined()
        const image = await agent.downloadImage(result.image.id)
        expect(image.mimeType).toBe('image/png')
        expect(image.bytes.subarray(1, 4).toString()).toBe('PNG')
        expect(digest(image.bytes)).toBe(result.image.id)
        expect(result.image.bytes).toBe(image.bytes.length)
        const center = await page.evaluate(async bytes => {
            const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
            const canvas = document.createElement('canvas')
            canvas.width = bitmap.width
            canvas.height = bitmap.height
            const context = canvas.getContext('2d')
            context.drawImage(bitmap, 0, 0)
            return [...context.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data]
        }, [...image.bytes])
        expect(center).toEqual([255, 0, 0, 255])
        // Images are images: the frame went up as its own bytes, and no
        // WebSocket frame from the tab carried image text.
        expect(uploads.some(upload => upload.type === 'image/png' && upload.body?.equals(image.bytes))).toBe(true)
        expect(sent.filter(frame => frame.includes(image.bytes.toString('base64')) || /data:image|[A-Za-z0-9+/]{200,}/.test(frame))).toEqual([])

        // Commands that need the person at the browser, or that read or
        // change what the browser stores for them, are refused.
        const recording = await ask('record', { recording: true })
        expect(recording.envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        expect(await page.evaluate(() => window.VisualizeAgent._ctx.recorder.isRecording)).toBe(false)
        const scenes = await ask('listScenes')
        expect(scenes.envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        const saved = await ask('scene', { action: 'save', name: 'from the session' })
        expect(saved.envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        expect(await page.evaluate(() => window.__visualize.scenes.scenes.length)).toBe(0)
        // The library answers without the person's Auto-VJ choices or user effects.
        const library = await ask('searchLibrary', { limit: 1 })
        expect(library.envelope.result.programs[0]).toEqual({ title: 'agent red', tagline: 'test program', category: 'abstract', tags: ['abstract'] })
        const userEffect = await ask('getEffectDefinition', { effectId: 'user/anything' })
        expect(userEffect.envelope.error.code).toBe('NOT_FOUND_EFFECT')
        const userProgram = await ask('validateProgram', { dsl: 'search user\nanything().write(o0)\nrender(o0)' })
        expect(userProgram.envelope.result.diagnostics.map(d => d.code)).toEqual(['USER_EFFECT'])
        // The search list can run over several lines; the parsed program counts.
        const splitSearch = await ask('validateProgram', { dsl: 'search synth,\nuser\nanything().write(o0)\nrender(o0)' })
        expect(splitSearch.envelope.result.diagnostics.map(d => d.code)).toEqual(['USER_EFFECT'])
        const qualified = await ask('setProgram', { deck: 'B', dsl: 'search synth\nuser.anything().write(o0)\nrender(o0)' })
        expect(qualified.envelope.error.details.diagnostics.map(d => d.code)).toEqual(['USER_EFFECT'])
        const unknown = await ask('noSuchCommand')
        expect(unknown.envelope.error.code).toBe('NOT_FOUND_COMMAND')

        // Images cross a session only as bytes.
        const inline = await ask('setProgram', { deck: 'A', dsl: `search synth\nmedia(url: "${PIXEL}").write(o0)\nrender(o0)` })
        expect(inline.envelope.error.code).toBe('IMAGE_AS_TEXT')
        // Nor does a session request make the person's browser fetch a link.
        const linked = await ask('setProgram', { deck: 'A', dsl: 'search synth\nmedia(url: "https://example.com/a.png").write(o0)\nrender(o0)' })
        expect(linked.envelope.error.code).toBe('OUTSIDE_LINK')
        expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).toBe(imageProgram)

        // A session does not use the person's Auto-VJ pool: with every program
        // left out of it, the page has nothing to pick and a session still does.
        await page.evaluate(async () => {
            for (const title of ['agent red', 'agent green']) await window.VisualizeAgent.setAutoVjPool({ title, included: false })
        })
        expect((await page.evaluate(() => window.VisualizeAgent.randomize({ deck: 'A' }))).error.code).toBe('NOT_FOUND_PROGRAM')
        const shuffled = await ask('randomize', { deck: 'A' })
        expect(shuffled.envelope.ok, JSON.stringify(shuffled.envelope.error)).toBe(true)
        expect(['agent red', 'agent green']).toContain(shuffled.envelope.result?.programs?.A)
        // Auto-VJ draws from that pool, so a session cannot turn it on.
        const autoVj = await ask('setAutoVj', { enabled: true })
        expect(autoVj.envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        expect(await page.evaluate(() => window.__visualize.autoMix.enabled)).toBe(false)

        // Session changes are live but leave the person's stored settings alone.
        const stored = () => page.evaluate(() => ({
            curve: localStorage.getItem('visualize.curve.v1'),
            mixer: localStorage.getItem('visualize.mixer.v1'),
            rebind: localStorage.getItem('visualize.rebind.v1'),
            autoMix: localStorage.getItem('visualize.autoxfade.v1'),
        }))
        const before = await stored()
        expect((await ask('setCrossfader', { curve: 'sharp' })).envelope.result.curve).toBe('sharp')
        expect((await ask('setMixer', { effect: 'mixer/split', params: { softness: 0.3 } })).envelope.result.effect).toBe('mixer/split')
        expect((await ask('setDeck', { deck: 'A', bandpass: false, oscillators: 3 })).envelope.result.oscillators).toBe(3)
        expect((await ask('setAutoMix', { source: 'audio:mid' })).envelope.result.source).toBe('audio:mid')
        await expect.poll(() => page.evaluate(() => window.__visualize.mixer.currentMixer.id)).toBe('mixer/split')
        expect(await stored()).toEqual(before)

        // Live camera input stays in the person's browser.
        await startCamera(page)
        await expect.poll(() => agent.docs.get('deck:B')?.text, { timeout: 30_000 * SCALE }).toBe(CAMERA)
        for (const source of ['B', 'output']) {
            const live = await ask('getThumbnail', { maxDimension: 32, source })
            expect(live.envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        }
        expect((await ask('getThumbnail', { maxDimension: 32, source: 'A' })).envelope.ok).toBe(true)
        // While the camera runs, deck B's program stays out of the session, so
        // a session reads the text the session holds, not the deck's draft.
        await page.evaluate(green => window.VisualizeAgent.setProgram({ deck: 'B', dsl: green }), GREEN)
        expect((await page.evaluate(() => window.VisualizeAgent.getProgram({ deck: 'B' }))).result.dsl).toBe(GREEN)
        await settled(page, ask)
        expect((await ask('getProgram', { deck: 'B' })).envelope.result).toEqual({ dsl: CAMERA, running: false })
        expect(agent.docs.get('deck:B').text).toBe(CAMERA)
        // The state a session reads describes the session's text too.
        const draftState = (await ask('getState')).envelope.result.decks.B
        expect(draftState).toMatchObject({ title: '', chars: CAMERA.length, running: false })

        // A frozen output keeps its camera frame after the camera stops: a
        // session cannot take it until the output runs again.
        await startCamera(page)
        expect((await ask('setFx', { freeze: true })).envelope.result.freeze).toBe(true)
        expect((await ask('loadProgram', { title: 'agent red', deck: 'B' })).envelope.ok).toBe(true)
        await expect.poll(() => page.evaluate(() => window.VisualizeAgent._ctx.hasLiveMedia('B'))).toBe(false)
        expect((await ask('getThumbnail', { maxDimension: 32, source: 'output' })).envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        expect((await ask('getThumbnail', { maxDimension: 32, source: 'B' })).envelope.ok).toBe(true)
        expect((await ask('setFx', { freeze: false })).envelope.result.freeze).toBe(false)
        expect((await ask('getThumbnail', { maxDimension: 32, source: 'output' })).envelope.ok).toBe(true)

        // A camera that stops while Camera Input still runs leaves its last
        // frame in the deck: here a switch to another camera fails.
        await startCamera(page)
        await page.evaluate(() => {
            navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('camera busy'))
            const select = document.getElementById('deck-b-media-camera')
            select.value = select.getOptions().map(option => option.value).find(value => value && value !== '__active__')
            select.dispatchEvent(new Event('change'))
        })
        await expect.poll(() => page.evaluate(() => window.VisualizeAgent._ctx.hasLiveMedia('B'))).toBe(false)
        expect(await page.evaluate(() => window.__visualize.decks.B.currentDsl)).toBe(CAMERA)
        for (const source of ['B', 'output']) {
            expect((await ask('getThumbnail', { maxDimension: 32, source })).envelope.error.code).toBe('REMOTE_UNAVAILABLE')
        }
        // A program that replaces the camera's texture ends it.
        expect((await ask('loadProgram', { title: 'agent green', deck: 'B' })).envelope.ok).toBe(true)
        expect((await ask('getThumbnail', { maxDimension: 32, source: 'B' })).envelope.ok).toBe(true)

        // A second Visualize tab, another person's, joins the session. It is
        // not the owner's, so it sends no relay frames at all.
        const guest = await guestContext.newPage()
        const guestSent = []
        guest.on('websocket', socket => socket.on('framesent', frame => guestSent.push(String(frame.payload))))
        await openVisualize(guest, server, `${origin}/?seance=${code}`)
        await guest.waitForFunction(() => window.__visualize?.online?.getStatus?.() === 'online', null, { timeout: 60_000 * SCALE })
        // Only the tab that took the session online offers "connect agent...".
        await expect(guest.locator('#connect-agent-btn')).toBeHidden()
        await expect(page.locator('#connect-agent-btn')).toBeVisible()
        const describedAgain = await agent.request('describe')
        expect(describedAgain.from).toBe(tab)
        const owned = await ask('getState')
        expect(owned.from).toBe(tab)
        expect(guestSent.length).toBeGreaterThan(0)
        expect(guestSent.filter(frame => frame.includes('nf-agent/1'))).toEqual([])
        expect(agent.ignored).toEqual([])

        // The person's tab leaves. Seance makes the guest the owner; the
        // guest's tab did not take the session online, so it stays silent.
        const firstOwner = agent.owner
        await page.close()
        await expect.poll(() => agent.owner, { timeout: 30_000 * SCALE }).not.toBe(firstOwner)
        await expect(agent.request('describe', {}, { timeoutMs: 6000 })).rejects.toThrow(/No response to describe/)
        expect(guestSent.filter(frame => frame.includes('nf-agent/1'))).toEqual([])
        expect(agent.ignored).toEqual([])
    } finally {
        agent.close()
        await guestContext.close()
        await server.stop()
    }
})

test('connect agent walks the person through going online, copying the prompt and the agent joining', async ({ page, context, baseURL }) => {
    const origin = new URL(baseURL).origin
    const server = await startSeanceServer({ origins: [origin] })
    const agent = new SeanceAgentClient(server.url, origin)
    try {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
        await openVisualize(page, server)
        // The button beside the Seance button opens the shared dialog.
        const button = page.getByRole('button', { name: 'connect agent...', exact: true })
        await expect(button).toBeVisible()
        await expect(button).toHaveAttribute('data-title', 'connect agent...')
        await button.click()
        const dialog = page.locator('#agent-connect-dialog dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.locator('.hf-agent-lead')).toHaveText('To connect an agent, follow these steps:')
        const states = () => dialog.locator('.hf-agent-step').evaluateAll(items => items.map(item => item.dataset.state))
        expect(await states()).toEqual(['active', 'pending', 'pending'])

        await dialog.locator('[data-action="go-online"]').click()
        await expect.poll(states, { timeout: 30_000 * SCALE }).toEqual(['done', 'active', 'pending'])
        const code = new URL(page.url()).searchParams.get('seance')
        expect(code).toBeTruthy()

        await dialog.locator('[data-action="copy-prompt"]').click()
        await expect.poll(states).toEqual(['done', 'done', 'active'])
        const prompt = await page.evaluate(() => navigator.clipboard.readText())
        // The prompt is handfish's, for Visualize's contract and this session.
        expect(prompt).toBe(await page.evaluate(async url => (await import('handfish')).agentConnectPrompt({
            app: 'Visualize', contractUrl: 'https://visualize.noisedeck.app/llms-full.txt', sessionUrl: url,
        }), page.url()))
        expect(prompt.split('\n')[0]).toBe('Connect to my Visualize session and help me with it.')
        expect(prompt).toContain('https://visualize.noisedeck.app/llms-full.txt')

        // The agent runs the prompt's last line in a shell as written. A
        // stand-in for the agent tool reports the arguments the shell passed.
        const tool = mkdtempSync(join(tmpdir(), 'visualize-agent-prompt-'))
        let args
        try {
            writeFileSync(join(tool, 'seance-agent.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
            const line = prompt.trim().split('\n').at(-1).trim()
            args = await new Promise((done, fail) => execFile('/bin/sh', ['-c', line], {
                cwd: tool, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
            }, (error, stdout) => error ? fail(error) : done(JSON.parse(stdout))))
        } finally {
            rmSync(tool, { recursive: true, force: true })
        }
        expect(args).toEqual(['join', `${origin}/?seance=${code}`])
        await agent.join(new URL(args[1]).searchParams.get('seance'))
        expect((await agent.request('describe')).app).toBe('visualize')
        await expect.poll(states).toEqual(['done', 'done', 'done'])
        await expect(dialog).toBeHidden({ timeout: 10_000 * SCALE })
        await expect(page.locator('#toast')).toHaveText('Agent connected')
        await expect(page.locator('#toast')).toHaveClass(/show/)
    } finally {
        agent.close()
        await server.stop()
    }
})
