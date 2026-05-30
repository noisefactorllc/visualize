/**
 * Default programs synthesized from the engine's effect registry.
 *
 * For each effect in the points/* namespace, tagged "sim", or in the
 * user namespace (imported portable effects), synthesize the same
 * default DSL that noisedeck's "examples" tab and demo-ui's
 * "buildDslSource" emit — canonical demonstrations of each effect with
 * pure default parameter values.
 *
 * Library uses them to populate the default-particles, default-sim,
 * and user sections of the side panel.
 */

import { getAllEffects } from './noisemaker/bundle.js'
import { buildDslSource } from './dslSourceBuilder.js'

const POINTS_TINT = '#7fd6ff'      // cool cyan
const SIM_TINT = '#d28cff'         // muted magenta
const USER_TINT = '#ffd24e'        // warm yellow — distinct from engine defaults

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

/**
 * Pull every user-namespace effect from the engine's getAllEffects()
 * map. User effects don't live in the manifest (they're imported at
 * runtime via the user-effects manager), so we discover them by
 * scanning the registry for `user/...` keys.
 */
function selectUserIds(registry) {
    const ids = []
    for (const key of registry.keys()) {
        if (typeof key === 'string' && key.startsWith('user/')) ids.push(key)
    }
    return ids
}

function categoryFor(effect) {
    if (effect.namespace === 'user') return 'user'
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

    const manifestIds = selectIds(renderer.manifest)
    if (manifestIds.length) {
        // Load all in parallel — already-loaded effects are no-ops thanks
        // to the renderer's internal dedup.
        await renderer.loadEffects(manifestIds)
    }

    const registry = getAllEffects()
    // User effects were registered out-of-band by UserEffectsManager
    // (initialize/uploadFromZip) — they're in the registry but never
    // hit renderer.loadEffects, so we discover them here by namespace.
    const userIds = selectUserIds(registry)
    const ids = [...manifestIds, ...userIds]
    if (!ids.length) return []

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
        let tint = SIM_TINT
        if (category === 'default-particles') tint = POINTS_TINT
        else if (category === 'user') tint = USER_TINT
        const funcName = instance?.func || name
        const manifestMeta = renderer.manifest[id] || {}

        // User-effect descriptions live in the Effect instance, not in
        // the renderer's manifest (which only catalogs CDN-hosted
        // effects). Fall back through both.
        const tagline = manifestMeta.description
            || effect.instance?.description
            || instance?.description
            || ''
        const manifestTags = manifestMeta.tags
            || effect.instance?.tags
            || instance?.tags
            || []

        programs.push({
            title: prettify(funcName),
            tagline,
            tint,
            tags: [...new Set([effect.namespace, ...manifestTags].filter(Boolean))],
            dsl,
            source: {
                kind: 'engine-default',
                effectId: id,
                namespace: effect.namespace,
                func: funcName,
            },
        })
    }

    // Stable order within each category: points first (alphabetical),
    // then sim (alphabetical), then user (alphabetical). Library
    // renders sections in the configured order — within a section,
    // alphabetical is the most predictable.
    const categoryRank = {
        'default-particles': 0,
        'default-sim': 1,
        'user': 2,
    }
    programs.sort((a, b) => {
        const ca = categoryRank[categoryFor({ namespace: a.source.namespace })] ?? 9
        const cb = categoryRank[categoryFor({ namespace: b.source.namespace })] ?? 9
        if (ca !== cb) return ca - cb
        return a.title.localeCompare(b.title)
    })

    return programs
}
