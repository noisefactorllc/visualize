// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test'
import { installHandfishLocal } from './handfishLocal.js'
installHandfishLocal(test)
const SCALE = Number(process.env.PW_TIMEOUT_SCALE || '1')

async function boot(page) {
    page.on('console', message => { if (message.text().startsWith('[curated-check]')) console.log(message.text()) })
    await page.goto('/')
    await page.waitForFunction(() => window.__visualize?.decks?.A?.isRunning && window.__visualize?.decks?.B?.isRunning && document.getElementById('deck-a-name').textContent !== '—' && document.getElementById('deck-b-name').textContent !== '—')
    await expect(page.locator('.lib-section[data-category="curated"] .program-card')).toHaveCount(157)
}

test('curated custom effects load on both decks and produce thumbnails', async ({ page }, testInfo) => {
    await boot(page)
    const results = await page.evaluate(async () => {
        const { decks } = window.__visualize
        const programsData = await fetch('/data/programs.json').then(r => r.json())
        const programs = programsData.filter(p => ['7INvow', 'fui1YA', 'n2FcpA', 'd-MpwA', 'B5oBsA'].includes(p.source?.code))
        const results = []
        for (const p of programs) {
            for (const id of ['A', 'B']) {
                const result = await decks[id].load(p.dsl, p.title)
                results.push({ code: p.source.code, deck: id, success: result.success, error: result.error })
            }
        }
        const { getThumbnailRenderer } = await import('/js/thumbnailRenderer.js')
        for (const p of programs) {
            const blob = await getThumbnailRenderer().render(p.dsl)
            let energy = 0
            if (blob) {
                const bitmap = await createImageBitmap(blob)
                const canvas = document.createElement('canvas')
                canvas.width = 32; canvas.height = 18
                const context = canvas.getContext('2d')
                context.drawImage(bitmap, 0, 0, 32, 18)
                const pixels = context.getImageData(0, 0, 32, 18).data
                for (let i = 0; i < pixels.length; i += 4) energy += pixels[i] + pixels[i + 1] + pixels[i + 2]
                bitmap.close()
            }
            results.push({ code: p.source.code, deck: 'thumbnail', success: !!blob?.size, energy })
        }
        return results
    })
    expect(results).toHaveLength(15)
    for (const result of results) {
        expect(result.success, JSON.stringify(result)).toBe(true)
        if (result.deck === 'thumbnail') expect(result.energy, JSON.stringify(result)).toBeGreaterThan(0)
    }
    await testInfo.attach('curated-library.png', { body: await page.screenshot(), contentType: 'image/png' })
})

test('all curated programs compile and render through the real deck', async ({ page }, testInfo) => {
    test.setTimeout(600_000 * SCALE)
    await boot(page)
    const results = await page.evaluate(async () => {
        const { decks } = window.__visualize
        const programsData = await fetch('/data/programs.json').then(r => r.json())
        const programs = programsData.filter(p => p.source?.collection === 'noisemaker-curated')
        const results = []
        const sample = document.createElement('canvas')
        sample.width = 32; sample.height = 18
        const context = sample.getContext('2d', { willReadFrequently: true })
        decks.B.stop()
        decks.A.setPixelDensity(0.1)
        for (const p of programs) {
            console.log('[curated-check]', p.source.code, p.title)
            const res = await decks.A.load(p.dsl, p.title)
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            context.drawImage(decks.A.canvas, 0, 0, 32, 18)
            const pixels = context.getImageData(0, 0, 32, 18).data
            let energy = 0
            for (let i = 0; i < pixels.length; i += 4) energy += pixels[i] + pixels[i + 1] + pixels[i + 2]
            results.push({ code: p.source.code, success: res.success, running: decks.A.isRunning, pixelEnergy: energy, error: res.error })
        }
        return results
    })
    await testInfo.attach('curated-frame-measurements.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    expect(results).toHaveLength(157)
    expect(results.filter(result => result.pixelEnergy > 0).length).toBeGreaterThan(0)
    for (const result of results) {
        expect(result.success, JSON.stringify(result)).toBe(true)
        expect(result.running, JSON.stringify(result)).toBe(true)
    }
})

test('the four Untitled programs select independently and remain distinct in the random pool', async ({ page }) => {
    await boot(page)
    const titles = await page.locator('.lib-section[data-category="curated"] .program-card').evaluateAll(cards => cards.map(card => card.dataset.title).filter(title => title.startsWith('Untitled · ')))
    expect(titles).toHaveLength(4)
    expect(new Set(titles).size).toBe(4)
    for (const title of titles) {
        await page.locator('.program-card').filter({ hasText: title }).getByRole('button', { name: 'A', exact: true }).click()
        await expect(page.locator('#deck-a-name')).toHaveText(title)
    }
})

test('curated effect rebinds work while a same-named user effect is installed and deleted', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const { getUserEffectsManager } = await import('/js/userEffects.js')
        const { getEffect } = await import('/js/noisemaker/bundle.js')
        const { decks, rebind } = window.__visualize
        const program = (await fetch('/data/programs.json').then(r => r.json())).find(p => p.source?.code === '7INvow')
        const payload = (await fetch('/data/curated-effects.json').then(r => r.json())).find(p => p.func === 'prismaticChemtrails')
        const manager = getUserEffectsManager()
        await manager.uploadFromPayload({ ...payload, description: 'installed user version' }, decks.A.inner)
        const userDescription = getEffect('user/prismaticChemtrails').description
        const loaded = await decks.A.load(program.dsl, program.title)
        const originalPreserved = decks.A.currentDsl === program.dsl
        const rebound = await rebind.rebindEq(decks.A, program, { oscillatorCount: 4 })
        const reboundDsl = decks.A.currentDsl
        await manager.deleteEffect('user/prismaticChemtrails')
        const afterDelete = await decks.B.load(program.dsl, program.title)
        return { userDescription, loaded: loaded.success, originalPreserved, rebound, reboundDsl, afterDelete: afterDelete.success }
    })
    expect(result.userDescription).toBe('installed user version')
    expect(result.loaded).toBe(true)
    expect(result.originalPreserved).toBe(true)
    expect(result.rebound).toBe(true)
    expect(result.reboundDsl).toContain('curated')
    expect(result.afterDelete).toBe(true)
    await page.locator('.program-card').filter({ hasText: 'prismatic chemtrails' }).getByRole('button', { name: 'A', exact: true }).click()
    await expect(page.locator('#deck-a-name')).toHaveText('prismatic chemtrails')
    await page.locator('.deck[data-deck="A"] .deck-edit-toggle').click()
    const editor = page.locator('.deck[data-deck="A"] code-editor')
    await expect.poll(() => editor.evaluate(el => el.value)).toContain('search curated')
    await editor.evaluate(el => { el.value = el.value.replace('dispersion: 0.46', 'dispersion: 0.47'); el.dispatchEvent(new Event('input', { bubbles: true })) })
    await expect(page.locator('#deck-a-name')).toHaveText('(custom)')
    expect(await page.evaluate(() => window.__visualize.decks.A.currentDsl)).toContain('dispersion: 0.47')
    await expect(page.locator('.deck[data-deck="A"] .deck-editor-error')).toBeHidden()
})
