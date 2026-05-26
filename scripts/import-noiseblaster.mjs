#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * One-shot snapshot of the noiseblaster feed → visualize library.
 *
 * Pulls every page of https://blaster.noisedeck.app/api/feed, then for
 * each entry fetches the full DSL from sharing.noisedeck.app, runs the
 * reactify pass (inject one audio() binding into a likely-visible
 * parameter if the DSL has none), and emits a merged programs.json that
 * combines the 35 native curated entries with the imported snapshot.
 *
 * Re-runnable: existing entries (matched on source.code) are kept as-is
 * so a future `npm run import:noiseblaster` only pulls *new* feed items
 * without re-importing duplicates or overwriting curated tweaks.
 *
 * Each imported entry carries a `source` field:
 *   {
 *     feed: 'noiseblaster',
 *     code: 'DvENtw',          // sharing.noisedeck.app composition slug
 *     username: 'aayars',      // original author
 *     app: 'noisedeck',        // source app
 *     createdAt: <ms>,         // original creation timestamp
 *     importedAt: <ms>,        // when we snapshotted
 *   }
 *
 * Entries with hasEffects=true are skipped — visualize doesn't support
 * custom-effects bundles, only the stock noisemaker shader library.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PROGRAMS_PATH = path.join(REPO_ROOT, 'data/programs.json')
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'scripts/noiseblaster-snapshot.json')

const FEED_URL = 'https://blaster.noisedeck.app/api/feed'
const SHARING_URL = 'https://sharing.noisedeck.app/api/composition'
const PAGE_LIMIT = 50
const FETCH_PACE_MS = 120        // be polite to sharing.noisedeck.app

// Composition codes we've audited and decided not to import. Reasons
// belong in the comment so a future maintainer doesn't re-add them
// thinking they were missed. The script honors this whether or not the
// entry happens to be in the current programs.json.
const SKIP_CODES = new Set([
    't-AMiQ',  // "anomaly detection" — compiles but renders fully black on
               //                       visualize's deck (deep subchain +
               //                       glyphMap chain needs audio motion
               //                       to develop; static frame is dead)
])

// Palette for imported-card tints — sampled across the spectrum so the
// library reads as varied even when entries share tags.
const TINT_PALETTE = [
    '#4ea8ff', '#ff5fc0', '#ffd24e', '#4ed99b', '#ff6b6b',
    '#a78bfa', '#22d3ee', '#fb923c', '#84cc16', '#f43f5e',
]

// ───────────────────────────────────────────────────────────────────────
// HTTP helpers
// ───────────────────────────────────────────────────────────────────────

async function fetchJson(url, attempt = 0) {
    const res = await fetch(url, { headers: { 'user-agent': 'visualize-import/1' } })
    if (res.status === 429 || res.status >= 500) {
        if (attempt >= 3) throw new Error(`${url} → ${res.status} after ${attempt} retries`)
        await sleep(500 * (attempt + 1))
        return fetchJson(url, attempt + 1)
    }
    if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`)
    return res.json()
}

async function fetchAllFeed() {
    const all = []
    let page = 0
    while (true) {
        const body = await fetchJson(`${FEED_URL}?page=${page}&limit=${PAGE_LIMIT}`)
        const comps = body.compositions ?? []
        all.push(...comps)
        if (comps.length < PAGE_LIMIT) break
        page += 1
        await sleep(FETCH_PACE_MS)
    }
    return all
}

// ───────────────────────────────────────────────────────────────────────
// Reactify: inject one audio() binding into a likely-visible parameter
// if the DSL has none. Untouched if the DSL already uses audio().
// ───────────────────────────────────────────────────────────────────────

// Parameters whose value is plausibly an audio-modulated knob. Order is
// preference: speed/rotation/scale tend to read better than e.g. octaves.
const REACTIFY_PARAMS = [
    'speed', 'cSpeed',
    'hueRotation', 'rotation',
    'xScale', 'yScale', 'scale', 'cellScale',
    'zoom', 'zoomDepth',
    'kaleido',
    'refractAmt',
    'mix',
    'iterations',
]

// Band → (min/max scaling factor, descriptor for tagline).
// Distributing across bands so the imported library doesn't feel one-note;
// the actual band picked per entry uses both the parameter character AND
// the entry's code hash so we get variety while staying deterministic.
const REACTIFY_BANDS = [
    { band: 0, label: 'bass',  minFactor: 0.3, maxFactor: 2.2 },
    { band: 1, label: 'mids',  minFactor: 0.5, maxFactor: 1.7 },
    { band: 2, label: 'highs', minFactor: 0.7, maxFactor: 1.4 },
]

function hashCode(code) {
    let h = 0
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0
    return Math.abs(h)
}

function pickBand(paramName, code) {
    // kaleido shimmer + refract sparkle are unambiguously highs-y; that's
    // the only strong override. Everything else distributes by code hash
    // so a library full of `speed:`-paramed entries spreads across all
    // three bands instead of clumping into one (musically defensible —
    // bass kicks driving forward motion is the default association, but
    // 60 cards of "bass drives the speed" reads as one-note).
    if (/kaleido|refract/i.test(paramName)) return REACTIFY_BANDS[2]
    return REACTIFY_BANDS[hashCode(code) % REACTIFY_BANDS.length]
}

function hasAudio(dsl) {
    return /\baudio\s*\(/.test(dsl)
}

/**
 * Find the first `param: number` occurrence whose param name is in
 * REACTIFY_PARAMS. Returns { name, value, fullMatch, index } or null.
 *
 * Stops at the FIRST occurrence (top-down) so injection lands on the
 * earliest visible parameter in the pipeline — typically the foreground
 * effect, the one whose motion the user actually sees.
 */
function findReactifyTarget(dsl) {
    for (const name of REACTIFY_PARAMS) {
        const re = new RegExp(`\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`)
        const m = dsl.match(re)
        if (m) return { name, value: parseFloat(m[1]), fullMatch: m[0], index: m.index }
    }
    return null
}

/**
 * Inject `let <var> = audio(band: N, min: A, max: B)` declaration into
 * the DSL and replace the matched parameter value with the variable
 * reference. Insertion point: after the last `let` declaration if any,
 * else at the top of the file (but after any `search …` header).
 */
function injectAudio(dsl, target, code) {
    const band = pickBand(target.name, code)
    const min = +(target.value * band.minFactor).toFixed(3)
    const max = +(target.value * band.maxFactor).toFixed(3)
    const varName = `${band.label}React`

    const decl = `let ${varName} = audio(band: ${band.band}, min: ${min}, max: ${max})`

    // Insertion: after the last `let X = ...` line, else after the
    // `search ...` header, else at the start.
    const lines = dsl.split('\n')
    let insertAt = 0
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*let\s+/.test(lines[i])) insertAt = i + 1
        else if (insertAt === 0 && /^\s*search\b/.test(lines[i])) insertAt = i + 1
    }
    lines.splice(insertAt, 0, decl)
    const withDecl = lines.join('\n')

    // Replace just the FIRST occurrence of the matched param (not
    // replace-all — only the param we picked).
    const re = new RegExp(`\\b${target.name}\\s*:\\s*-?\\d+(?:\\.\\d+)?`)
    const reactified = withDecl.replace(re, `${target.name}: ${varName}`)

    return { dsl: reactified, band: band.label, param: target.name, varName }
}

function reactify(dsl, code) {
    if (hasAudio(dsl)) {
        return { dsl, reactive: 'native', band: null, param: null }
    }
    const target = findReactifyTarget(dsl)
    if (!target) {
        // Nothing to bind — leave the DSL as-is, mark static.
        return { dsl, reactive: 'static', band: null, param: null }
    }
    const out = injectAudio(dsl, target, code)
    return {
        dsl: out.dsl,
        reactive: 'injected',
        band: out.band,
        param: out.param,
    }
}

// ───────────────────────────────────────────────────────────────────────
// Enriched-entry construction
// ───────────────────────────────────────────────────────────────────────

function pickTint(code) {
    // Deterministic per-code so re-runs don't shuffle the library palette.
    let hash = 0
    for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) | 0
    return TINT_PALETTE[Math.abs(hash) % TINT_PALETTE.length]
}

function makeTagline(reactify, feedTitle) {
    if (reactify.reactive === 'native') {
        return `by ${feedTitle}'s author · already reactive`
    }
    if (reactify.reactive === 'injected') {
        return `${reactify.band} drives the ${reactify.param}`
    }
    return 'still composition · no audio binding'
}

function makeTags(entry, reactify) {
    const tags = ['imported', entry.app]
    if (reactify.reactive === 'static') tags.push('static')
    else tags.push('reactive')
    return tags
}

function buildEnriched(feedEntry, dsl, importedAt) {
    const r = reactify(dsl, feedEntry.code)
    return {
        title: feedEntry.title || `untitled ${feedEntry.code}`,
        tagline: makeTagline(r, feedEntry.username || 'unknown'),
        tint: pickTint(feedEntry.code),
        tags: makeTags(feedEntry, r),
        dsl: r.dsl,
        source: {
            feed: 'noiseblaster',
            code: feedEntry.code,
            username: feedEntry.username,
            app: feedEntry.app,
            createdAt: feedEntry.createdAt,
            importedAt,
        },
    }
}

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

async function main() {
    const importedAt = Date.now()

    console.log('Loading existing programs.json…')
    const existing = JSON.parse(await readFile(PROGRAMS_PATH, 'utf8'))
    const existingByCode = new Map()
    for (const e of existing) {
        if (e.source?.code) existingByCode.set(e.source.code, e)
    }
    console.log(`  ${existing.length} total entries (${existingByCode.size} previously imported)`)

    console.log('Fetching noiseblaster feed…')
    const feed = await fetchAllFeed()
    console.log(`  ${feed.length} feed entries`)

    const skipped = { hasEffects: 0, alreadyImported: 0, fetchFailed: 0, noDsl: 0 }
    const newImports = []

    const skippedExplicit = []
    for (const entry of feed) {
        if (entry.hasEffects) { skipped.hasEffects += 1; continue }
        if (SKIP_CODES.has(entry.code)) { skippedExplicit.push(entry.code); continue }
        if (existingByCode.has(entry.code)) { skipped.alreadyImported += 1; continue }

        let comp
        try {
            await sleep(FETCH_PACE_MS)
            comp = await fetchJson(`${SHARING_URL}/${entry.code}`)
        } catch (err) {
            console.warn(`  ! ${entry.code} (${entry.title}): fetch failed — ${err.message}`)
            skipped.fetchFailed += 1
            continue
        }

        if (!comp.dsl || typeof comp.dsl !== 'string' || comp.dsl.length < 10) {
            skipped.noDsl += 1
            continue
        }

        // Skip entries whose DSL pulls in custom effects via `loadEffect`
        // or similar — those would compile to a missing-effect error.
        if (/\bloadEffect\s*\(/.test(comp.dsl)) {
            skipped.hasEffects += 1
            continue
        }

        const enriched = buildEnriched(entry, comp.dsl, importedAt)
        newImports.push(enriched)
        console.log(`  + ${entry.code} (${entry.title}) — ${enriched.tagline}`)
    }

    console.log('\nSummary:')
    console.log(`  imported new:    ${newImports.length}`)
    console.log(`  already in:      ${skipped.alreadyImported}`)
    console.log(`  skipped (FX):    ${skipped.hasEffects}`)
    console.log(`  skipped (deny):  ${skippedExplicit.length}${skippedExplicit.length ? ` [${skippedExplicit.join(', ')}]` : ''}`)
    console.log(`  fetch failed:    ${skipped.fetchFailed}`)
    console.log(`  no DSL:          ${skipped.noDsl}`)

    const reactiveCount = newImports.filter(e => e.tags.includes('reactive')).length
    const staticCount = newImports.filter(e => e.tags.includes('static')).length
    console.log(`  → reactive:    ${reactiveCount}`)
    console.log(`  → static:      ${staticCount}`)

    // Write the snapshot for traceability (raw feed responses we kept).
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify({ fetchedAt: importedAt, total: feed.length, feed }, null, 2)
    )
    console.log(`\nSnapshot → ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`)

    if (newImports.length === 0) {
        console.log('Nothing new to import. programs.json untouched.')
        return
    }

    // Append new imports to the end of programs.json. Preserve order of
    // existing entries so curated tweaks aren't reshuffled.
    const merged = [...existing, ...newImports]
    await writeFile(PROGRAMS_PATH, JSON.stringify(merged, null, 2) + '\n')
    console.log(`programs.json → ${merged.length} entries (was ${existing.length})`)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
