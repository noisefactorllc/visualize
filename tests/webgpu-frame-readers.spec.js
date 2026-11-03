// SPDX-License-Identifier: MIT
/**
 * A WebGPU canvas holds its frame only during the task that rendered it.
 * Read later, by drawImage or copyExternalImageToTexture, it is blank or an
 * invalid texture. With the WebGPU preference on, the mixer uploaded the
 * deck canvases from its own animation frame, so its output, and the output
 * the compositor shows, were black while both decks rendered.
 *
 * Each WebGPU deck and the mixer now copy their frame right after they
 * render, and the mixer and the compositor read that copy. This reads the
 * mixer's render surface and the output canvas.
 */
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

const RENDERER_STORAGE_KEY = 'visualize.renderer.v1'

// The decks start on two of the library's own programs, restored from a
// saved set; the full library loads as usual. With these two the mixer
// output was black under WebGPU. The crossfader rests on deck A.
const PROGRAM_TITLES = ['water sample', 'glitchscape']
const WORKING_SET_KEY = 'visualize.workingSet.v1'
const LIBRARY = JSON.parse(readFileSync(new URL('../data/programs.json', import.meta.url), 'utf8'))

function deckSnapshot(title) {
    const program = LIBRARY.find(entry => entry.title === title)
    if (!program) throw new Error(`the library has no program named ${title}`)
    return { title, dsl: program.dsl, speed: 1,
        rebind: { originalDsl: program.dsl, bandpass: true, oscillatorCount: 0, overrides: {} } }
}

const WORKING_SET = {
    version: 1,
    createdAt: 1,
    decks: { A: deckSnapshot(PROGRAM_TITLES[0]), B: deckSnapshot(PROGRAM_TITLES[1]) },
    xfade: 0,
    curve: 'dipped',
    bpm: 120,
    divider: 1,
    fx: { strobe: false, invert: false, bw: false, zoom: false, freeze: false },
    autoMix: { enabled: false, barsPerScene: 8, curve: 'dipped' },
    autoXfade: null,
    mixer: { id: 'blend', overrides: {} },
    deckDensity: { A: { mode: 'auto', value: 1 }, B: { mode: 'auto', value: 1 } },
}

installHandfishLocal(test)

test('under WebGPU the mixer blends the decks\' frames and the output shows them', async ({ page }) => {
    test.slow()
    await page.addInitScript(({ rendererKey, workingSetKey, workingSet }) => {
        localStorage.setItem(rendererKey, JSON.stringify({ preferWebGPU: true }))
        localStorage.setItem(workingSetKey, JSON.stringify(workingSet))
    }, { rendererKey: RENDERER_STORAGE_KEY, workingSetKey: WORKING_SET_KEY, workingSet: WORKING_SET })
    await page.goto('/')

    const hasAdapter = await page.evaluate(async () => !!(await navigator.gpu?.requestAdapter()))
    test.skip(!hasAdapter, 'this browser offers no WebGPU adapter, so the WebGPU readers cannot run')

    await page.waitForFunction((titles) => {
        const v = window.__visualize
        return v?.mixer?.ready && v.decks.A.currentName === titles[0] && v.decks.B.currentName === titles[1]
    }, PROGRAM_TITLES, { timeout: 90_000 * SCALE })
    const backends = await page.evaluate(() => {
        const v = window.__visualize
        return [v.decks.A.activeBackend, v.decks.B.activeBackend, v.mixer.activeBackend]
    })
    test.skip(backends.some(backend => backend !== 'webgpu'),
        `the renderers fell back from WebGPU (${backends.join(', ')}), so the WebGPU readers cannot run`)

    // Deck render loops that start after the mixer's (a deck that finished
    // loading later, or a renderer restarted after a lost context) draw
    // after the mixer's tick in every frame. Put the decks in that order.
    await page.evaluate(() => {
        for (const deck of [window.__visualize.decks.A, window.__visualize.decks.B]) {
            deck._renderer.stop()
            deck._renderer.start()
        }
    })

    // Fraction of non-black pixels each reader receives.
    const measure = () => page.evaluate(async () => {
        const v = window.__visualize
        const litFraction = (data) => {
            let lit = 0
            for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 0) lit++
            return lit / (data.length / 4)
        }
        const viaCanvas = (source) => {
            const out = document.createElement('canvas')
            out.width = 64
            out.height = 36
            const context = out.getContext('2d')
            context.drawImage(source, 0, 0, out.width, out.height)
            return litFraction(context.getImageData(0, 0, out.width, out.height).data)
        }
        const surface = async (renderer) => {
            const pipeline = renderer.pipeline
            const id = pipeline.frameReadTextures?.get(pipeline.graph.renderSurface)
                ?? pipeline.surfaces.get(pipeline.graph.renderSurface).read
            return litFraction((await pipeline.backend.readPixels(id)).data)
        }
        return {
            deckA: await surface(v.decks.A._renderer),
            mixer: await surface(v.mixer.renderer),
            // The output canvas is 2D, so it can be read at any time.
            output: viaCanvas(document.getElementById('main-canvas')),
            // Deck B's frame copy holds what deck B presented. It stays empty
            // if the mixer's first upload, made before deck B compiled,
            // claimed deck B's canvas for 2D and left it without a WebGPU
            // context.
            deckBFrame: viaCanvas(v.decks.B.frameCanvas),
        }
    })

    // Deck A renders on its own; the mixer and the output downstream of it
    // must show it, and deck B must present its own frames.
    await expect.poll(async () => {
        const m = await measure()
        return m.deckA > 0.9 && m.mixer > 0.9 && m.output > 0.9 && m.deckBFrame > 0.5 ? 'all lit' : JSON.stringify(m)
    }, { timeout: 20_000 * SCALE, intervals: [500] }).toBe('all lit')
})
