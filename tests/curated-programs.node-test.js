// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const programs = JSON.parse(readFileSync(new URL('../data/programs.json', import.meta.url)))
test('the bundled collection contains all curated programs once, alongside the utility tools', () => {
    const curated = programs.filter(p => !p.tags.includes('util'))
    assert.equal(curated.length, 157)
    assert.equal(new Set(curated.map(p => p.source.code)).size, 157)
    assert.equal(new Set(programs.map(p => p.title)).size, programs.length)
    assert.equal(programs.filter(p => p.tags.includes('util')).length, 7)
    assert.ok(curated.some(p => p.source.code === '7INvow'))
    assert.ok(curated.some(p => p.source.code === 'zniavg'))
    assert.ok(!curated.some(p => p.title === 'Bass Bloom'))
})

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { importCurated } from '../scripts/import-curated.mjs'

async function fixture(run) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'visualize-curated-'))
    try {
        const source = path.join(dir, 'source'), output = path.join(dir, 'output')
        await mkdir(source); await mkdir(output)
        const dsl = 'noise().write(o0)\nrender(o0)\n'
        const sha = createHash('sha256').update(dsl).digest('hex')
        const manifest = { version: 1, count: 2, programs: [
            { id: 'test:first', code: 'first', title: 'Untitled', author: 'Author', dslFile: 'first.dsl', dslSha256: sha, source: { code: 'first' } },
            { id: 'test:second', code: 'second', title: 'Untitled', author: 'Author', dslFile: 'second.dsl', dslSha256: sha, source: { code: 'second' } },
        ] }
        await writeFile(path.join(source, 'programs.json'), JSON.stringify(manifest))
        await writeFile(path.join(source, 'first.dsl'), dsl); await writeFile(path.join(source, 'second.dsl'), dsl)
        await writeFile(path.join(output, 'programs.json'), JSON.stringify([
            { title: 'old first', tint: '#123456', tagline: 'existing', tags: ['reactive'], source: { code: 'first' } },
            { title: 'camera', dsl: 'media()', tags: ['util'] },
            { title: 'removed', dsl: 'noise()', tags: [] },
        ]))
        await run({ source, output, dsl, manifest })
    } finally { await rm(dir, { recursive: true, force: true }) }
}

test('reimport preserves exact DSL, presentation, distinct titles and utility tools without duplicates', async () => {
    await fixture(async ({ source, output, dsl }) => {
        await importCurated(source, output)
        const first = await readFile(path.join(output, 'programs.json'), 'utf8')
        const result = JSON.parse(first)
        assert.deepEqual(result.map(p => p.title), ['Untitled · first', 'Untitled · second', 'camera'])
        assert.equal(result[0].dsl, dsl)
        assert.equal(result[0].tint, '#123456')
        assert.equal(result[0].tagline, 'existing')
        assert.ok(result[0].tags.includes('static'))
        assert.ok(!result[0].tags.includes('reactive'))
        await importCurated(source, output)
        assert.equal(await readFile(path.join(output, 'programs.json'), 'utf8'), first)
    })
})

test('a corrupted DSL hash refuses the import without changing the installed collection', async () => {
    await fixture(async ({ source, output }) => {
        const before = await readFile(path.join(output, 'programs.json'), 'utf8')
        await writeFile(path.join(source, 'second.dsl'), 'wrong bytes')
        await assert.rejects(importCurated(source, output), /SHA-256 mismatch/)
        assert.equal(await readFile(path.join(output, 'programs.json'), 'utf8'), before)
    })
})

test('effects with the same function but different payloads refuse the import', async () => {
    await fixture(async ({ source, output, manifest }) => {
        for (let i = 0; i < 2; i++) {
            const file = `effects${i}.json`
            const content = JSON.stringify([{ func: 'same', namespace: 'user', passes: [{ program: 'main' }], shaders: { main: { glsl: `shader${i}` } } }])
            await writeFile(path.join(source, file), content)
            manifest.programs[i].effectsFile = file
            manifest.programs[i].effectsSha256 = createHash('sha256').update(content).digest('hex')
        }
        await writeFile(path.join(source, 'programs.json'), JSON.stringify(manifest))
        await assert.rejects(importCurated(source, output), /Conflicting curated effect/)
    })
})

test('a correctly hashed malformed effect cannot replace either installed bundle file', async () => {
    await fixture(async ({ source, output, manifest }) => {
        const content = JSON.stringify([{ func: 'broken', namespace: 'user' }])
        await writeFile(path.join(source, 'effects.json'), content)
        manifest.programs[0].effectsFile = 'effects.json'
        manifest.programs[0].effectsSha256 = createHash('sha256').update(content).digest('hex')
        await writeFile(path.join(source, 'programs.json'), JSON.stringify(manifest))
        await writeFile(path.join(output, 'curated-effects.json'), '[]\n')
        const programsBefore = await readFile(path.join(output, 'programs.json'), 'utf8')
        await assert.rejects(importCurated(source, output), /passes must be a nonempty array/)
        assert.equal(await readFile(path.join(output, 'programs.json'), 'utf8'), programsBefore)
        assert.equal(await readFile(path.join(output, 'curated-effects.json'), 'utf8'), '[]\n')
    })
})
