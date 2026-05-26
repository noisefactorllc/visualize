// SPDX-License-Identifier: MIT
/**
 * Registry of noisemaker mixer effects exposed in the center-mixer
 * picker. Each entry knows:
 *   - effectId:     noisemaker effect ID (e.g. 'mixer/blendMode')
 *   - label:        short user-facing name shown in the dropdown
 *   - driver:       the param name the crossfader drives (e.g. 'mix',
 *                   'position', 'scale'); the dropdown picks the
 *                   semantically correct knob for each effect
 *   - driverRange:  [min, max] — what to map xfade∈[0,1] to
 *   - defaults:     starting values for the effect's other parameters
 *                   (used when no manual override exists)
 *   - dslArgs(mix): returns the arg-string fragment that goes inside
 *                   the effect call. Receives the crossfader value 0-1
 *                   plus any user overrides via `overrides`.
 *
 * The crossfader at 0 = "all deck A", 1 = "all deck B" is preserved
 * for any effect whose driver param has that natural reading
 * (blendMode mix, alphaMask mix, split position). For mixer effects
 * whose primary knob doesn't have an A↔B reading (cellSplit scale,
 * patternMix scale, shapeMask radius), the xfade is treated as
 * "transition amount" — 0 = no mix, 1 = full mix.
 *
 * Effects we explicitly don't expose (yet):
 *   - mixer/channelCombine — needs three independent inputs (R/G/B),
 *     not a two-deck blend; would need its own UI.
 *   - mixer/focusBlur, mixer/distortion, mixer/uvRemap, mixer/shadow,
 *     mixer/thresholdMix — these use deck B as a *data source* (depth
 *     map / displacement map / mask) rather than a layer to blend.
 *     Visually interesting but conceptually distinct from a crossfader;
 *     can be added in a follow-up with their own driver mappings.
 */

const MIX = (lo, hi) => (x) => lo + (hi - lo) * x

/**
 * The `mix` parameter on mixer/blendMode / alphaMask / centerMask /
 * applyMode is actually mapped to GLSL uniform `mixAmt` with range
 * [-100, 100]: -100 = pure A, 0 = pure middle blend, +100 = pure B.
 * (See noisemaker/shaders/effects/mixer/blendMode/glsl/blendMode.glsl
 * — `map(mixAmt, -100, 100, 0, 1)` drives a two-stage mix(A, middle,
 * factor) → mix(middle, B, factor) crossfade.)
 *
 * Map the crossfader xfade∈[0,1] into [-100, 100].
 */
const mix100 = (x) => (x * 200 - 100).toFixed(2)

export const MIXERS = [
    {
        id: 'mixer/blendMode',
        label: 'blend',
        driver: 'mix',                // uniform alias for `mixAmt`
        driverRange: [-100, 100],
        defaults: { mode: 'mix' },
        dslArgs: (xfade, overrides = {}) => {
            const mode = overrides.mode || 'mix'
            return `tex: read(o1), mode: ${mode}, mix: ${mix100(xfade)}`
        },
        modes: ['mix', 'add', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'darken', 'lighten', 'subtract', 'diff', 'exclusion', 'phoenix', 'dodge', 'burn', 'negation'],
    },
    {
        id: 'mixer/alphaMask',
        label: 'alpha',
        driver: 'mix',
        driverRange: [-100, 100],
        defaults: { maskMode: 0 },
        dslArgs: (xfade) => `tex: read(o1), mix: ${mix100(xfade)}`,
    },
    {
        id: 'mixer/applyMode',
        label: 'apply',
        driver: 'mix',
        driverRange: [-100, 100],
        defaults: { mode: 'brightness' },
        dslArgs: (xfade, overrides = {}) => {
            const mode = overrides.mode || 'brightness'
            return `tex: read(o1), mode: ${mode}, mix: ${mix100(xfade)}`
        },
        modes: ['brightness', 'hue', 'saturation'],
    },
    {
        id: 'mixer/centerMask',
        label: 'center',
        driver: 'mix',
        driverRange: [-100, 100],
        defaults: { shape: 'circle', hardness: 0.5 },
        dslArgs: (xfade, overrides = {}) => {
            const shape = overrides.shape || 'circle'
            const hard = overrides.hardness ?? 0.5
            return `tex: read(o1), shape: ${shape}, hardness: ${hard.toFixed(3)}, mix: ${mix100(xfade)}`
        },
    },
    {
        id: 'mixer/split',
        // Shader: position=+1 → all colorA, position=-1 → all colorB,
        // so we invert: xfade=0 (A) → position=+1, xfade=1 (B) → -1.
        label: 'split',
        driver: 'position',
        driverRange: [1, -1],
        defaults: { rotation: 0, softness: 0.05 },
        dslArgs: (xfade, overrides = {}) => {
            const rot = overrides.rotation ?? 0
            const soft = overrides.softness ?? 0.05
            const pos = (1 - xfade * 2).toFixed(3)
            return `tex: read(o1), position: ${pos}, rotation: ${rot}, softness: ${soft}`
        },
    },
    {
        id: 'mixer/patternMix',
        // thickness 0..1: 0 = none of B → all A; 1 = all B over A
        label: 'pattern',
        driver: 'thickness',
        driverRange: [0, 1],
        defaults: { type: 'stripes', scale: 8, smoothness: 0.5, rotation: 0 },
        dslArgs: (xfade, overrides = {}) => {
            const type = overrides.type || 'stripes'
            const scale = overrides.scale ?? 8
            const smooth = overrides.smoothness ?? 0.5
            const rot = overrides.rotation ?? 0
            return `tex: read(o1), type: ${type}, scale: ${scale}, thickness: ${xfade.toFixed(3)}, smoothness: ${smooth}, rotation: ${rot}`
        },
    },
    {
        id: 'mixer/shapeMask',
        // Shader: inside shape → colorA, outside → colorB. So a small
        // shape (radius 0) means mostly-outside = mostly-B, and a big
        // shape (radius 1) means mostly-inside = mostly-A. To pan A→B,
        // start large and shrink: xfade=0 → radius=1 (all A), xfade=1
        // → radius=0 (all B).
        label: 'shape',
        driver: 'radius',
        driverRange: [1, 0],
        defaults: { shape: 'circle', edgeSmooth: 0.05, posX: 0, posY: 0 },
        dslArgs: (xfade, overrides = {}) => {
            const shape = overrides.shape || 'circle'
            const edge = overrides.edgeSmooth ?? 0.05
            const px = overrides.posX ?? 0
            const py = overrides.posY ?? 0
            const radius = (1 - xfade).toFixed(3)
            return `tex: read(o1), shape: ${shape}, radius: ${radius}, edgeSmooth: ${edge}, posX: ${px}, posY: ${py}`
        },
    },
]

export function getMixer(id) {
    return MIXERS.find(m => m.id === id) || MIXERS[0]
}

export const DEFAULT_MIXER_ID = 'mixer/blendMode'
