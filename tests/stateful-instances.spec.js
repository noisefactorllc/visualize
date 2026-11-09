// SPDX-License-Identifier: MIT
/**
 * Each stateful effect instance in a chain must own its state and its sizing.
 *
 * The engine's expander used to scope every global_ texture by chain position
 * only, so a repeat of a stateful effect in a chain (an inline surface
 * argument like blendMode(tex: reactionDiffusion(...)), or a repeated filter
 * like watercolor().watercolor()) read and wrote the same state texture as
 * its earlier instance, and zoom-sized simulations in a chain shared the same
 * zoom_chain_N size. Visualize renders any program a user loads, including
 * share links with such chains, so the rendered pictures carried state that
 * an instance does not own.
 *
 * The engine fix scopes private state per instance (an instance keeps the
 * chain-scoped ID until the same effect appears again in the chain; the
 * repeat appends its node) and gives any node after the sizing node its own
 * node-scoped sizing parameter, while textures that
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
// registers their ops and enums in the page before compileGraph runs. The
// render program registers the loop effects the accumulator check names.
const REGISTER_DSL = 'search synth, mixer, filter\n' +
    'perlin().blendMode(tex: reactionDiffusion(zoom: x4)).watercolor().write(o0)'
const REGISTER_RENDER_DSL = 'search synth, render\n' +
    'perlin().loopBegin().loopEnd().write(o0)'

async function withRegisteredEffects(page) {
    await page.goto('/')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.decks?.B,
        null, { timeout: 60_000 * SCALE })

    // The probe deck's load runs the product's own bundle-loading path for
    // every effect the checks name; after it, compileGraph can expand them.
    await page.evaluate(async ([registerDsl, registerRenderDsl]) => {
        const { Deck } = await import('/js/noisemaker/deck.js')
        for (const [index, dsl] of [registerDsl, registerRenderDsl].entries()) {
            const canvas = document.createElement('canvas')
            const deck = new Deck(canvas, { id: `probe${index}`, width: 128, height: 128 })
            await deck.init()
            const load = await deck.load(dsl, 'stateful-instance registration probe')
            deck.dispose()
            if (!load.success) throw new Error(`registration probe failed to compile: ${load?.error?.message || 'unknown error'}`)
        }
    }, [REGISTER_DSL, REGISTER_RENDER_DSL])
}

// The graph-level contract checks, run in the page against the loaded engine
// core. Returns a { name, pass, message } record per check.
async function runChecks(page, checksName) {
    return page.evaluate(([registerDsl, name]) => {
        const checks = {
            async independentStateAndSizing() {
                const { _bundle } = await import('/js/noisemaker/bundle.js')

                const describeError = (err) => {
                    if (!err) return 'unknown error'
                    if (typeof err.message === 'string') return err.message
                    try { return JSON.stringify(err.message ?? err) } catch { return String(err) }
                }

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

                // An inline surface argument: a reactionDiffusion simulation
                // blended over another, sized by zoom x4 and x16. Independent
                // state textures with independent sizes, and each pass's zoom
                // bound to its own instance's sizing parameter with its own
                // value.
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
                    results.push({ name: 'inline surface argument: independent state, sizes and zoom uniforms', pass: false, message: describeError(err) })
                }

                // Changing an instance's zoom must leave the other instance's
                // state size and uniform intact: a sizing parameter belongs to
                // the node that claims it, not to the chain.
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
                    results.push({ name: 'runtime zoom update touches only its own instance', pass: false, message: describeError(err) })
                }

                // A repeated filter: every watercolor instance ping-pongs its
                // own state.
                try {
                    const c = build('perlin().watercolor().watercolor().write(o0)')
                    const cNodes = instances(c.graph, 'watercolor', 'global_wc_state')
                    if (cNodes.length !== 2) throw new Error(`expected 2 watercolor instances, got ${cNodes.length}`)
                    if (cNodes[0].texture === cNodes[1].texture) throw new Error('ping-pong textures must be distinct')
                    results.push({ name: 'repeated filter: independent ping-pong state', pass: true })
                } catch (err) {
                    results.push({ name: 'repeated filter: independent ping-pong state', pass: false, message: describeError(err) })
                }

                // Legacy compatibility: an instance without a repeat keeps the
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
                    results.push({ name: 'single instance keeps the legacy chain-scoped state ID', pass: false, message: describeError(err) })
                }

                // A repeat with an explicit zoom beside a default zoom: every
                // instance keeps its own zoom value, and the default sizing
                // stays at the engine's default state size.
                try {
                    const d = build('reactionDiffusion(zoom: x4).blendMode(tex: reactionDiffusion()).blendMode(tex: reactionDiffusion(zoom: x16)).write(o0)')
                    const dNodes = instances(d.graph, 'reactionDiffusion', 'global_rd_state')
                    const textures = new Set(dNodes.map(node => node.texture))
                    if (dNodes.length !== 3 || textures.size !== 3) {
                        throw new Error(`expected 3 distinct state textures, got ${textures.size} for ${dNodes.length} instances`)
                    }
                    assertSize(d.pipeline, dNodes[0].texture, 256)
                    assertSize(d.pipeline, dNodes[1].texture, 128)
                    assertSize(d.pipeline, dNodes[2].texture, 64)
                    results.push({ name: 'explicit and default zooms size their own state', pass: true })
                } catch (err) {
                    results.push({ name: 'explicit and default zooms size their own state', pass: false, message: describeError(err) })
                }

                // Loop accumulators are deliberately shared: loopBegin and
                // loopEnd in a chain keep the chain-scoped accumulator ID.
                try {
                    for (const chain of [
                        'perlin().loopBegin().loopEnd().write(o0)',
                        'perlin().loopBegin().loopEnd().loopBegin().loopEnd().write(o0)',
                    ]) {
                        const l = build(chain)
                        for (const pass of l.graph.passes) {
                            if (pass.effectFunc === 'loopBegin' && pass.inputs.accumTex !== 'global_accum_chain_0') {
                                throw new Error(`loopBegin reads ${pass.inputs.accumTex}, expected the shared chain accumulator`)
                            }
                            if (pass.effectFunc === 'loopEnd' && pass.outputs.fragColor.startsWith('global_') &&
                                pass.outputs.fragColor !== 'global_accum_chain_0') {
                                throw new Error(`loopEnd writes ${pass.outputs.fragColor}, expected the shared chain accumulator`)
                            }
                        }
                    }
                    results.push({ name: 'loop accumulators keep the shared chain scope', pass: true })
                } catch (err) {
                    results.push({ name: 'loop accumulators keep the shared chain scope', pass: false, message: describeError(err) })
                }

                return results
            },
        }
        if (!checks[name]) throw new Error(`unknown check set: ${name}`)
        return checks[name]()
    }, [REGISTER_DSL, checksName])
}

test('stateful instances in a chain keep independent state and sizing', async ({ page }) => {
    await withRegisteredEffects(page)
    const results = await runChecks(page, 'independentStateAndSizing')
    for (const result of results) {
        expect(result.pass, `${result.name}: ${result.message || 'ok'}`).toBe(true)
    }
})
