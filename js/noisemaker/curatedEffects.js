// SPDX-License-Identifier: MIT
let bundlePromise
let runtimePrograms = new Map()
let registrationQueue = Promise.resolve()

export function curatedRuntimeDsl(dsl) {
    return runtimePrograms.get(dsl.trim()) || dsl
}

// Curated effects use distinct runtime identifiers from installed user effects.
export async function registerCuratedEffects(renderer, { getEffect, Effect, registerNamespace, registerEffect, unregisterEffect }) {
    if (!bundlePromise) {
        const readJson = async path => {
            const response = await fetch(new URL(path, import.meta.url), { cache: 'no-cache' })
            if (!response.ok) throw new Error(`Failed to load curated bundle: ${response.status}`)
            const data = await response.json()
            if (!Array.isArray(data)) throw new Error('Invalid curated bundle')
            return data
        }
        bundlePromise = Promise.all([
            readJson('../../data/curated-effects.json'), readJson('../../data/programs.json'),
        ]).then(([effects, programs]) => {
            runtimePrograms = new Map(programs.filter(p => p.runtimeDsl).map(p => [p.dsl.trim(), p.runtimeDsl]))
            return effects
        }).catch(error => { bundlePromise = undefined; throw error })
    }
    const payloads = await bundlePromise
    const register = async () => {
        registerNamespace('curated', { description: 'Noisemaker curated programs' })
        for (const payload of payloads) {
            const name = payload.func || payload.name
            const id = `curated/${name}`
            const existing = getEffect(id)
            if (existing) {
                renderer._loadedEffects.set(id, { namespace: 'curated', name, instance: existing })
            } else {
                const previousBare = getEffect(name)
                try {
                    const instance = new Effect({ ...payload, namespace: 'curated' })
                    instance.shaders = payload.shaders
                    renderer.registerEffectsFromBundle({ namespace: 'curated', effects: { [name]: instance } })
                } finally {
                    if (previousBare === undefined) unregisterEffect(name)
                    else registerEffect(name, previousBare)
                }
            }
        }
    }
    const result = registrationQueue.then(register)
    registrationQueue = result.catch(() => {})
    await result
}
