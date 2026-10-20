// SPDX-License-Identifier: MIT
//
// Hermetic Seance helpers for Visualize's Playwright specs.
//
// The app imports the browser SDK from the production rolling-major URL. These
// tests route that URL to the sibling Seance checkout and inject a tiny in-test
// Seance server so no live service or local daemon is required.
//
// startSeanceServer() instead runs a real Seance server from a local checkout,
// and SeanceAgentClient joins its sessions from Node the way a software agent
// does, for the agent relay spec (agent-seance.spec.js).
import { spawn } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'

const SDK_CDN_PREFIX = 'https://seance.noisefactor.io/sdk/0/'
const SEANCE_URL = 'https://seance.noisefactor.io'

function defaultSeanceSdkLocal() {
    const local = resolve(process.cwd(), '../seance/sdk')
    return existsSync(resolve(local, 'index.js')) ? local : ''
}

export async function routeSeanceSdkLocal(page) {
    const local = process.env.SEANCE_SDK_LOCAL || defaultSeanceSdkLocal()
    if (!local) return
    await page.route(`${SDK_CDN_PREFIX}**`, async (route) => {
        const rel = new URL(route.request().url()).pathname.replace(/^\/sdk\/0\//, '')
        try {
            const body = readFileSync(resolve(local, rel))
            await route.fulfill({ status: 200, contentType: 'text/javascript', body })
        } catch {
            await route.fulfill({ status: 404, body: 'missing ' + rel })
        }
    })
}

export async function routePortableImagesLocal(page) {
    const file = resolve(process.env.PORTABLE_IMAGES_MODULE || '../sharing/public/js/portableImages.js')
    if (!existsSync(file)) return
    await page.route('https://sharing.noisedeck.app/js/portableImages.js*', route => route.fulfill({
        status: 200, contentType: 'text/javascript', body: readFileSync(file),
        headers: { 'Access-Control-Allow-Origin': '*' },
    }))
}

function applyTextEdit(text, edit) {
    return text.slice(0, edit.start) + edit.text + text.slice(edit.end)
}

function cloneDoc(doc) {
    return {
        id: doc.id,
        title: doc.title,
        kind: doc.kind,
        text: doc.text,
        default: !!doc.default,
        rev: doc.rev,
    }
}

export class FakeSeanceServer {
    constructor() {
        // Every doc-edit frame the server received, and every one it refused.
        // Tests assert on these: a proposal loop against a document the
        // session does not have is invisible from the app side.
        this.proposals = []
        this.rejected = []
        this._nextSession = 1
        this._nextSocket = 1
        this._nextPage = 1
        this._seq = 1
        this.sessions = new Map()
        this.sockets = new Map()
        // Every session seed that carried an image as text. Images travel as bytes.
        this.imageText = []
    }

    storeImage(session, { mimeType, bytes }) {
        const data = Buffer.from(bytes)
        const image = { id: createHash('sha256').update(data).digest('hex'), mimeType, bytes: data }
        session.images.set(image.id, image)
        return image
    }

    async install(page) {
        const pageKey = `page-${this._nextPage++}`
        await page.exposeFunction('__fakeSeanceCreateSession', (body) => this.createSession(body))
        // Images cross this boundary as byte arrays: the SDK uploads an
        // image as its own bytes, and the server names it by their SHA-256.
        await page.exposeFunction('__fakeSeanceImageRequest', (sessionId, id, upload) => {
            const session = this.sessions.get(sessionId)
            if (!session) throw new Error('Unknown session')
            const image = upload ? this.storeImage(session, upload) : session.images.get(id)
            return image ? { id: image.id, mimeType: image.mimeType, bytes: [...image.bytes] } : null
        })
        await page.exposeFunction('__fakeSeanceSocketOpen', (socketId, url) => this.openSocket(page, socketId, url))
        await page.exposeFunction('__fakeSeanceSocketSend', (socketId, data) => this.receiveSocketData(socketId, data))
        await page.exposeFunction('__fakeSeanceSocketClose', (socketId) => this.closeSocket(socketId))

        await page.addInitScript(({ sdkUrl, seanceUrl, pageKey }) => {
            const sockets = new Map()
            let socketCounter = 1

            class FakeWebSocket extends EventTarget {
                constructor(url) {
                    super()
                    this.url = url
                    this.readyState = FakeWebSocket.CONNECTING
                    this._socketId = `${pageKey}-socket-${socketCounter++}`
                    sockets.set(this._socketId, this)
                    window.__fakeSeanceSocketOpen(this._socketId, url).then(() => {
                        if (this.readyState !== FakeWebSocket.CONNECTING) return
                        this.readyState = FakeWebSocket.OPEN
                        this.dispatchEvent(new Event('open'))
                    })
                }

                send(data) {
                    if (this.readyState !== FakeWebSocket.OPEN) {
                        throw new Error('FakeWebSocket is not open')
                    }
                    window.__fakeSeanceSocketSend(this._socketId, String(data))
                }

                close() {
                    if (this.readyState === FakeWebSocket.CLOSED) return
                    this.readyState = FakeWebSocket.CLOSED
                    sockets.delete(this._socketId)
                    window.__fakeSeanceSocketClose(this._socketId)
                    setTimeout(() => this.dispatchEvent(new CloseEvent('close')), 0)
                }

                __receive(frame) {
                    if (this.readyState !== FakeWebSocket.OPEN) return
                    this.dispatchEvent(new MessageEvent('message', {
                        data: JSON.stringify(frame),
                    }))
                }
            }

            FakeWebSocket.CONNECTING = 0
            FakeWebSocket.OPEN = 1
            FakeWebSocket.CLOSING = 2
            FakeWebSocket.CLOSED = 3

            window.__fakeSeanceSockets = sockets
            window.__VISUALIZE_SEANCE_CONFIG__ = {
                sdkUrl,
                seanceUrl,
                WebSocket: FakeWebSocket,
                fetch: async (url, init = {}) => {
                    const href = String(url)
                    const imagePath = new URL(href).pathname.match(/^\/v1\/sessions\/([^/]+)\/images(?:\/([a-f0-9]{64}))?$/)
                    const bytesOf = async blob => [...new Uint8Array(await blob.arrayBuffer())]
                    if (imagePath) {
                        const upload = String(init.method || 'GET').toUpperCase() === 'POST'
                        if (upload && !(init.body instanceof Blob)) return new Response('images upload as bytes', { status: 400 })
                        const image = await window.__fakeSeanceImageRequest(imagePath[1], imagePath[2],
                            upload ? { mimeType: new Headers(init.headers).get('Content-Type'), bytes: await bytesOf(init.body) } : null)
                        if (!image) return new Response('', { status: 404 })
                        if (upload) return new Response(JSON.stringify({ id: image.id }), { headers: { 'Content-Type': 'application/json' } })
                        return new Response(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mimeType } })
                    }
                    if (href === `${seanceUrl}/v1/sessions` && String(init.method || 'GET').toUpperCase() === 'POST') {
                        // A seed with images is multipart: the JSON seed, then each image as a file part.
                        let body
                        if (init.body instanceof FormData) {
                            body = JSON.parse(await init.body.get('session').text())
                            body.files = await Promise.all(init.body.getAll('image').map(async file =>
                                ({ name: file.name, mimeType: file.type, bytes: await bytesOf(file) })))
                        } else body = JSON.parse(init.body || '{}')
                        const response = await window.__fakeSeanceCreateSession(body)
                        return new Response(JSON.stringify(response), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        })
                    }
                    return fetch(url, init)
                },
            }
        }, { sdkUrl: `${SDK_CDN_PREFIX}index.js?v=0.2.2`, seanceUrl: SEANCE_URL, pageKey })
    }

    /**
     * Refuse the next join of this session with a server `error` frame, then
     * leave the socket open: that is what the deployed SDK sees while it sits
     * in 'connecting' retrying a terminal refusal.
     */
    refuseJoin(sessionId, error = { code: 'forbidden', detail: 'roster full' }) {
        const session = this.sessions.get(sessionId)
        if (session) session.refuse = error
    }

    createSession(body = {}) {
        const sessionId = `S${String(this._nextSession++).padStart(5, '0')}`
        const docs = new Map()
        for (const [index, raw] of (body.snapshot?.docs || []).entries()) {
            const id = raw.id || (index === 0 ? 'deck:A' : `doc:${index}`)
            docs.set(id, {
                id,
                title: raw.title || id,
                kind: raw.kind || 'dsl',
                text: String(raw.text ?? ''),
                default: raw.default ?? index === 0,
                rev: 0,
            })
        }
        if (body.images || /data:image|;base64,/.test(JSON.stringify(body.snapshot || {}))) this.imageText.push(sessionId)
        const session = { id: sessionId, docs, images: new Map(), sockets: new Set() }
        for (const file of body.files || []) {
            const image = this.storeImage(session, file)
            if (file.name !== image.id) throw new Error(`seed image ${file.name} does not match its bytes`)
        }
        this.sessions.set(sessionId, session)
        return { session_id: sessionId, anon_token: `anon-${sessionId}` }
    }

    openSocket(page, socketId, url) {
        const sessionId = new URL(url).pathname.split('/').at(-2)
        const session = this.sessions.get(sessionId)
        if (!session) throw new Error(`unknown fake session ${sessionId}`)
        const socket = {
            id: socketId,
            page,
            sessionId,
            user: `user-${this._nextSocket++}`,
            username: `Guest ${this._nextSocket}`,
        }
        this.sockets.set(socketId, socket)
        session.sockets.add(socketId)
    }

    async receiveSocketData(socketId, data) {
        const socket = this.sockets.get(socketId)
        if (!socket) return
        const session = this.sessions.get(socket.sessionId)
        if (!session) return
        const msg = JSON.parse(data)

        if (msg.type === 'hello') {
            if (session.refuse) {
                await this.deliver(socketId, {
                    type: 'error',
                    code: session.refuse.code,
                    detail: session.refuse.detail,
                })
                return
            }
            await this.deliver(socketId, {
                type: 'welcome',
                seq: this._nextSeq(),
                you: {
                    id: socket.user,
                    username: socket.username,
                    readonly: false,
                },
                anon_token: `anon-${session.id}`,
            })
            await this.deliver(socketId, {
                type: 'session-snapshot',
                seq: this._nextSeq(),
                docs: [...session.docs.values()].map(cloneDoc),
            })
            return
        }

        if (msg.type === 'doc-edit') {
            this.proposals.push({ sessionId: session.id, docId: msg.docId, socketId })
            const doc = session.docs.get(msg.docId)
            if (!doc) {
                // The real server refuses an edit to a document that does not
                // exist ("invalid", with no recovery snapshot) and the SDK
                // re-proposes immediately. Auto-creating it here hid a loop
                // that runs about nine times a second in production, so the
                // double has to refuse it the same way.
                this.rejected.push({ sessionId: session.id, docId: msg.docId })
                await this.deliver(socketId, {
                    type: 'doc-reject',
                    seq: this._nextSeq(),
                    docId: msg.docId,
                    baseRev: msg.baseRev,
                    authorSeq: msg.authorSeq,
                    reason: 'invalid',
                    snapshot: null,
                })
                return
            }
            doc.text = applyTextEdit(doc.text, msg.edit)
            doc.rev += 1
            await this.deliver(socketId, {
                type: 'doc-ack',
                seq: this._nextSeq(),
                docId: msg.docId,
                authorSeq: msg.authorSeq,
                edit: msg.edit,
                rev: doc.rev,
            })
            await this.broadcast(session.id, socketId, {
                type: 'doc-edit',
                seq: this._nextSeq(),
                docId: msg.docId,
                edit: msg.edit,
                rev: doc.rev,
            })
        }
    }

    closeSocket(socketId) {
        const socket = this.sockets.get(socketId)
        if (!socket) return
        this.sockets.delete(socketId)
        this.sessions.get(socket.sessionId)?.sockets.delete(socketId)
    }

    async deliver(socketId, frame) {
        const socket = this.sockets.get(socketId)
        if (!socket) return
        await socket.page.evaluate(({ id, frame: msg }) => {
            window.__fakeSeanceSockets?.get(id)?.__receive(msg)
        }, { id: socketId, frame })
    }

    async broadcast(sessionId, exceptSocketId, frame) {
        const session = this.sessions.get(sessionId)
        if (!session) return
        for (const socketId of session.sockets) {
            if (socketId === exceptSocketId) continue
            await this.deliver(socketId, frame)
        }
    }

    docsFor(sessionId) {
        const session = this.sessions.get(sessionId)
        return session ? [...session.docs.values()].map(cloneDoc) : []
    }

    _nextSeq() {
        return this._seq++
    }
}

// --------------------------------------------------------------------------
// A real local Seance server, and an agent that joins its sessions.
// SEANCE_ROOT is a Seance checkout (default ../seance), SEANCE_PYTHON the
// Python that runs it, and SEANCE_DIST_DIR the browser SDK bundle that the
// app's SDK URL is answered with.
// --------------------------------------------------------------------------

const seanceRoot = resolve(process.env.SEANCE_ROOT || '../seance')
const seanceDist = resolve(process.env.SEANCE_DIST_DIR || join(seanceRoot, 'dist'))
const seancePython = process.env.SEANCE_PYTHON || join(seanceRoot, '.venv/bin/python')

function bindPort(port) {
    return new Promise(done => {
        const listener = createServer()
        listener.once('error', () => done(null))
        listener.listen(port, '127.0.0.1', () => {
            const bound = listener.address().port
            listener.close(() => done(bound))
        })
    })
}

// Any free loopback port; on runners that allow only a fixed port range
// (PW_TEST_LOOPBACK_PORTS, see scripts/test.cjs), a free one from that range
// other than the web server's.
async function freePort() {
    const any = await bindPort(0)
    if (any) return any
    const range = String(process.env.PW_TEST_LOOPBACK_PORTS || '43117-43126').split(',').flatMap(part => {
        const [low, high = low] = part.trim().split('-').map(Number)
        return Array.from({ length: Math.max(0, high - low + 1) }, (_, i) => low + i)
    })
    for (const port of range) {
        if (port !== Number(process.env.PW_PORT) && await bindPort(port)) return port
    }
    throw new Error('No free loopback port for the Seance server')
}

/** Start a Seance server that accepts pages and agents from `origins`. */
export async function startSeanceServer({ origins }) {
    if (!existsSync(join(seanceDist, 'index.js')) || !existsSync(seancePython)) {
        throw new Error('Set SEANCE_ROOT, SEANCE_DIST_DIR and SEANCE_PYTHON to a local Seance build for this integration test.')
    }
    const port = await freePort()
    const directory = mkdtempSync(join(tmpdir(), 'visualize-seance-'))
    const proc = spawn(seancePython, [join(seanceRoot, 'bin/app.py')], {
        cwd: seanceRoot,
        env: {
            ...process.env,
            PYTHONPATH: [seanceRoot, process.env.PYTHONPATH].filter(Boolean).join(':'),
            SEANCE_BIND: `127.0.0.1:${port}`,
            SEANCE_SECRET: randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
            SEANCE_DB: join(directory, 'seance.db'),
            SEANCE_ALLOWED_ORIGINS: origins.join(','),
            SEANCE_TRUSTED_PROXIES: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    proc.stdout.on('data', data => { logs += data })
    proc.stderr.on('data', data => { logs += data })
    const url = `http://127.0.0.1:${port}`
    const stop = async () => {
        if (proc.exitCode === null) {
            proc.kill('SIGTERM')
            await new Promise(done => {
                const timer = setTimeout(() => { proc.kill('SIGKILL'); done() }, 1500)
                proc.once('exit', () => { clearTimeout(timer); done() })
            })
        }
        rmSync(directory, { recursive: true, force: true })
    }
    try {
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
            if (proc.exitCode !== null) throw new Error(`Seance startup failed: ${logs}`)
            try {
                if ((await fetch(`${url}/up`, { signal: AbortSignal.timeout(1000) })).ok) return { url, stop }
            } catch { /* the server is still starting */ }
            await new Promise(done => setTimeout(done, 100))
        }
        throw new Error(`Seance startup timed out: ${logs}`)
    } catch (error) {
        await stop()
        throw error
    }
}

/** Point the page's online collaboration at a local Seance server. */
export async function routeSeanceServer(page, url) {
    await page.addInitScript(seanceUrl => { window.__VISUALIZE_SEANCE_CONFIG__ = { seanceUrl } }, url)
    await page.route(`${SDK_CDN_PREFIX}**`, route => {
        const relative = new URL(route.request().url()).pathname.slice('/sdk/0/'.length)
        const file = resolve(seanceDist, relative)
        if (!file.startsWith(`${seanceDist}${sep}`) || !existsSync(file)) return route.fulfill({ status: 404 })
        return route.fulfill({ path: file, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } })
    })
}

const RELAY = 'nf-agent/1'

/**
 * Joins a Seance session from Node as a software agent does, sends agent
 * relay requests to the app tab, and moves images as bytes through the
 * session's image endpoints. Like the shared agent tool, it trusts relay
 * frames only from the session owner, by the user id the server stamps on
 * each frame; `ignored` collects relay frames from anyone else. `events`
 * collects announce and bye frames; `docs` follows the session documents.
 */
export class SeanceAgentClient {
    constructor(server, origin) {
        this.server = server
        this.origin = origin
        this.events = []
        this.ignored = []
        this.owner = null
        this.docs = new Map()
        this._pending = new Map()
        this._partial = new Map()
        this._lastSend = 0
        this._token = null
    }

    async join(code) {
        const probe = await fetch(`${this.server}/v1/sessions/${encodeURIComponent(code)}`, { headers: { Origin: this.origin } })
        if (!probe.ok) throw new Error(`The session probe answered ${probe.status}`)
        this.sessionId = (await probe.json()).id
        const url = `${this.server.replace(/^http/, 'ws')}/v1/sessions/${encodeURIComponent(this.sessionId)}/ws`
        this.ws = new WebSocket(url, { headers: { Origin: this.origin } })
        await new Promise((done, fail) => {
            this.ws.addEventListener('open', () => {
                this.ws.send(JSON.stringify({ type: 'hello', protocol: 1, dialects: ['noisemaker-dsl'] }))
            })
            this.ws.addEventListener('message', event => {
                const frame = JSON.parse(String(event.data))
                if (frame.type === 'session-snapshot') done()
                this._handle(frame)
            })
            this.ws.addEventListener('close', event => fail(new Error(`The session closed the agent socket (${event.code})`)))
        })
    }

    _handle(frame) {
        if (frame.type === 'welcome') {
            if (frame.anon_token) this._token = frame.anon_token
            this.owner = frame.owner?.user_id || null
        }
        if (frame.type === 'owner-changed') this.owner = frame.user_id || null
        if (frame.type === 'session-snapshot' || frame.type === 'doc-snapshot') {
            for (const doc of frame.docs || []) this.docs.set(doc.id, { text: doc.text, rev: doc.rev })
        }
        if (frame.type === 'doc-edit') {
            const doc = this.docs.get(frame.docId)
            const { start, end, text } = frame.edit || {}
            if (!doc || frame.rev !== doc.rev + 1) {
                // A missed edit: ask for a fresh snapshot.
                this.ws.send(JSON.stringify({ type: 'session-state' }))
                return
            }
            this.docs.set(frame.docId, { text: doc.text.slice(0, start) + text + doc.text.slice(end), rev: frame.rev })
        }
        if (frame.type !== 'clicked-button' || frame.relay !== RELAY) return
        if (frame.kind === 'request') return
        if (!this.owner || frame.user_id !== this.owner) {
            this.ignored.push(frame)
            return
        }
        const body = this._assemble(frame)
        if (body === undefined) return
        if (frame.kind === 'response') this._pending.get(frame.id)?.({ from: frame.from, app: frame.app, envelope: body })
        else this.events.push({ kind: frame.kind, from: frame.from, app: frame.app, body })
    }

    // A body too large for one frame arrives as JSON text slices.
    _assemble(frame) {
        if (frame.body !== undefined) return frame.body
        const key = `${frame.kind}:${frame.id}:${frame.from}`
        const entry = this._partial.get(key) || { slices: new Array(frame.parts), count: 0 }
        if (entry.slices[frame.part] === undefined) entry.count += 1
        entry.slices[frame.part] = frame.chunk
        this._partial.set(key, entry)
        if (entry.count < frame.parts) return undefined
        this._partial.delete(key)
        return JSON.parse(entry.slices.join(''))
    }

    /** Send one relay request and resolve with the first response. */
    async request(command, args = {}, { to = '*', timeoutMs = 60000 } = {}) {
        // The control lane refills five frames a second.
        const wait = this._lastSend + 250 - Date.now()
        if (wait > 0) await new Promise(done => setTimeout(done, wait))
        this._lastSend = Date.now()
        const id = randomUUID()
        return new Promise((done, fail) => {
            const timer = setTimeout(() => {
                this._pending.delete(id)
                fail(new Error(`No response to ${command} within ${timeoutMs} ms`))
            }, timeoutMs)
            this._pending.set(id, reply => {
                clearTimeout(timer)
                this._pending.delete(id)
                done(reply)
            })
            this.ws.send(JSON.stringify({ type: 'clicked-button', relay: RELAY, kind: 'request', id, to, body: { command, args } }))
        })
    }

    _headers(extra = {}) {
        return { Origin: this.origin, ...(this._token ? { 'X-Seance-Anon': this._token } : {}), ...extra }
    }

    async uploadImage(bytes, mimeType) {
        const response = await fetch(`${this.server}/v1/sessions/${encodeURIComponent(this.sessionId)}/images`, {
            method: 'POST', headers: this._headers({ 'Content-Type': mimeType }), body: bytes,
        })
        if (!response.ok) throw new Error(`The image upload answered ${response.status}`)
        return response.json()
    }

    async downloadImage(id) {
        const response = await fetch(`${this.server}/v1/sessions/${encodeURIComponent(this.sessionId)}/images/${id}`, { headers: this._headers() })
        if (!response.ok) throw new Error(`The image download answered ${response.status}`)
        return { bytes: Buffer.from(await response.arrayBuffer()), mimeType: (response.headers.get('content-type') || '').split(';')[0] }
    }

    close() {
        try { this.ws?.close() } catch { /* already closed */ }
    }
}
