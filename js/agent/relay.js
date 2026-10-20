/**
 * Seance relay for the agent API. While the person's program is online, a
 * software agent that joined the same session sends commands as Seance
 * `clicked-button` frames, and this tab runs them with the same dispatcher,
 * validation and account limits as the in-page API.
 *
 * Only the tab that took this session online answers, and only while it is the
 * session's owner. Seance hands ownership to another participant when the
 * person's tab leaves, so a tab also checks that it created the session (kept
 * in its sessionStorage, which survives a reload). Seance lets only writers
 * send these frames, and it relays every answer to everyone in the session, so
 * commands that read or change the person's private data stay out of the relay
 * (`remote: false`).
 *
 * Images are images: an image result is uploaded to the session as its own
 * bytes, and the reply names it by its SHA-256. No image travels as text: a
 * request or an answer that carries a base64 image is refused. A request may
 * not name media by an outside link either, which would make the person's
 * browser fetch it: agents add images to the session and name them
 * `image:<sha256>`.
 *
 * The first request on each connection tells the app that an agent has
 * connected (`onAgent`), so it can confirm the connection to the person; an
 * agent that reconnects is reported again. `answers()` says whether this tab
 * answers its current session at all.
 *
 * The relay reads and writes the SDK's socket through the WebSocket class it
 * hands to the SDK, so the SDK itself needs no change.
 *
 * Frame shapes (the agent side is /agent/seance-agent.mjs):
 *   request   { relay, kind: 'request', id, to: tabId | '*', body: { command, args } }
 *   response  { relay, kind: 'response', id, from: tabId, app, body: envelope }
 *   announce  { relay, kind: 'announce', from, app, body: describe result }
 *   bye       { relay, kind: 'bye', from, app, body: {} }
 * `'*'` reaches only `describe`. A body too large for one Seance frame travels
 * as JSON text slices: `part`, `parts` and `chunk` replace `body`.
 *
 * @module agent/relay
 */

import { API_VERSION, makeFailure, makeSuccess } from './dispatcher.js'

export const RELAY = 'nf-agent/1'

// Seance accepts relay frames up to 64 KiB as it measures them (JSON with every
// non-ASCII character escaped to six bytes), on a control lane that refills at
// 5 frames a second with a burst of 10. Relay frames stay under both.
const MAX_FRAME_BYTES = 60000
const MAX_SLICE_BYTES = 48000
const SEND_RATE = 4
const SEND_BURST = 8
const MAX_PENDING = 8
// A session holds at most 32 images, and Seance frees an image nothing uses
// only after ten minutes. Agent images keep to half of that.
const IMAGE_LIMIT = 16
const IMAGE_WINDOW_MS = 10 * 60 * 1000
const IMAGE_TEXT = /data:image\/[^;,"'\s]*;base64,/i
const OUTSIDE_LINK = /\burl\s*:\s*\\?["']\s*(?:https?:)?\/\//i
const CREATED_KEY = 'nf-agent-relay:created'

function readCreated() {
    try {
        const list = JSON.parse(globalThis.sessionStorage?.getItem(CREATED_KEY) || '[]')
        return Array.isArray(list) ? list.filter(id => typeof id === 'string') : []
    } catch {
        return []
    }
}

// The size Seance gives a JSON text: escapes for quotes, backslashes and
// control characters, and six bytes for every non-ASCII UTF-16 unit.
function unitCost(code) {
    if (code === 0x22 || code === 0x5c) return 2
    if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
    return code > 0x7f ? 6 : 1
}

export function seanceSize(value) {
    const text = JSON.stringify(value)
    let size = 0
    for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at)
        size += code > 0x7f ? 6 : 1
    }
    return size
}

export function relayFrames(head, body) {
    const whole = { type: 'clicked-button', relay: RELAY, ...head, body }
    if (seanceSize(whole) <= MAX_FRAME_BYTES) return [whole]
    const text = JSON.stringify(body)
    const slices = []
    let start = 0
    let cost = 0
    for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at)
        const pair = code >= 0xd800 && code <= 0xdbff && at + 1 < text.length
        const step = pair ? unitCost(code) + unitCost(text.charCodeAt(at + 1)) : unitCost(code)
        if (cost + step > MAX_SLICE_BYTES) {
            slices.push(text.slice(start, at))
            start = at
            cost = 0
        }
        cost += step
        if (pair) at += 1
    }
    slices.push(text.slice(start))
    return slices.map((chunk, part) => ({ type: 'clicked-button', relay: RELAY, ...head, part, parts: slices.length, chunk }))
}

export function createAssembler() {
    const partial = new Map()
    return (frame) => {
        if (frame.body !== undefined) return { done: true, body: frame.body }
        const { id, part, parts, chunk } = frame
        if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > 4096 ||
            part < 0 || part >= parts || typeof chunk !== 'string') return { done: false }
        // The server stamps connection_id; a sender cannot write into another's slices.
        const key = `${frame.kind}:${id}:${frame.connection_id || ''}`
        const entry = partial.get(key) || { slices: new Array(parts), count: 0, at: Date.now() }
        if (entry.slices.length !== parts) return { done: false }
        if (entry.slices[part] === undefined) entry.count += 1
        entry.slices[part] = chunk
        partial.set(key, entry)
        for (const [other, value] of partial) if (Date.now() - value.at > 5 * 60 * 1000) partial.delete(other)
        if (entry.count < parts) return { done: false }
        partial.delete(key)
        return { done: true, body: JSON.parse(entry.slices.join('')) }
    }
}

function newTabId() {
    const bytes = crypto.getRandomValues(new Uint8Array(6))
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Create the relay for one app tab.
 *
 * @param {object} options
 * @param {string} options.app - App id, such as 'noisedeck'.
 * @param {string} options.appVersion
 * @param {() => Array<object>} options.catalog - Command descriptions for `describe`.
 * @param {(command: string, args: object) => Promise<{envelope: object, image?: Blob}>} options.invoke
 * @param {(blob: Blob) => Promise<string>} options.uploadImage - Uploads bytes to the session; returns the image id.
 * @param {(agent: {userId: string, username: string}) => void} [options.onAgent] - Called for the first
 *   request this tab answers on each connection in a session.
 * @param {typeof WebSocket} [options.BaseSocket]
 * @returns {{ WebSocket: typeof WebSocket, tabId: string, sessionCreated: (sessionId: string) => void, answers: () => boolean }}
 *   Call sessionCreated with the session id once this tab has taken a session online.
 */
export function createAgentRelay({ app, appVersion, catalog, invoke, uploadImage, onAgent, BaseSocket = globalThis.WebSocket }) {
    const tabId = newTabId()
    const assemble = createAssembler()
    const uploads = []
    let socket = null
    let self = null
    let owner = null
    let session = null
    let pending = 0
    const created = new Set(readCreated())
    const agents = new Set()
    let tokens = SEND_BURST
    let tokensAt = Date.now()
    let chain = Promise.resolve()

    const answering = () => Boolean(self) && self === owner && created.has(session)

    function sessionCreated(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) return
        created.add(sessionId)
        try {
            globalThis.sessionStorage?.setItem(CREATED_KEY, JSON.stringify([...created].slice(-20)))
        } catch { /* storage refused: the tab still answers until it reloads */ }
        if (answering() && socket) send(relayFrames({ kind: 'announce', from: tabId, app }, describe()))
    }

    function send(frames, target = socket) {
        const run = async () => {
            for (const frame of frames) {
                for (;;) {
                    const now = Date.now()
                    tokens = Math.min(SEND_BURST, tokens + (now - tokensAt) * SEND_RATE / 1000)
                    tokensAt = now
                    if (tokens >= 1) break
                    await new Promise(done => setTimeout(done, Math.ceil((1 - tokens) * 1000 / SEND_RATE)))
                }
                // A socket that closed while the reply waited takes the reply with it.
                if (!target || target.readyState !== BaseSocket.OPEN) return
                tokens -= 1
                target.send(JSON.stringify(frame))
            }
        }
        chain = chain.then(run, run).catch(err => console.warn('[agent relay] send failed:', err))
        return chain
    }

    function describe() {
        return {
            app,
            appVersion,
            apiVersion: API_VERSION,
            tab: tabId,
            title: document.title,
            visible: document.visibilityState === 'visible',
            commands: catalog(),
        }
    }

    async function storeImage(command, envelope, image) {
        const now = Date.now()
        while (uploads.length && now - uploads[0] > IMAGE_WINDOW_MS) uploads.shift()
        if (uploads.length >= IMAGE_LIMIT) {
            const retryAfter = Math.ceil((uploads[0] + IMAGE_WINDOW_MS - now) / 1000)
            return makeFailure(command, 'IMAGE_LIMIT',
                `This session already took ${IMAGE_LIMIT} images in ten minutes. Try again in ${retryAfter} seconds.`,
                { retryAfter }, envelope.state)
        }
        try {
            const id = await uploadImage(image)
            uploads.push(now)
            return { ...envelope, result: { ...envelope.result, image: { id, mimeType: image.type, bytes: image.size } } }
        } catch (err) {
            return makeFailure(command, 'IMAGE_UPLOAD_FAILED',
                `The image could not be added to the session: ${err?.message || err}`, {}, envelope.state)
        }
    }

    async function respond(frame, target) {
        const { command, args } = frame.body || {}
        let envelope
        if (command === 'describe') {
            envelope = makeSuccess('describe', describe(), null)
        } else if (frame.to !== tabId) {
            return
        } else if (typeof command !== 'string' || !command) {
            envelope = makeFailure('relay', 'INVALID_ARGS_REQUIRED', 'command is required', { field: 'command' })
        } else if (IMAGE_TEXT.test(JSON.stringify(args ?? {}))) {
            envelope = makeFailure(command, 'IMAGE_AS_TEXT',
                'Images travel through a session as bytes, never as text. Add the image with image-put and refer to it as image:<sha256>.')
        } else if (OUTSIDE_LINK.test(JSON.stringify(args ?? {}))) {
            envelope = makeFailure(command, 'OUTSIDE_LINK',
                'A program from a session cannot name media by an outside link. Add the image with image-put and refer to it as image:<sha256>.')
        } else {
            let out
            try {
                out = await invoke(command, args === undefined ? {} : args)
            } catch (err) {
                out = { envelope: makeFailure(command, 'INTERNAL_ERROR', err?.message || String(err)) }
            }
            envelope = out.envelope
            if (IMAGE_TEXT.test(JSON.stringify(envelope))) {
                envelope = makeFailure(command, 'IMAGE_AS_TEXT',
                    'The answer holds an image as text, which a session does not carry. Ask the person to share the image as a file.',
                    {}, envelope.state)
            } else if (envelope.ok && out.image) {
                envelope = await storeImage(command, envelope, out.image)
            }
        }
        await send(relayFrames({ kind: 'response', id: frame.id, from: tabId, app }, envelope), target)
    }

    function track(frame, target) {
        if (frame.type === 'welcome') {
            self = frame.you?.user_id || null
            owner = frame.owner?.user_id || null
            if (frame.session !== session) agents.clear()
            session = frame.session || null
        } else if (frame.type === 'owner-changed') {
            // The new owner travels in the envelope (Seance protocol section 4).
            owner = frame.user_id || null
            if (answering()) send(relayFrames({ kind: 'announce', from: tabId, app }, describe()), target)
        } else if (frame.type === 'session-snapshot' && answering()) {
            // Joined or resynced: tell any agent in the session that this tab answers.
            send(relayFrames({ kind: 'announce', from: tabId, app }, describe()), target)
        }
    }

    function onMessage(event) {
        const target = this
        if (typeof event.data !== 'string') return
        const data = event.data
        if (!data.includes(RELAY) && !data.includes('"welcome"') && !data.includes('"owner-changed"') &&
            !data.includes('"session-snapshot"')) return
        let frame
        try {
            frame = JSON.parse(data)
        } catch {
            return
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.type !== 'clicked-button') {
            track(frame, target)
            return
        }
        if (frame.relay !== RELAY || frame.kind !== 'request' || !answering()) return
        if (frame.to !== tabId && frame.to !== '*') return
        if (typeof frame.id !== 'string' || !frame.id || frame.id.length > 64) return
        let assembled
        try {
            assembled = assemble(frame)
        } catch {
            return
        }
        if (!assembled.done || !assembled.body || typeof assembled.body !== 'object') return
        // A flood of requests waits for no one: past a few, the tab drops them.
        if (pending >= MAX_PENDING) return
        if (typeof frame.connection_id === 'string' && !agents.has(frame.connection_id)) {
            agents.add(frame.connection_id)
            try {
                onAgent?.({ userId: frame.user_id, username: frame.username || '' })
            } catch (err) {
                console.warn('[agent relay] onAgent failed:', err)
            }
        }
        pending += 1
        respond({ ...frame, body: assembled.body }, target).finally(() => { pending -= 1 })
    }

    class RelaySocket extends BaseSocket {
        constructor(...args) {
            super(...args)
            socket = this
            self = null
            owner = null
            this.addEventListener('message', onMessage)
            this.addEventListener('close', () => {
                if (socket === this) socket = null
            })
        }
    }

    window.addEventListener('pagehide', () => {
        if (answering() && socket?.readyState === BaseSocket.OPEN) {
            socket.send(JSON.stringify(relayFrames({ kind: 'bye', from: tabId, app }, {})[0]))
        }
    })

    return { WebSocket: RelaySocket, tabId, sessionCreated, answers: answering }
}
