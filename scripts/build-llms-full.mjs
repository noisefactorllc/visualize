/**
 * Writes llms-full.txt: the text of llms.txt, then a reference for every
 * VisualizeAgent command, built from js/agent/descriptions.js and
 * js/agent/schemas.js.
 *
 * Run `node scripts/build-llms-full.mjs` after you change llms.txt, a
 * description or a schema. tests/agent-llms.node-test.js fails when
 * llms-full.txt is stale.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { COMMAND_GROUPS } from '../js/agent/descriptions.js'
import { SCHEMAS } from '../js/agent/schemas.js'

export const LLMS_PATH = fileURLToPath(new URL('../llms.txt', import.meta.url))
export const LLMS_FULL_PATH = fileURLToPath(new URL('../llms-full.txt', import.meta.url))

const code = (value) => `\`${value}\``

function describeType(spec) {
    const parts = [spec.type]
    if (spec.enum) parts.push(`one of ${spec.enum.map(code).join(', ')}`)
    if (typeof spec.min === 'number' && typeof spec.max === 'number') parts.push(`from ${spec.min} to ${spec.max}`)
    if (typeof spec.minLength === 'number') {
        parts.push(`at least ${spec.minLength} character${spec.minLength === 1 ? '' : 's'}`)
    }
    if (spec.default !== undefined) parts.push(`default ${code(spec.default)}`)
    return parts.join(', ')
}

function commandSection(name, { does, returns, remote }) {
    const schema = SCHEMAS[name]
    const required = new Set(schema?.required || [])
    const fields = Object.entries(schema?.properties || {}).map(([field, spec]) =>
        `- ${code(field)}${required.has(field) ? ' (required)' : ''}: ${describeType(spec)}`)
    const lines = [`#### ${code(name)}`, '', does, '', `Returns: ${returns}.`, '']
    if (remote === false) lines.push('Browser only: through a Seance session it fails with `REMOTE_UNAVAILABLE`.', '')
    if (fields.length) lines.push('Arguments:', '', ...fields)
    else lines.push('Arguments: none.')
    lines.push('')
    return lines.join('\n')
}

export function renderReference() {
    const total = COMMAND_GROUPS.reduce((n, group) => n + Object.keys(group.commands).length, 0)
    const out = [
        '## Command reference',
        '',
        `Visualize has ${total} commands. Call a command as \`await window.VisualizeAgent.<name>(args)\`,`,
        'as the WebMCP tool `visualize_<name>`, or through a Seance session with `seance-agent.mjs call <name>`.',
        'Every command rejects an argument that it does not declare, with `INVALID_ARGS_UNKNOWN`.',
        '',
    ]
    for (const group of COMMAND_GROUPS) {
        out.push(`### ${group.title}`, '')
        for (const [name, entry] of Object.entries(group.commands)) {
            out.push(commandSection(name, entry))
        }
    }
    return out.join('\n')
}

export async function renderLlmsFull() {
    const base = await readFile(LLMS_PATH, 'utf8')
    return `${base.trimEnd()}\n\n---\n\n${renderReference()}`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await writeFile(LLMS_FULL_PATH, await renderLlmsFull())
}
