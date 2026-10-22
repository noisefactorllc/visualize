// SPDX-License-Identifier: MIT
//
// Guards the agent contract: every command is described and handled,
// llms-full.txt is current, llms.txt lists exactly the error codes that the
// agent API returns, and documented defaults match the handlers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { COMMAND_GROUPS } from '../js/agent/descriptions.js'
import { SCHEMAS, validate } from '../js/agent/schemas.js'
import { REMOTE, catalog } from '../js/agent/transports.js'
import { LLMS_PATH, LLMS_FULL_PATH, renderLlmsFull } from '../scripts/build-llms-full.mjs'

const AGENT_DIR = new URL('../js/agent/', import.meta.url)
const described = () => COMMAND_GROUPS.flatMap(group => Object.keys(group.commands))

test('every command has exactly one description and one schema entry', () => {
    const names = described()
    assert.deepEqual(names.filter((name, i) => names.indexOf(name) !== i), [], 'a command is described twice')
    assert.deepEqual([...names].sort(), Object.keys(SCHEMAS).sort())
    for (const group of COMMAND_GROUPS) {
        for (const [name, entry] of Object.entries(group.commands)) {
            assert.ok(entry.does && entry.returns, `${name} needs does and returns`)
        }
    }
})

test('every command has a handler in commands.js', async () => {
    const source = await readFile(new URL('commands.js', AGENT_DIR), 'utf8')
    const handlers = new Set([...source.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]))
    assert.deepEqual(Object.keys(SCHEMAS).filter(name => !handlers.has(name)), [])
})

// The shared nf-agent/1 relay, byte for byte. Update it only by copying the
// reviewed relay, and update this digest with it.
const SHARED_RELAY_SHA256 = '976b8550a2ec439e8d79b61fac1a32fabb2eb53e80e6cd73e2a2d20fc1b8a867'

test('the relay copy is the shared agent relay (nf-agent/1)', async () => {
    const relay = await readFile(new URL('relay.js', AGENT_DIR))
    assert.equal(createHash('sha256').update(relay).digest('hex'), SHARED_RELAY_SHA256)
})

test('llms-full.txt matches a fresh render (run node scripts/build-llms-full.mjs)', async () => {
    assert.equal(await readFile(LLMS_FULL_PATH, 'utf8'), await renderLlmsFull())
})

test('llms.txt lists every error code that the agent API returns, and no other', async () => {
    const codes = new Set()
    for (const name of await readdir(AGENT_DIR)) {
        if (!name.endsWith('.js')) continue
        const source = await readFile(new URL(name, AGENT_DIR), 'utf8')
        // commandError('X', ...), fail('X', ...), makeFailure(name, 'X', ...), makeFailure('relay', 'X', ...)
        const pattern = /(?:commandError|fail)\(\s*'([A-Z][A-Z_]+)'|makeFailure\(\s*[\w']+,\s*'([A-Z][A-Z_]+)'/g
        for (const m of source.matchAll(pattern)) codes.add(m[1] || m[2])
    }
    for (const code of ['INVALID_PROGRAM', 'INVALID_ARGS_UNKNOWN', 'REMOTE_UNAVAILABLE', 'NOT_FOUND_COMMAND', 'IMAGE_UPLOAD_FAILED', 'IMAGE_LIMIT', 'IMAGE_AS_TEXT', 'OUTSIDE_LINK', 'INTERNAL_ERROR']) {
        assert.ok(codes.has(code), `the code scan no longer finds ${code}`)
    }
    const llms = await readFile(LLMS_PATH, 'utf8')
    assert.deepEqual([...codes].filter(code => !llms.includes(`| \`${code}\` |`)).sort(), [])
    // And the reverse: the table lists no code that the API no longer returns.
    const listed = [...llms.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm)].map(m => m[1])
    assert.deepEqual(listed.filter(code => !codes.has(code)).sort(), [])
})

test('llms.txt describes the Seance route first and uses no em dash', async () => {
    const llms = await readFile(LLMS_PATH, 'utf8')
    const seance = llms.indexOf('node seance-agent.mjs join')
    assert.ok(seance > 0, 'the Seance route is missing')
    assert.ok(seance < llms.indexOf('WebMCP'), 'the Seance route must come before the browser routes')
    assert.ok(llms.includes('curl -fsSLO https://noisedeck.app/agent/seance-agent.mjs'))
    assert.ok(llms.includes('https://noisemaker.app/llms-full.txt'))
    for (const text of [llms, await readFile(LLMS_FULL_PATH, 'utf8')]) {
        assert.ok(!text.includes('\u2014'), 'llms text must not contain an em dash')
    }
})

test('commands that act on the person\'s browser or touch their stored data are not remote', () => {
    const local = Object.keys(SCHEMAS).filter(name => !REMOTE.has(name)).sort()
    assert.deepEqual(local, ['listScenes', 'listUserEffects', 'record', 'scene', 'setAudio', 'setAudioInput',
        'setAutoVjPool', 'setMidiInput', 'setRenderer'])
    const remoteFlags = Object.fromEntries(catalog().map(entry => [entry.name, entry.remote]))
    assert.equal(remoteFlags.record, false)
    assert.equal(remoteFlags.setProgram, true)
})

test('a command with no arguments accepts only an empty object', () => {
    for (const [name, schema] of Object.entries(SCHEMAS)) {
        if (Object.keys(schema.properties).length) continue
        assert.equal(validate({}, schema).ok, true, name)
        assert.equal(validate({ force: true }, schema).code, 'INVALID_ARGS_UNKNOWN', name)
        assert.equal(validate('x', schema).code, 'INVALID_ARGS_TYPE', name)
    }
})

test('documented defaults match the handler defaults', async () => {
    const source = await readFile(new URL('commands.js', AGENT_DIR), 'utf8')
    for (const [name, schema] of Object.entries(SCHEMAS)) {
        for (const [field, spec] of Object.entries(schema.properties)) {
            if (spec.default === undefined) continue
            const literal = typeof spec.default === 'string' ? `'${spec.default}'` : String(spec.default)
            const signature = new RegExp(`export async function ${name}\\(\\{[^)]*\\b${field} = ${literal}[,\\s}]`)
            assert.match(source, signature, `${name}.${field} default ${literal}`)
        }
    }
})

test('schemas reject undeclared fields and accept declared ones', () => {
    assert.equal(validate({ dsl: 'x' }, SCHEMAS.setProgram).ok, true)
    assert.equal(validate({ dsl: 'x', deck: 'B' }, SCHEMAS.setProgram).ok, true)
    assert.equal(validate({ dsl: 'x', deck: 'C' }, SCHEMAS.setProgram).code, 'INVALID_ARGS_ENUM')
    assert.equal(validate({ dsl: 'x', force: true }, SCHEMAS.setProgram).code, 'INVALID_ARGS_UNKNOWN')
    assert.equal(validate({}, SCHEMAS.setProgram).code, 'INVALID_ARGS_REQUIRED')
    assert.equal(validate({ maxDimension: 2048 }, SCHEMAS.getThumbnail).code, 'INVALID_ARGS_RANGE')
    assert.equal(validate({ source: 'C' }, SCHEMAS.getThumbnail).code, 'INVALID_ARGS_ENUM')
    assert.equal(validate({ position: 1.5 }, SCHEMAS.setCrossfader).code, 'INVALID_ARGS_RANGE')
    assert.equal(validate({ effect: 'mixer/blendMode', params: { mode: 'screen' } }, SCHEMAS.setMixer).ok, true)
    assert.equal(validate({ action: 'rename' }, SCHEMAS.scene).code, 'INVALID_ARGS_REQUIRED')
    assert.equal(validate({ source: 'midi:16' }, SCHEMAS.setAutoMix).ok, true)
    assert.equal(validate({ source: 'midi:17' }, SCHEMAS.setAutoMix).code, 'INVALID_ARGS_ENUM')
})
