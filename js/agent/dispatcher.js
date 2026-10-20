/**
 * Command dispatcher for VisualizeAgent.
 *
 * Every command runs one at a time, validates its arguments against its
 * schema, and returns an envelope with a fresh state snapshot:
 *   { ok, command, apiVersion, result | error, state, warnings? }
 *
 * @module agent/dispatcher
 */

import { SCHEMAS, validate } from './schemas.js'
import { buildSnapshot } from './snapshot.js'

/** Wire protocol version. Bump only for breaking envelope or command changes. */
export const API_VERSION = '1.0'

let _tail = Promise.resolve()

function serialize(fn) {
    const next = _tail.then(fn, fn)
    _tail = next.catch(() => {})
    return next
}

export function makeSuccess(command, result, state, warnings = []) {
    const env = { ok: true, command, apiVersion: API_VERSION, result, state }
    if (warnings.length) env.warnings = warnings
    return env
}

export function makeFailure(command, code, message, details = {}, state = null) {
    return { ok: false, command, apiVersion: API_VERSION, error: { code, message, details }, state }
}

/**
 * Throw from a handler to return a failure envelope with this code.
 */
export function commandError(code, message, details = {}) {
    const err = new Error(message)
    err.__agentError = { code, message, details }
    return err
}

function safeSnapshot(ctx) {
    try {
        return buildSnapshot(ctx)
    } catch (err) {
        console.warn('[agent] snapshot failed:', err)
        return null
    }
}

const RUNNERS = new Map()

/**
 * Register a command on the agent object.
 *
 * A handler that produces an image returns it as a Blob in `image`. The
 * in-page method puts its bytes in the result as base64; runCommand hands the
 * Blob itself to transports that carry binary bytes.
 *
 * The third handler argument says how the command arrived: `{ remote: true }`
 * for a request from a Seance session, which everyone in the session can read.
 *
 * @param {object} agent - The VisualizeAgent object; `agent._ctx` holds app references.
 * @param {string} name - Command name.
 * @param {(args: object, ctx: object, via: {remote?: boolean}) => Promise<{result: any, image?: Blob, warnings?: Array}>} handler
 */
export function registerCommand(agent, name, handler) {
    const run = (args = {}, via = {}) => serialize(async () => {
        const ctx = agent._ctx
        try {
            await agent.ready
            const schema = SCHEMAS[name]
            if (schema) {
                const v = validate(args, schema)
                if (!v.ok) return { envelope: makeFailure(name, v.code, v.message, v.details, safeSnapshot(ctx)) }
            }
            const out = await handler(args, ctx, via)
            return { envelope: makeSuccess(name, out.result, safeSnapshot(ctx), out.warnings || []), image: out.image || null }
        } catch (err) {
            const state = safeSnapshot(ctx)
            if (err?.__agentError) {
                const { code, message, details } = err.__agentError
                return { envelope: makeFailure(name, code, message, details, state) }
            }
            return { envelope: makeFailure(name, 'INTERNAL_ERROR', err?.message || String(err), {}, state) }
        }
    })
    RUNNERS.set(name, run)
    agent[name] = async (args = {}) => inlineImage(await run(args))
}

/**
 * Run a registered command for a transport that carries binary bytes.
 *
 * @param {{remote?: boolean}} [via] - How the command arrived (see registerCommand).
 * @returns {Promise<{envelope: object, image?: Blob}>}
 */
export function runCommand(name, args = {}, via = {}) {
    const run = RUNNERS.get(name)
    if (!run) return Promise.resolve({ envelope: makeFailure(name, 'NOT_FOUND_COMMAND', `Unknown command: ${name}`) })
    return run(args, via)
}

async function inlineImage({ envelope, image }) {
    if (!image) return envelope
    const bytes = new Uint8Array(await image.arrayBuffer())
    let binary = ''
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
    }
    return { ...envelope, result: { bytes: btoa(binary), ...envelope.result } }
}
