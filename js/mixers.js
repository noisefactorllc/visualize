// SPDX-License-Identifier: MIT
/**
 * Registry of noisemaker mixer effects exposed in the center-mixer
 * picker. Each entry knows:
 *   - id:           noisemaker effect ID (e.g. 'mixer/blendMode')
 *   - label:        short user-facing name shown in the dropdown
 *   - driver:       the param the crossfader drives (`mix` /
 *                   `position` / `thickness` / `radius` / …)
 *   - driverFormula(xfade ∈ [0,1]) → value in the param's native
 *                   range (e.g. mix∈[-100,100], position∈[-1,1])
 *   - defaults:     starting values for the effect's *other*
 *                   parameters; the mixer-controls panel reads these
 *                   as the initial UI state, the user can then
 *                   override them and the override lands in
 *                   _currentOverrides on the MixerRenderer
 *
 *   - modes:        (optional) discrete enum choices to expose as a
 *                   sub-dropdown in the topbar mixer-picker; mostly
 *                   for blendMode / applyMode where the "mode" knob
 *                   is the soul of the effect.
 *
 * dslArgs(xfade, overrides, effectDef) → string is built generically
 * by `buildDslArgs` below — no per-mixer DSL templating. Every param
 * in `defaults` (and overrides) flows into the compiled DSL the same
 * way, so any future param the noisemaker side adds works "for free"
 * as soon as the panel exposes it.
 */

// mixer/blendMode + applyMode + centerMask all share the same `mix`
// semantics: GLSL uniform is `mixAmt` ∈ [-100, 100], where -100 = pure
// A, 0 = pure middle blend, +100 = pure B.
const mix100 = (x) => x * 200 - 100

export const MIXERS = [
    {
        id: 'mixer/blendMode',
        label: 'blend',
        driver: 'mix',
        driverFormula: mix100,
        defaults: { mode: 'mix' },
        modes: ['mix', 'add', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'darken', 'lighten', 'subtract', 'diff', 'exclusion', 'phoenix', 'dodge', 'burn', 'negation'],
    },
    {
        id: 'mixer/applyMode',
        label: 'apply',
        driver: 'mix',
        driverFormula: mix100,
        defaults: { mode: 'brightness' },
        modes: ['brightness', 'hue', 'saturation'],
    },
    {
        id: 'mixer/centerMask',
        label: 'center',
        driver: 'mix',
        driverFormula: mix100,
        defaults: { shape: 'circle', hardness: 0.5 },
    },
    {
        id: 'mixer/split',
        label: 'split',
        driver: 'position',
        // shader: position=+1 → all A, -1 → all B
        driverFormula: (x) => 1 - x * 2,
        defaults: { rotation: 0, softness: 0.05, speed: 0, invert: 0 },
    },
    {
        id: 'mixer/patternMix',
        label: 'pattern',
        driver: 'thickness',
        driverFormula: (x) => x,
        defaults: { type: 'stripes', scale: 8, smoothness: 0.5, rotation: 0, invert: 0 },
    },
    {
        id: 'mixer/shapeMask',
        label: 'shape',
        driver: 'radius',
        // shader: inside-shape→A, outside→B; radius 1 = all A, 0 = all B
        driverFormula: (x) => 1 - x,
        defaults: { shape: 'circle', edgeSmooth: 0.05, posX: 0, posY: 0, speed: 0, invert: 0 },
    },
]

export function getMixer(id) {
    return MIXERS.find(m => m.id === id) || MIXERS[0]
}

export const DEFAULT_MIXER_ID = 'mixer/blendMode'

/**
 * Serialize an effect parameter into DSL syntax. Enum / string
 * values render unquoted (e.g. `mode: mix`); numbers get formatted
 * by type. Returns null for values we don't know how to render
 * (caller should skip them).
 */
function formatDslArg(name, value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return `${name}: ${value}`
    if (typeof value === 'number') {
        return `${name}: ${Number.isInteger(value) ? value : Number(value.toFixed(4))}`
    }
    if (typeof value === 'boolean') return `${name}: ${value ? 'on' : 'off'}`
    return null
}

/**
 * Build the inner-arg string for a mixer effect call. Starts with
 * `tex: read(o1)` (deck B as the second input), then the driver
 * param computed from the current crossfader value, then every
 * non-driver param from defaults merged with overrides.
 */
export function buildDslArgs(mixer, xfade, overrides = {}) {
    const args = ['tex: read(o1)']

    const driverValue = mixer.driverFormula(xfade)
    const driverArg = formatDslArg(mixer.driver, driverValue)
    if (driverArg) args.push(driverArg)

    const merged = { ...mixer.defaults, ...overrides }
    for (const [name, value] of Object.entries(merged)) {
        if (name === mixer.driver) continue
        const arg = formatDslArg(name, value)
        if (arg) args.push(arg)
    }

    return args.join(', ')
}
