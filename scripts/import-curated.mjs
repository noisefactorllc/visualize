#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { validatePortableDefinition } from '../js/userEffects.js'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const palette = ['#4ea8ff', '#ff5fc0', '#ffd24e', '#4ed99b', '#ff6b6b', '#a78bfa', '#22d3ee', '#fb923c', '#84cc16', '#f43f5e']

export async function importCurated(sourceDir, outputDir = path.join(root, 'data')) {
    const manifest = JSON.parse(await readFile(path.join(sourceDir, 'programs.json'), 'utf8'))
    if (manifest.version !== 1 || manifest.count !== manifest.programs?.length) throw new Error('Invalid curated manifest')
    const previous = JSON.parse(await readFile(path.join(outputDir, 'programs.json'), 'utf8'))
    const byCode = new Map(previous.filter(p => p.source?.code).map(p => [p.source.code, p]))
    const titleCounts = new Map()
    for (const p of manifest.programs) titleCounts.set(p.title, (titleCounts.get(p.title) || 0) + 1)
    const codes = new Set()
    const effects = new Map()
    const programs = []
    async function verifiedFile(file, hash) {
        const location = path.resolve(sourceDir, file)
        if (!location.startsWith(path.resolve(sourceDir) + path.sep)) throw new Error(`Invalid curated path: ${file}`)
        const bytes = await readFile(location)
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`SHA-256 mismatch: ${file}`)
        return bytes.toString('utf8')
    }
    for (const p of manifest.programs) {
        if (!p.code || codes.has(p.code)) throw new Error(`Duplicate or missing curated code: ${p.code}`)
        codes.add(p.code)
        const dsl = await verifiedFile(p.dslFile, p.dslSha256)
        const prior = byCode.get(p.code)
        const title = titleCounts.get(p.title) > 1 ? `${p.title} · ${p.code}` : p.title
        const hash = createHash('sha256').update(p.code).digest()[0]
        programs.push({
            title,
            tagline: prior?.tagline || `by ${p.author}`,
            tint: prior?.tint || palette[hash % palette.length],
            tags: [...new Set(['curated', ...(prior?.tags || []), /\baudio\s*\(/.test(dsl) ? 'reactive' : 'static'])].filter(tag =>
                !['imported', 'reactive', 'static'].includes(tag) || tag === (/\baudio\s*\(/.test(dsl) ? 'reactive' : 'static')),
            category: 'curated',
            dsl,
            source: { ...p.source, collection: 'noisemaker-curated', id: p.id, code: p.code, title: p.title, author: p.author, variant: p.variant, dslSha256: p.dslSha256 },
        })
        if (p.effectsFile) {
            const bundled = JSON.parse(await verifiedFile(p.effectsFile, p.effectsSha256))
            if (!Array.isArray(bundled)) throw new Error(`Invalid effects: ${p.effectsFile}`)
            programs[programs.length - 1].runtimeDsl = dsl.replace(
                /^([ \t]*search[ \t]+)([^\n]*)/m,
                (_, header, namespaces) => header + namespaces.replace(/\buser\b/g, 'curated'))
            for (const effect of bundled) {
                validatePortableDefinition(effect)
                const id = `${effect.namespace || 'user'}/${effect.func || effect.name}`
                if (effects.has(id) && JSON.stringify(effects.get(id)) !== JSON.stringify(effect)) throw new Error(`Conflicting curated effect: ${id}`)
                effects.set(id, effect)
            }
        }
    }
    programs.push(...previous.filter(p => p.tags?.includes('util')))
    if (new Set(programs.map(p => p.title)).size !== programs.length) throw new Error('Curated titles conflict with utility titles')
    await mkdir(outputDir, { recursive: true })
    await writeFile(path.join(outputDir, 'curated-effects.json'), JSON.stringify([...effects.values()], null, 2) + '\n')
    await writeFile(path.join(outputDir, 'programs.json'), JSON.stringify(programs, null, 2) + '\n')
    return { programs: manifest.programs.length, effects: effects.size }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const sourceDir = path.resolve(process.argv[2] || path.join(root, '../noisemaker-curated'))
    importCurated(sourceDir).then(result => console.log(result)).catch(err => { console.error(err.message); process.exitCode = 1 })
}
