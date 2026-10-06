// SPDX-License-Identifier: MIT
//
// Hermetic Seance helpers for Visualize's Playwright specs.
//
// The app imports the browser SDK from the production rolling-major URL. These
// tests route that URL to the sibling Seance checkout and inject a tiny in-test
// Seance server so no live service or local daemon is required.
import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

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
