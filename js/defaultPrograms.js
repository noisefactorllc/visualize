/**
 * Default programs synthesized from the engine's effect registry.
 *
 * For each effect in the points/* namespace or tagged "sim" (excluding
 * the util-tagged loop primitives), synthesize the same default DSL
 * that noisedeck's "examples" tab and demo-ui's "buildDslSource" emit
 * — these are the canonical demonstrations of each effect, with pure
 * default parameter values.
 *
 * Library uses them to populate the default-particles and default-sim
 * sections of the side panel.
 */

import { getAllEffects } from './noisemaker/bundle.js'
import { buildDslSource } from './dslSourceBuilder.js'

const POINTS_TINT = '#7fd6ff'      // cool cyan
const SIM_TINT = '#d28cff'         // muted magenta

/**
 * Pull all effect IDs that should populate the default-particles or
 * default-sim sections from the renderer's manifest. The renderer must
 * have loadManifest() resolved before this is called.
 */
function selectIds(manifest) {
    const ids = []
    for (const [id, meta] of Object.entries(manifest || {})) {
        const tags = meta.tags || []
        const isPoints = id.startsWith('points/')
        const isSim = tags.includes('sim')
        // loopBegin / loopEnd are sim-tagged plumbing primitives, not
        // standalone-meaningful demos — they only make sense as part of
        // a larger feedback loop, which would need its own curated
        // entry.
        const isUtil = tags.includes('util')
        if ((isPoints || isSim) && !isUtil) ids.push(id)
    }
    return ids
}

function categoryFor(effect) {
    if (effect.namespace === 'points') return 'default-particles'
    return 'default-sim'
}

/**
 * Title-case an effect's func name (its camelCase identifier) into
 * something a touch friendlier on a card. `reactionDiffusion` →
 * "Reaction Diffusion".
 */
function prettify(name) {
    if (!name) return ''
    return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^[a-z]/, c => c.toUpperCase())
}

/**
 * Build default-program entries by:
 *  1. Reading the renderer's manifest for in-scope effect IDs.
 *  2. Loading those effects through the renderer (so they get
 *     registered globally and become visible via getAllEffects()).
 *  3. Calling buildDslSource on each registered effect.
 *
 * Returns an array of program entries in the same shape as the curated
 * data/programs.json entries (title, tagline, tint, tags, dsl, source).
 */
export async function buildDefaultPrograms(renderer) {
    if (!renderer?.manifest) return []

    const ids = selectIds(renderer.manifest)
    if (!ids.length) return []

    // Load all in parallel — already-loaded effects are no-ops thanks
    // to the renderer's internal dedup.
    await renderer.loadEffects(ids)

    const registry = getAllEffects()
    const programs = []

    for (const id of ids) {
        // registry.get(id) returns the bare Effect *instance* (the
        // registry stores instances keyed by several aliases — see
        // CanvasRenderer.registerEffectWithRuntime). buildDslSource
        // expects the wrapper shape `{ namespace, name, instance }`
        // that the demo UI and noisedeck use, so reconstruct it here
        // from the manifest ID + registry lookup.
        const instance = registry.get(id)
        if (!instance) continue
        const [namespace, name] = id.split('/')
        const effect = { namespace, name, instance }

        let dsl
        try {
            dsl = buildDslSource(effect)
        } catch (err) {
            console.warn(`[defaultPrograms] failed to synthesize DSL for ${id}:`, err)
            continue
        }
        if (!dsl) continue

        const category = categoryFor(effect)
        const tint = category === 'default-particles' ? POINTS_TINT : SIM_TINT
        const funcName = instance?.func || name
        const manifestMeta = renderer.manifest[id] || {}

        programs.push({
            title: prettify(funcName),
            tagline: manifestMeta.description || effect.instance?.description || '',
            tint,
            tags: [...new Set([effect.namespace, ...(manifestMeta.tags || [])].filter(Boolean))],
            dsl,
            source: {
                kind: 'engine-default',
                effectId: id,
                namespace: effect.namespace,
                func: funcName,
            },
        })
    }

    // Stable order: points namespace first (alphabetical), then sim
    // (alphabetical). Library renders sections in the configured order
    // — within a section, alphabetical is the most predictable.
    programs.sort((a, b) => {
        const ca = a.source.kind === 'engine-default' && a.source.namespace === 'points' ? 0 : 1
        const cb = b.source.kind === 'engine-default' && b.source.namespace === 'points' ? 0 : 1
        if (ca !== cb) return ca - cb
        return a.title.localeCompare(b.title)
    })

    return programs
}
