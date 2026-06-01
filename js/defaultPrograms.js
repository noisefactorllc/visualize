/**
 * Default programs synthesized from the engine's effect registry.
 *
 * For each effect in the user namespace (imported portable effects),
 * synthesize the same default DSL that noisedeck's "examples" tab and
 * demo-ui's "buildDslSource" emit — canonical demonstrations of each
 * effect with pure default parameter values.
 *
 * Library uses these to populate the user section of the side panel.
 */

import { getAllEffects } from './noisemaker/bundle.js'
import { buildDslSource } from './dslSourceBuilder.js'

const USER_TINT = '#ffd24e'        // warm yellow

function selectUserIds(registry) {
    const ids = []
    for (const key of registry.keys()) {
        if (typeof key === 'string' && key.startsWith('user/')) ids.push(key)
    }
    return ids
}

function prettify(name) {
    if (!name) return ''
    return name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^[a-z]/, c => c.toUpperCase())
}

export async function buildDefaultPrograms(renderer) {
    if (!renderer?.manifest) return []

    const registry = getAllEffects()
    const ids = selectUserIds(registry)
    if (!ids.length) return []

    const programs = []

    for (const id of ids) {
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

        const funcName = instance?.func || name
        const tagline = effect.instance?.description
            || instance?.description
            || ''
        const tags = effect.instance?.tags
            || instance?.tags
            || []

        programs.push({
            title: prettify(funcName),
            tagline,
            tint: USER_TINT,
            tags: [...new Set(['user', ...tags].filter(Boolean))],
            dsl,
            source: {
                kind: 'engine-default',
                effectId: id,
                namespace: 'user',
                func: funcName,
            },
        })
    }

    programs.sort((a, b) => a.title.localeCompare(b.title))

    return programs
}
