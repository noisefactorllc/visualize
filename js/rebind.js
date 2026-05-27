// SPDX-License-Identifier: MIT
/**
 * Rebind — per-deck reshuffle of audio/MIDI parameter bindings.
 *
 * Each program's original DSL is the source of truth. On a "rebind"
 * action we:
 *   1. compile(originalDsl) → compiled
 *   2. pick 2-4 random numeric params from the compiled pipeline
 *   3. generate Audio (or Midi) automation override objects for them
 *   4. unparse(compiled, overrides) → new DSL
 *   5. deck.reloadDsl(newDsl) — does NOT touch rebind state
 *
 * Numeric param discovery comes straight from the effect manifest
 * (getEffect(effectKey).globals[paramName]). No per-program curation.
 */

import {
    compile, unparse, extractEffectsFromDsl,
    getEffect, formatValue, stdEnums
} from './noisemaker/bundle.js'

// Tag → band index (matches tags written by the curated library).
const TAG_TO_BAND = { bass: 0, mid: 1, high: 2 }

// MIDI mode index → enum name, mirroring midiModeNames in the bundle:
//   0 noteChange, 1 gateNote, 2 gateVelocity, 3 triggerNote, 4 velocity
// We randomize across 2/3/4 (gateVelocity, triggerNote, velocity) —
// the pitch-driven modes 0/1 are unintuitive when the operator hasn't
// picked specific notes.
const MIDI_MODE_INDICES = [2, 3, 4]

/**
 * Pick home bands for a program from its tags. A program tagged
 * ["bass", "mid"] returns [0, 1]. Untagged → all three bands.
 */
export function homeBandsForProgram(program) {
    const tags = program?.tags || []
    const set = new Set()
    for (const tag of tags) {
        const idx = TAG_TO_BAND[tag]
        if (idx !== undefined) set.add(idx)
    }
    if (set.size === 0) return [0, 1, 2]
    return [...set].sort()
}

/**
 * Walk the compiled DSL and collect every (stepIndex, paramName, spec)
 * tuple that's rebindable: numeric scalar (float/int), with min+max
 * defined, not a `ui.control: false` knob, not a private `_`-prefixed
 * parameter.
 */
export function collectRebindableParams(originalDsl) {
    const effects = extractEffectsFromDsl(originalDsl) || []
    const out = []
    for (const eff of effects) {
        const def = getEffect(eff.effectKey)
        if (!def?.globals) continue
        for (const [paramName, spec] of Object.entries(def.globals)) {
            if (!spec) continue
            if (spec.type !== 'float' && spec.type !== 'int') continue
            if (spec.ui && spec.ui.control === false) continue
            if (spec.min === undefined || spec.max === undefined) continue
            if (paramName.startsWith('_')) continue
            out.push({
                stepIndex: eff.stepIndex,
                effectKey: eff.effectKey,
                paramName,
                spec
            })
        }
    }
    return out
}

/**
 * Pick a random (min, max) sub-window inside [lo, hi]. One of three
 * flavours, equally weighted:
 *   full   — (lo, hi)
 *   narrow — random 20-40% slice somewhere inside
 *   invert — (hi, lo)  (parameter still sweeps the same range but
 *                       tracks audio inversely)
 *
 * `rand` is an optional injected RNG for deterministic tests; defaults
 * to Math.random.
 */
export function randomSubWindow(lo, hi, rand = Math.random) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        return [lo, hi]
    }
    const flavour = Math.floor(rand() * 3)
    if (flavour === 0) return [lo, hi]
    if (flavour === 2) return [hi, lo]
    const span = hi - lo
    const widthPct = 0.2 + rand() * 0.2     // 20%-40%
    const width = span * widthPct
    const startPct = rand() * (1 - widthPct)
    const start = lo + span * startPct
    return [round3(start), round3(start + width)]
}

function round3(v) { return Math.round(v * 1000) / 1000 }

function shuffle(arr, rand = Math.random) {
    const out = [...arr]
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
            ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

function pickN(arr, n, rand = Math.random) {
    return shuffle(arr, rand).slice(0, n)
}

/**
 * Build an Audio automation in RESOLVED form — the shape `formatValue`
 * (the inline-kwargs unparse path) expects: numeric band index, plain
 * numbers for min/max. The AST form used by `formatLetExpr` would not
 * round-trip through this path.
 */
function audioNode(bandIndex, m1, m2) {
    return { type: 'Audio', band: bandIndex, min: m1, max: m2 }
}

/** Build a Midi automation in resolved form (numeric mode index). */
function midiNode(channel, modeIndex, m1, m2) {
    return {
        type: 'Midi',
        channel,
        mode: modeIndex,
        min: m1,
        max: m2,
        sensitivity: 1
    }
}

/**
 * Convert the override map to the shape `unparse` expects: keyed by
 * globalStepIndex, with `{ [paramName]: value }` per step.
 */
function overridesToUnparseShape(overrideMap) {
    const out = {}
    for (const [stepIndex, params] of Object.entries(overrideMap)) {
        out[stepIndex] = { ...params }
    }
    return out
}

/**
 * Core rewrite: compile the original DSL, splice in the overrides,
 * unparse to text. Returns the new DSL string, or null on failure.
 */
export function regenerateDsl(originalDsl, overrideMap) {
    let compiled
    try {
        compiled = compile(originalDsl)
    } catch (err) {
        console.warn('[rebind] compile failed:', err?.message || err)
        return null
    }
    try {
        return unparse(compiled, overridesToUnparseShape(overrideMap), {
            enums: stdEnums,
            customFormatter: (v, spec) => formatValue(v, spec, { enums: stdEnums }),
            getEffectDef: (name) => getEffect(name)
        })
    } catch (err) {
        console.warn('[rebind] unparse failed:', err?.message || err)
        return null
    }
}

/**
 * Build a fresh override map of n random Audio bindings, drawn from
 * `rebindable` and constrained to `homeBands` when bandpass is true.
 */
export function buildAudioOverrides({
    rebindable, homeBands, bandpass, count, rand = Math.random
}) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const bands = bandpass ? homeBands : [0, 1, 2]
    const out = {}
    for (const p of picked) {
        const bandIdx = bands[Math.floor(rand() * bands.length)]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        out[p.stepIndex][p.paramName] = audioNode(bandIdx, m1, m2)
    }
    return out
}

/** Build a fresh override map of n random Midi bindings. */
export function buildMidiOverrides({ rebindable, count, rand = Math.random }) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const out = {}
    for (const p of picked) {
        const channel = Math.floor(rand() * 16)
        const modeIndex = MIDI_MODE_INDICES[Math.floor(rand() * MIDI_MODE_INDICES.length)]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        out[p.stepIndex][p.paramName] = midiNode(channel, modeIndex, m1, m2)
    }
    return out
}

/**
 * Roll a new Audio rebind on the given deck. Async — resolves to true
 * once the regenerated DSL has been pushed through the renderer's
 * compile path. Fire-and-forget callers (UI buttons) can ignore the
 * promise; tests and scene recall await it to observe the new state.
 */
export async function rebindEq(deck, program, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const homeBands = homeBandsForProgram(program)
    const count = 2 + Math.floor(rand() * 3)   // 2,3,4
    const overrides = buildAudioOverrides({
        rebindable, homeBands, bandpass: rebind.bandpass, count, rand
    })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}

/** Roll a new Midi rebind on the given deck. Async; see rebindEq. */
export async function rebindMidi(deck, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const count = 2 + Math.floor(rand() * 3)
    const overrides = buildMidiOverrides({ rebindable, count, rand })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}

/** Drop all overrides and reload the original DSL. Async. */
export async function clearRebinds(deck) {
    if (!deck.rebind) return false
    deck.rebind.overrides = {}
    if (!deck.rebind.originalDsl) return false
    const res = await deck.reloadDsl(deck.rebind.originalDsl)
    return !!res?.success
}

/** Re-apply the current override map. Async. Used by scene recall. */
export async function applyRebinds(deck) {
    if (!deck.rebind?.originalDsl) return false
    return _applyAndLoad(deck)
}

async function _applyAndLoad(deck) {
    const dsl = regenerateDsl(deck.rebind.originalDsl, deck.rebind.overrides)
    if (!dsl) return false
    const res = await deck.reloadDsl(dsl)
    return !!res?.success
}
