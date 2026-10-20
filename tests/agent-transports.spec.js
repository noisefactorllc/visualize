// SPDX-License-Identifier: MIT
/**
 * The browser routes of the agent contract other than page JavaScript: WebMCP
 * tools named visualize_<command>. The agent API shows nothing on the page.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { routePortableImagesLocal } from './seanceLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

const RED = 'search synth\nsolid(color: [1, 0, 0]).write(o0)\nrender(o0)'
const LIGHT_PROGRAMS = [
    { title: 'agent red', tagline: 'test program', tint: '#ff0000', tags: ['abstract'], category: 'abstract', dsl: RED },
    { title: 'agent blue', tagline: 'test program', tint: '#0000ff', tags: ['abstract'], category: 'abstract', dsl: 'search synth\nsolid(color: [0, 0, 1]).write(o0)\nrender(o0)' },
]

async function routeApp(page) {
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routePortableImagesLocal(page)
    await page.route('**/data/programs.json', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(LIGHT_PROGRAMS),
    }))
}

test('commands wait for startup without a separate ready call', async ({ page }) => {
    await routeApp(page)
    await page.goto('/')
    await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
    const env = await page.evaluate(() => window.VisualizeAgent.getState())
    expect(env.ok).toBe(true)
    expect(env.state.decks.A.running).toBe(true)
    expect(env.state.decks.B.running).toBe(true)
})

test('WebMCP registers all commands and executes real handlers after readiness', async ({ page }) => {
    // Capture the native registration boundary in browsers without WebMCP.
    // The callbacks below are the actual app handlers, not command mocks.
    await page.addInitScript(() => {
        const tools = new Map()
        Object.defineProperty(document, 'modelContext', { value: {
            registerTool(tool) { tools.set(tool.name, tool) },
        } })
        window.registeredAgentTools = tools
    })
    await routeApp(page)
    await page.goto('/')
    await page.waitForFunction(() => window.VisualizeAgent?.setProgram, null, { timeout: 60_000 * SCALE })
    const out = await page.evaluate(async dsl => {
        const tools = window.registeredAgentTools
        const names = Array.from(tools.keys())
        const set = await tools.get('visualize_setProgram').execute({ dsl, deck: 'B' })
        const invalid = await tools.get('visualize_setProgram').execute({ dsl: 'x', force: true })
        const program = await tools.get('visualize_getProgram').execute({ deck: 'B' })
        const thumbnail = await tools.get('visualize_getThumbnail').execute({ maxDimension: 64, format: 'png' })
        const { COMMAND_GROUPS } = await import('/js/agent/descriptions.js')
        return {
            names, set, invalid, program,
            described: COMMAND_GROUPS.flatMap(group => Object.keys(group.commands)),
            thumbnail: { ...thumbnail, content: thumbnail.content.map(c => c.type === 'image' ? { ...c, data: c.data.slice(0, 12) } : c) },
            schema: tools.get('visualize_getThumbnail').inputSchema,
            readOnly: tools.get('visualize_getProgram').annotations.readOnlyHint,
            mutation: tools.get('visualize_setProgram').annotations.readOnlyHint,
        }
    }, RED)
    expect(out.names.sort()).toEqual(out.described.map(name => `visualize_${name}`).sort())
    expect(out.set.isError).toBe(false)
    expect(JSON.parse(out.program.content[0].text).result.dsl).toBe(RED)
    expect(out.invalid.isError).toBe(true)
    expect(JSON.parse(out.invalid.content[0].text).error.code).toBe('INVALID_ARGS_UNKNOWN')
    expect(out.thumbnail.content.find(c => c.type === 'image')).toMatchObject({ mimeType: 'image/png' })
    expect(out.thumbnail.content.find(c => c.type === 'text').text).not.toContain('"bytes"')
    expect(out.schema.properties.maxDimension).toMatchObject({ minimum: 16, maximum: 1024 })
    expect(out.schema.properties.source.enum).toEqual(['output', 'A', 'B'])
    expect(out.readOnly).toBe(true)
    expect(out.mutation).toBe(false)
})

test('an unavailable WebMCP registration does not break commands', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(document, 'modelContext', { value: {
            registerTool() { return Promise.reject(new Error('registration unavailable')) },
        } })
    })
    await routeApp(page)
    await page.goto('/')
    await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
    const env = await page.evaluate(() => window.VisualizeAgent.getState())
    expect(env.ok).toBe(true)
})

test('the agent API adds nothing to the page, even with ?agent=1', async ({ page }) => {
    await routeApp(page)
    const elements = async query => {
        await page.goto(`/${query}`)
        await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
        await page.evaluate(() => window.VisualizeAgent.ready)
        return page.evaluate(() => ({
            ids: [...document.querySelectorAll('[id]')].map(el => el.id).filter(id => !/^hf-/.test(id)).sort(),
            styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href')).sort(),
        }))
    }
    const plain = await elements('')
    const asked = await elements('?agent=1')
    expect(asked).toEqual(plain)
    await expect(page.getByRole('region', { name: 'Visualize agent' })).toHaveCount(0)
})
