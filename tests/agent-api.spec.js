// SPDX-License-Identifier: MIT
/**
 * VisualizeAgent: the in-page command surface that llms.txt documents. Every
 * command runs the code behind a control, so these specs check both the
 * envelope and the control the person sees.
 */
import { test, expect } from '@playwright/test'
import { routeHandfishLocal, routeEngineLocal } from './handfishLocal.js'
import { routePortableImagesLocal } from './seanceLocal.js'

const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')
test.describe.configure({ timeout: 120_000 * SCALE, retries: 0 })

const RED = 'search synth\nsolid(color: [1, 0, 0]).write(o0)\nrender(o0)'
const GREEN = 'search synth\nsolid(color: [0, 1, 0]).write(o0)\nrender(o0)'
const BLUE = 'search synth\nsolid(color: [0, 0, 1]).write(o0)\nrender(o0)'
const LIGHT_PROGRAMS = [
    { title: 'agent red', tagline: 'red test program', tint: '#ff0000', tags: ['abstract', 'bass'], category: 'abstract', dsl: RED },
    { title: 'agent green', tagline: 'green test program', tint: '#00ff00', tags: ['abstract'], category: 'abstract', dsl: GREEN },
    { title: 'agent blue', tagline: 'blue test program', tint: '#0000ff', tags: ['geometric'], category: 'geometric', dsl: BLUE },
    { title: 'agent noise', tagline: 'noise test program', tint: '#888888', tags: ['geometric'], category: 'geometric', dsl: 'search synth\nnoise(seed: 7, ridges: true).write(o0)\nrender(o0)' },
    { title: 'Camera Input', tagline: 'utility', tint: '#888888', tags: ['util'], mediaSource: 'camera', dsl: 'search synth\nmedia().write(o0)\nrender(o0)' },
]

async function openVisualize(page, query = '') {
    await routeHandfishLocal(page)
    await routeEngineLocal(page)
    await routePortableImagesLocal(page)
    await page.route('**/data/programs.json', route => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(LIGHT_PROGRAMS),
    }))
    await page.goto(`/${query}`)
    await page.waitForFunction(() => window.VisualizeAgent?.getState, null, { timeout: 60_000 * SCALE })
    await page.evaluate(() => window.VisualizeAgent.ready)
}

function canvasPixel(page, which) {
    return page.evaluate(id => {
        const source = id === 'output' ? document.getElementById('main-canvas') : window.__visualize.decks[id].canvas
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.drawImage(source, source.width / 2, source.height / 2, 1, 1, 0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
    }, which)
}

test('exposes exactly the described commands', async ({ page }) => {
    await openVisualize(page)
    const { live, described } = await page.evaluate(async () => {
        const agent = window.VisualizeAgent
        const live = Object.keys(agent).filter(key => typeof agent[key] === 'function')
        const { COMMAND_GROUPS } = await import('/js/agent/descriptions.js')
        return { live, described: COMMAND_GROUPS.flatMap(group => Object.keys(group.commands)) }
    })
    expect([...live].sort()).toEqual([...described].sort())
})

test('setProgram runs a valid program on one deck and refuses an invalid one', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async ({ red }) => {
        const A = window.VisualizeAgent
        const beforeA = (await A.getProgram()).result.dsl
        const set = await A.setProgram({ dsl: red, deck: 'B' })
        const after = (await A.getProgram({ deck: 'B' })).result
        const check = await A.validateProgram({ dsl: 'search synth\nnoise(madeUp: 1).write(o0)\nrender(o0)' })
        const refused = await A.setProgram({ dsl: 'search synth\nnoise(madeUp: 1).write(o0)\nrender(o0)', deck: 'B' })
        const syntax = await A.validateProgram({ dsl: 'noise((' })
        const media = await A.validateProgram({ dsl: 'search synth\nmedia(url: "https://example.com/a.png").write(o0)\nrender(o0)' })
        const missing = await A.setProgram({ dsl: `search synth\nmedia(url: "image:${'0'.repeat(64)}").write(o0)\nrender(o0)`, deck: 'B' })
        return {
            set, after, check: check.result, refused: refused.error, syntax: syntax.result, media: media.result, missing: missing.error,
            stillRed: (await A.getProgram({ deck: 'B' })).result.dsl === red,
            deckA: (await A.getProgram({ deck: 'A' })).result.dsl === beforeA,
            label: document.getElementById('deck-b-name').textContent,
        }
    }, { red: RED })
    expect(out.set.ok).toBe(true)
    expect(out.set.result).toEqual({ applied: true, diagnostics: [] })
    expect(out.set.state.decks.B).toMatchObject({ title: '(custom)', running: true })
    expect(out.after).toEqual({ dsl: RED, running: true })
    expect(out.label).toBe('(custom)')
    expect(out.check.valid).toBe(false)
    expect(out.check.diagnostics.some(d => d.code === 'S001' && d.message.includes('madeUp'))).toBe(true)
    expect(out.refused.code).toBe('INVALID_PROGRAM')
    expect(out.syntax.diagnostics[0]).toMatchObject({ code: 'SYNTAX', severity: 'error' })
    expect(out.media.diagnostics.some(d => d.code === 'MEDIA_URL')).toBe(true)
    expect(out.missing.code).toBe('NOT_FOUND_IMAGE')
    expect(out.stillRed).toBe(true)
    expect(out.deckA).toBe(true)
    await expect.poll(() => canvasPixel(page, 'B')).toEqual([255, 0, 0, 255])
})

test('arguments are checked and thumbnails come back as small images', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async ({ red }) => {
        const A = window.VisualizeAgent
        const unknown = await A.setProgram({ dsl: red, force: true })
        const noArgs = await A.getState({ force: true })
        const badDeck = await A.getProgram({ deck: 'C' })
        const range = await A.setCrossfader({ position: 2 })
        await A.setProgram({ dsl: red, deck: 'B' })
        await A.crossfade({ action: 'cutB' })
        const thumbs = {}
        for (const source of ['output', 'A', 'B']) {
            const env = await A.getThumbnail({ maxDimension: 64, format: 'png', source })
            thumbs[source] = { ok: env.ok, mimeType: env.result?.mimeType, w: env.result?.width, h: env.result?.height,
                png: env.result ? atob(env.result.bytes.slice(0, 8)).slice(1, 4) : null }
        }
        const jpg = await A.getThumbnail()
        return {
            unknown: unknown.error.code, noArgs: noArgs.error.code, badDeck: badDeck.error.code, range: range.error.code,
            thumbs, jpg: { mimeType: jpg.result.mimeType, max: Math.max(jpg.result.width, jpg.result.height) },
        }
    }, { red: RED })
    expect(out.unknown).toBe('INVALID_ARGS_UNKNOWN')
    expect(out.noArgs).toBe('INVALID_ARGS_UNKNOWN')
    expect(out.badDeck).toBe('INVALID_ARGS_ENUM')
    expect(out.range).toBe('INVALID_ARGS_RANGE')
    for (const source of ['output', 'A', 'B']) {
        expect(out.thumbs[source]).toMatchObject({ ok: true, mimeType: 'image/png', w: 64, h: 36, png: 'PNG' })
    }
    expect(out.jpg).toEqual({ mimeType: 'image/jpeg', max: 256 })
})

test('the output thumbnail shows the mix but not the canvas display effects', async ({ page }) => {
    await openVisualize(page)
    await page.evaluate(async ({ red }) => {
        const A = window.VisualizeAgent
        await A.setProgram({ dsl: red, deck: 'B' })
        await A.crossfade({ action: 'cutB' })
        await A.setFx({ invert: true })
    }, { red: RED })
    await expect(page.locator('#main-canvas')).toHaveClass(/invert/)
    // The thumbnail is the output canvas pixels: deck B's red, not inverted.
    await expect.poll(() => page.evaluate(async () => {
        const env = await window.VisualizeAgent.getThumbnail({ maxDimension: 64, format: 'png' })
        const data = Uint8Array.from(atob(env.result.bytes), char => char.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }))
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        const [r, g, b] = context.getImageData(32, 18, 1, 1).data
        return r > 240 && g < 15 && b < 15
    }), { timeout: 30_000 * SCALE }).toBe(true)
})

test('library commands load programs like the cards and the shuffle buttons', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async () => {
        const A = window.VisualizeAgent
        const search = await A.searchLibrary({ query: 'test program' })
        const geometric = await A.searchLibrary({ category: 'geometric' })
        const program = await A.getLibraryProgram({ title: 'agent blue' })
        const load = await A.loadProgram({ title: 'agent blue', deck: 'A' })
        const label = document.getElementById('deck-a-name').textContent
        const missing = await A.loadProgram({ title: 'no such program' })
        const excluded = await A.setAutoVjPool({ title: 'agent green', included: false })
        const util = await A.setAutoVjPool({ title: 'Camera Input', included: true })
        const random = await A.randomize({ deck: 'both' })
        return {
            search: search.result, geometric: geometric.result.programs.map(p => p.title), program: program.result,
            load: load.result, label, deckA: load.state.decks.A,
            missing: missing.error.code, excluded: excluded.result, util,
            toggle: document.querySelector('.program-card[data-title="agent green"] .pc-include')?.checked,
            random: random.result.programs,
        }
    })
    expect(out.search.total).toBe(4)
    expect(out.search.programs[0]).toEqual({ title: 'agent red', tagline: 'red test program', category: 'abstract', tags: ['abstract', 'bass'], autoVj: true })
    expect(out.geometric).toEqual(['agent blue', 'agent noise'])
    expect(out.program.dsl).toBe(BLUE)
    expect(out.load).toEqual({ deck: 'A', title: 'agent blue' })
    expect(out.label).toBe('agent blue')
    expect(out.deckA).toMatchObject({ title: 'agent blue', running: true })
    expect(out.missing).toBe('NOT_FOUND_PROGRAM')
    expect(out.excluded).toEqual({ title: 'agent green', included: false })
    expect(out.toggle).toBe(false)
    expect(out.util.result.included).toBe(false)
    expect(out.util.warnings).toEqual(['Utility programs are never in the Auto-VJ pool.'])
    // agent green is out of the pool and Camera Input is a utility.
    for (const title of [out.random.A, out.random.B]) expect(['agent red', 'agent blue', 'agent noise']).toContain(title)
    expect(out.random.A).not.toBe(out.random.B)
})

test('control commands move the same controls as the person', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async () => {
        const A = window.VisualizeAgent
        const r = {}
        r.deck = (await A.setDeck({ deck: 'B', speed: 2.5, density: '75', bandpass: false, oscillators: 2 })).result
        r.autoVj = (await A.setAutoVj({ enabled: true, bars: 16 })).result
        r.autoMix = (await A.setAutoMix({ enabled: true, source: 'audio:low' })).result
        // Auto-Mix turns Auto-VJ off, as its toggle does.
        r.autoVjAfter = (await A.getState()).result.autoVj.enabled
        r.autoMixOff = (await A.setAutoMix({ enabled: false })).result
        r.badBars = (await A.setAutoVj({ bars: 3 })).error.code
        r.crossfader = (await A.setCrossfader({ position: 0.25, curve: 'linear', fadeSeconds: 0.5 })).result
        r.cut = (await A.crossfade({ action: 'cutB' })).result
        r.fx = (await A.setFx({ invert: true, bw: true, flash: true })).result
        r.tempo = (await A.setTempo({ bpm: 128, divider: 2 })).result
        r.audio = (await A.setAudio({ sensitivity: 2.5 })).result
        r.output = (await A.setOutput({ resolution: '640x360' })).result
        r.mixer = (await A.setMixer({ effect: 'mixer/split', params: { softness: 0.2 } })).result
        r.badParam = (await A.setMixer({ params: { nope: 1 } })).error.code
        r.rebind = (await A.rebind({ deck: 'A', kind: 'eq' })).result
        r.state = (await A.getState()).result
        const $ = id => document.getElementById(id)
        r.ui = {
            speedB: $('speed-b').value, speedLabel: $('speed-b-val').textContent, density: $('deck-b-density').dataset.mode,
            crossfader: $('crossfader').value, curve: $('automix-curve').value,
            invert: document.querySelector('.fx-button[data-fx="invert"]').getAttribute('aria-pressed'),
            autoVj: $('automix-toggle').dataset.state, autoMix: $('automixer-toggle').dataset.state,
            autoMixSource: $('automixer-source').value, bars: $('automix-bars').value,
            bpm: window.__visualize.scheduler.bpm, resolution: $('main-res').textContent,
            mixer: $('mixer-effect').value, stored: JSON.parse(localStorage.getItem('visualize.mixer.v1')).id,
        }
        return r
    })
    expect(out.deck).toEqual({ deck: 'B', speed: 2.5, density: { mode: 'manual', value: 0.75 }, bandpass: false, oscillators: 2 })
    expect(out.crossfader).toEqual({ position: 0.25, curve: 'linear', fadeSeconds: 0.5, live: 'A' })
    expect(out.cut).toEqual({ action: 'cutB', target: 1, seconds: 0 })
    expect(out.fx).toEqual({ strobe: false, invert: true, bw: true, zoom: false, freeze: false })
    expect(out.autoVj).toEqual({ enabled: true, bars: 16 })
    expect(out.autoMix).toEqual({ enabled: true, source: 'audio:low' })
    expect(out.autoVjAfter).toBe(false)
    expect(out.autoMixOff).toEqual({ enabled: false, source: 'audio:low' })
    expect(out.badBars).toBe('INVALID_ARGS_ENUM')
    expect(out.tempo).toEqual({ bpm: 128, divider: 2, followMidiClock: false })
    expect(out.audio).toEqual({ enabled: false, sensitivity: 2.5 })
    expect(out.output).toMatchObject({ width: 640, height: 360 })
    expect(out.mixer.effect).toBe('mixer/split')
    expect(out.mixer.params.find(p => p.name === 'softness').value).toBe(0.2)
    expect(out.badParam).toBe('INVALID_ARGS_UNKNOWN')
    expect(out.rebind).toEqual({ deck: 'A', kind: 'eq', applied: expect.any(Boolean) })
    expect(out.state.crossfader.position).toBe(1)
    expect(out.ui).toEqual({
        speedB: '2.5', speedLabel: '2.5×', density: 'manual', crossfader: '1', curve: 'linear', invert: 'true',
        autoVj: 'off', autoMix: 'off', autoMixSource: 'audio:low', bars: '16', bpm: 128, resolution: '640×360',
        mixer: 'mixer/split', stored: 'mixer/split',
    })
})

test('scene commands save, rename, recall and delete without a dialog', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async ({ red, green }) => {
        const A = window.VisualizeAgent
        await A.setProgram({ dsl: red, deck: 'A' })
        const save = await A.scene({ action: 'save', name: 'agent scene' })
        const list = await A.listScenes()
        await A.setProgram({ dsl: green, deck: 'A' })
        const rename = await A.scene({ action: 'rename', name: 'agent scene', newName: 'renamed scene' })
        const recall = await A.scene({ action: 'recall', name: 'renamed scene' })
        const deckA = (await A.getProgram({ deck: 'A' })).result.dsl
        const missing = await A.scene({ action: 'recall', name: 'agent scene' })
        const blank = await A.scene({ action: 'save', name: '   ' })
        const removed = await A.scene({ action: 'delete', name: 'renamed scene' })
        return {
            save: save.result, list: list.result, rename: rename.result, recall, deckA,
            missing: missing.error.code, blank: blank.error.code, removed: removed.result,
            after: (await A.listScenes()).result.total,
            dialogOpen: document.getElementById('confirm-dialog')?.open ?? false,
        }
    }, { red: RED, green: GREEN })
    expect(out.save).toEqual({ action: 'save', name: 'agent scene' })
    expect(out.list).toMatchObject({ total: 1, max: 16, scenes: [{ slot: 1, name: 'agent scene', decks: { A: '(custom)' } }] })
    expect(out.rename).toEqual({ action: 'rename', name: 'agent scene', newName: 'renamed scene' })
    expect(out.recall.ok).toBe(true)
    expect(out.recall.warnings).toBeUndefined()
    expect(out.deckA).toBe(RED)
    expect(out.missing).toBe('NOT_FOUND_SCENE')
    expect(out.blank).toBe('INVALID_ARGS_RANGE')
    expect(out.removed).toEqual({ action: 'delete', name: 'renamed scene' })
    expect(out.after).toBe(0)
    expect(out.dialogOpen).toBe(false)
})

test('browser-only commands turn audio input on and save a recording as a download', async ({ page }) => {
    await openVisualize(page)
    const audio = await page.evaluate(async () => {
        const A = window.VisualizeAgent
        const on = await A.setAudioInput({ enabled: true })
        const off = await A.setAudioInput({ enabled: false })
        const renderer = await A.setRenderer({ preferWebGPU: true })
        const stored = JSON.parse(localStorage.getItem('visualize.renderer.v1'))
        const checked = document.getElementById('prefer-webgpu').checked
        await A.setRenderer({ preferWebGPU: false })
        return {
            on: on.result, off: off.result, effects: (await A.listUserEffects()).result,
            renderer: renderer.result, stored, checked,
        }
    })
    expect(audio).toEqual({
        on: { enabled: true }, off: { enabled: false }, effects: { total: 0, effects: [] },
        renderer: { preferWebGPU: true, backend: 'webgl2' }, stored: { preferWebGPU: true }, checked: true,
    })
    const started = await page.evaluate(() => window.VisualizeAgent.record({ recording: true }))
    expect(started.result).toEqual({ recording: true })
    await expect(page.locator('#record-toggle')).toHaveAttribute('data-state', 'on')
    const [download, stopped] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 * SCALE }),
        page.evaluate(() => window.VisualizeAgent.record({ recording: false })),
    ])
    expect(stopped.result).toEqual({ recording: false })
    expect(download.suggestedFilename()).toMatch(/\.(webm|mp4)$/)
})

test('a program that fails after it installs puts the previous program back as it was', async ({ page }) => {
    await openVisualize(page)
    const out = await page.evaluate(async () => {
        const A = window.VisualizeAgent
        const deck = window.__visualize.decks.B
        await A.loadProgram({ title: 'agent noise', deck: 'B' })
        const rebound = await A.rebind({ deck: 'B', kind: 'midi' })
        const before = {
            dsl: deck.currentDsl, title: deck.currentName, overrides: JSON.stringify(deck.rebind.overrides),
            original: deck.rebind.originalDsl, tagline: document.getElementById('deck-b-tagline').textContent,
        }
        // An image the deck holds whose bytes do not decode: the program
        // compiles and installs, then the image fails to bind.
        const id = 'f'.repeat(64)
        deck.images.push({ id, blob: new Blob(['not an image'], { type: 'image/png' }), mimeType: 'image/png', width: 1, height: 1 })
        const failed = await A.setProgram({ deck: 'B', dsl: `search synth\nmedia(url: "image:${id}").write(o0)\nrender(o0)` })
        return {
            rebound: rebound.result.applied, failed: failed.error?.code, before,
            after: {
                dsl: deck.currentDsl, title: deck.currentName, overrides: JSON.stringify(deck.rebind.overrides),
                original: deck.rebind.originalDsl, tagline: document.getElementById('deck-b-tagline').textContent,
            },
        }
    })
    expect(out.rebound).toBe(true)
    expect(out.failed).toBe('COMPILE_FAILED')
    expect(out.before.tagline).toBe('noise test program')
    expect(out.before.overrides).not.toBe('{}')
    expect(out.after).toEqual(out.before)
})
