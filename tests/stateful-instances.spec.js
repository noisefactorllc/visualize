// SPDX-License-Identifier: MIT
/**
 * Each stateful effect instance in a chain must own its state and its sizing.
 *
 * The engine's expander used to scope every global_ texture by chain position
 * only, so two instances of a stateful effect in one chain (an inline surface
 * argument like blendMode(tex: reactionDiffusion(...)), or a repeated filter
 * like watercolor().watercolor()) read and wrote one state texture, and two
 * zoom-sized simulations shared one zoom_chain_N size. Visualize renders any
 * program a user loads, including share links with such chains, so both shapes
 * drew one simulation driving two pictures.
 *
 * The engine fix scopes private state per instance (the first instance keeps
 * the chain-scoped ID; each further instance appends its node) and gives each
 * further node its own node-scoped sizing parameter, while textures that
 * different effects deliberately share keep the chain scope. This pins that
 * contract at the product boundary, against the engine core this app actually
 * downloads from the CDN, with the same graph-level checks as the engine's
 * own test_stateful_instances.js: a recording backend captures every
 * allocation, so no rendering or GPU timing is involved. Every check runs
 * inside the page and reports a plain result, because module namespaces with
 * their functions cannot cross the evaluate boundary.
 */
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

installHandfishLocal(test)

test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

// Names every effect the checks below expand, so the deck's bundle loader
// registers their ops and enums in the page before compileGraph runs.
const REGISTER_DSL = 'search synth, mixer, filter\n' +
    'perlin().blendMode(tex: reactionDiffusion(zoom: x4)).watercolor().write(o0)'

async function withRegisteredEffects(page) {
    await page.goto('/')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    // The probe deck's load runs the product's own bundle-loading path for
    // every effect the checks name; after it, compileGraph can expand them.
    await page.evaluate(async (registerDsl) => {
        const { Deck } = await import('/js/noisemaker/deck.js')
        const canvas = document.createElement('canvas')
        const deck = new Deck(canvas, { id: 'probe', width: 128, height: 128 })
        await deck.init()
        const load = await deck.load(registerDsl, 'stateful-instance registration probe')
        deck.dispose()
        if (!load.success) throw new Error(`registration probe failed to compile: ${load?.error?.message || 'unknown error'}`)
    }, REGISTER_DSL)
}

// The graph-level contract checks, run in the page against the loaded engine
// core. Returns one { name, pass, message } record per check.
async function runChecks(page, checksName) {
    return page.evaluate(([registerDsl, name]) => {
        const checks = {
            async independentStateAndSizing() {
                const { _bundle } = await import('/js/noisemaker/bundle.js')

                class RecordingBackend {
                    textures = new Map()
                    createTexture(id, spec) { this.textures.set(id, { ...spec }) }
                    destroyTexture(id) { this.textures.delete(id) }
                }
                const build = (chain) => {
                    const graph = _bundle.compileGraph(`search synth, mixer, filter, render\n${chain}\nrender(o0)`)
                    const pipeline = new _bundle.Pipeline(graph, new RecordingBackend())
                    pipeline.width = 1024
                    pipeline.height = 1024
                    pipeline.createSurfaces()
                    return { graph, pipeline }
                }
                const instances = (graph, effectFunc, statePrefix) => {
                    const nodes = new Map()
                    for (const pass of graph.passes.filter(p => p.effectFunc === effectFunc)) {
                        if (!nodes.has(pass.nodeId)) {
                            nodes.set(pass.nodeId, { passes: [], textures: new Set(), stepIndex: pass.stepIndex })
                        }
                        const node = nodes.get(pass.nodeId)
                        node.passes.push(pass)
                        for (const texture of [...Object.values(pass.inputs || {}), ...Object.values(pass.outputs || {})]) {
                            if (typeof texture === 'string' && texture.startsWith(statePrefix)) node.textures.add(texture)
                        }
                    }
                    return [...nodes.values()].map(node => {
                        if (node.textures.size !== 1) {
                            throw new Error(`an instance's passes must share one state, got ${node.textures.size}`)
                        }
                        return { ...node, texture: [...node.textures][0] }
                    })
                }
                const assertSize = (pipeline, texture, size) => {
                    for (const side of ['read', 'write']) {
                        const spec = pipeline.backend.textures.get(`${texture}_${side}`)
                        if (!spec) throw new Error(`${texture}_${side} must be allocated`)
                        if (spec.width !== size || spec.height !== size) {
                            throw new Error(`${texture}_${side} is ${spec.width}x${spec.height}, expected ${size}x${size}`)
                        }
                    }
                }

                const results = []

                // An inline surface argument: two reactionDiffusion simulations
                // in one chain, sized by zoom x4 and x16. Independent state
                // textures with independent sizes, and each pass's zoom bound
                // to its own instance's sizing parameter with its own value.
                try {
                    const a = build('reactionDiffusion(zoom: x4).blendMode(tex: reactionDiffusion(zoom: x16)).write(o0)')
                    const aNodes = instances(a.graph, 'reactionDiffusion', 'global_rd_state')
                    if (aNodes.length !== 2) throw new Error(`expected 2 reactionDiffusion instances, got ${aNodes.length}`)
                    if (aNodes[0].texture === aNodes[1].texture) throw new Error('state textures must be distinct')
                    assertSize(a.pipeline, aNodes[0].texture, 256)
                    assertSize(a.pipeline, aNodes[1].texture, 64)
                    for (const [index, node] of aNodes.entries()) {
                        const sizingParam = a.graph.textures.get(node.texture).width.screenDivide
                        for (const pass of node.passes) {
                            if (pass.scopedParams.zoom !== sizingParam) {
                                throw new Error(`instance ${index} does not scope its own sizing parameter`)
                            }
                            if (pass.uniforms[sizingParam] !== [4, 16][index]) {
                                throw new Error(`instance ${index} zoom is ${pass.uniforms[sizingParam]}, expected ${[4, 16][index]}`)
                            }
                        }
                    }
                    results.push({ name: 'inline surface argument: independent state, sizes and zoom uniforms', pass: true })
                } catch (err) {
                    results.push({ name: 'inline surface argument: independent state, sizes and zoom uniforms', pass: false, message: String(err && err.message || err) })
                }

                // Changing one instance's zoom must leave the other's state
                // size and uniform intact: the sizing parameter belongs to one
                // node only.
                try {
                    const a = build('reactionDiffusion(zoom: x4).blendMode(tex: reactionDiffusion(zoom: x16)).write(o0)')
                    const aNodes = instances(a.graph, 'reactionDiffusion', 'global_rd_state')
                    const renderer = Object.create(_bundle.CanvasRenderer.prototype)
                    renderer._pipeline = a.pipeline
                    renderer.applyStepParameterValues({ [`step_${aNodes[1].stepIndex}`]: { zoom: 2 } })
                    assertSize(a.pipeline, aNodes[0].texture, 256)
                    assertSize(a.pipeline, aNodes[1].texture, 512)
                    renderer.applyStepParameterValues({ [`step_${aNodes[0].stepIndex}`]: { zoom: 32 } })
                    assertSize(a.pipeline, aNodes[0].texture, 32)
                    assertSize(a.pipeline, aNodes[1].texture, 512)
                    for (const pass of aNodes[1].passes) {
                        if (pass.uniforms.zoom !== 2) {
                            throw new Error(`the other instance's zoom moved to ${pass.uniforms.zoom}`)
                        }
                    }
                    results.push({ name: 'runtime zoom update touches only its own instance', pass: true })
                } catch (err) {
                    results.push({ name: 'runtime zoom update touches only its own instance', pass: false, message: String(err && err.message || err) })
                }

                // A repeated filter: two watercolor instances ping-pong their
                // own state.
                try {
                    const c = build('perlin().watercolor().watercolor().write(o0)')
                    const cNodes = instances(c.graph, 'watercolor', 'global_wc_state')
                    if (cNodes.length !== 2) throw new Error(`expected 2 watercolor instances, got ${cNodes.length}`)
                    if (cNodes[0].texture === cNodes[1].texture) throw new Error('ping-pong textures must be distinct')
                    results.push({ name: 'repeated filter: independent ping-pong state', pass: true })
                } catch (err) {
                    results.push({ name: 'repeated filter: independent ping-pong state', pass: false, message: String(err && err.message || err) })
                }

                // Legacy compatibility: the first (or only) instance keeps the
                // chain-scoped ID.
                try {
                    const single = build('perlin().watercolor().write(o0)')
                    const nodes = instances(single.graph, 'watercolor', 'global_wc_state')
                    if (nodes.length !== 1) throw new Error(`expected 1 watercolor instance, got ${nodes.length}`)
                    if (nodes[0].texture !== 'global_wc_state_chain_0') {
                        throw new Error(`the single instance's state is ${nodes[0].texture}, expected global_wc_state_chain_0`)
                    }
                    results.push({ name: 'single instance keeps the legacy chain-scoped state ID', pass: true })
                } catch (err) {
                    results.push({ name: 'single instance keeps the legacy chain-scoped state ID', pass: false, message: String(err && err.message || err) })
                }

                return results
            },
        }
        if (!checks[name]) throw new Error(`unknown check set: ${name}`)
        return checks[name]()
    }, [REGISTER_DSL, checksName])
}

test('two stateful instances in one chain keep independent state and sizing', async ({ page }) => {
    await withRegisteredEffects(page)
    const results = await runChecks(page, 'independentStateAndSizing')
    for (const result of results) {
        expect(result.pass, `${result.name}: ${result.message || 'ok'}`).toBe(true)
    }
})
