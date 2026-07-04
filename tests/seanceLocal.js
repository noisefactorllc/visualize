// SPDX-License-Identifier: MIT
//
// Hermetic Seance helpers for Visualize's Playwright specs.
//
// The app imports the browser SDK from the production rolling-major URL. These
// tests route that URL to the sibling Seance checkout and inject a tiny in-test
// Seance server so no live service or local daemon is required.
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
        this._nextSession = 1
        this._nextSocket = 1
        this._nextPage = 1
        this._seq = 1
        this.sessions = new Map()
        this.sockets = new Map()
    }

    async install(page) {
        const pageKey = `page-${this._nextPage++}`
        await page.exposeFunction('__fakeSeanceCreateSession', (body) => this.createSession(body))
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
                    this.dispatchEvent(new CloseEvent('close'))
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
                    if (href === `${seanceUrl}/v1/sessions` && String(init.method || 'GET').toUpperCase() === 'POST') {
                        const body = JSON.parse(init.body || '{}')
                        const response = await window.__fakeSeanceCreateSession(body)
                        return new Response(JSON.stringify(response), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        })
                    }
                    return fetch(url, init)
                },
            }
        }, { sdkUrl: `${SDK_CDN_PREFIX}index.js`, seanceUrl: SEANCE_URL, pageKey })
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
        this.sessions.set(sessionId, { id: sessionId, docs, sockets: new Set() })
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
            let doc = session.docs.get(msg.docId)
            if (!doc) {
                doc = {
                    id: msg.docId,
                    title: msg.docId,
                    kind: 'dsl',
                    text: '',
                    default: session.docs.size === 0,
                    rev: 0,
                }
                session.docs.set(msg.docId, doc)
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
