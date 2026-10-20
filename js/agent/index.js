/**
 * Visualize Agent API: a JSON command surface on window.VisualizeAgent for
 * software agents that control Visualize. The same commands are WebMCP tools
 * named visualize_<command> and, while the person's set is online, requests
 * from an agent in their Seance session (relay.js). None of it shows anything
 * on the page. The contract is llms.txt at the site root; llms-full.txt adds
 * the command reference rendered from descriptions.js and schemas.js.
 *
 * @module agent
 */

import { API_VERSION, makeFailure, registerCommand, runCommand } from './dispatcher.js'
import { SCHEMAS } from './schemas.js'
import * as commands from './commands.js'
import { catalog, registerWebMCP, REMOTE } from './transports.js'
import { createAgentRelay } from './relay.js'

let _readyResolve
export const VisualizeAgent = {
    version: API_VERSION,
    ready: new Promise((resolve) => { _readyResolve = resolve }),
}

if (typeof window !== 'undefined') {
    window.VisualizeAgent = VisualizeAgent
}

/**
 * Register every command. Call once, after the decks, the library, the mixer
 * and the scenes exist. `ready` resolves later, from markAgentReady().
 *
 * @param {object} ctx - App references and the functions behind the controls (see commands.js).
 */
export function bootstrapAgent(ctx) {
    Object.defineProperty(VisualizeAgent, '_ctx', { value: ctx, enumerable: false })
    for (const name of Object.keys(SCHEMAS)) {
        registerCommand(VisualizeAgent, name, commands[name])
    }
    registerWebMCP(VisualizeAgent)
}

/**
 * Resolve `ready` once startup has finished, so an agent's first command
 * does not race the startup program loads.
 */
export function markAgentReady() {
    _readyResolve()
}

/**
 * The Seance relay for this tab (see relay.js): its WebSocket class goes to the
 * Seance SDK, sessionCreated marks a session this tab took online, and onAgent
 * hears the first request from each agent. Only that tab answers, while it
 * owns the session, and only commands not marked `remote: false`.
 *
 * @param {{appVersion: string, uploadImage: (blob: Blob) => Promise<string>, onAgent?: Function, BaseSocket?: typeof WebSocket}} options
 * @returns {{ WebSocket: typeof WebSocket, sessionCreated: (sessionId: string) => void }}
 */
export function createSeanceAgentRelay({ appVersion, uploadImage, onAgent, BaseSocket }) {
    return createAgentRelay({
        app: 'visualize',
        appVersion,
        catalog,
        uploadImage,
        onAgent,
        ...(BaseSocket ? { BaseSocket } : {}),
        async invoke(command, args) {
            if (!Object.hasOwn(SCHEMAS, command)) {
                return { envelope: makeFailure(command, 'NOT_FOUND_COMMAND', `Unknown command: ${command}`) }
            }
            if (!REMOTE.has(command)) {
                return {
                    envelope: makeFailure(command, 'REMOTE_UNAVAILABLE',
                        `${command} runs only in the person's browser, not through a session.`),
                }
            }
            await VisualizeAgent.ready
            return runCommand(command, args, { remote: true })
        },
    })
}
