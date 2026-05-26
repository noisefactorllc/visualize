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

export const MIXERS = [
    {
        id: 'mixer/blendMode',
        label: 'blend',
        driver: 'mix',
        defaults: { mode: 'mix' },
        dslArgs: (xfade, overrides = {}) => {
            const mode = overrides.mode || 'mix'
            return `tex: read(o1), mode: ${mode}, mix: ${xfade.toFixed(3)}`
        },
        modes: ['mix', 'add', 'multiply', 'screen', 'overlay', 'softLight', 'hardLight', 'darken', 'lighten', 'subtract', 'diff', 'exclusion', 'phoenix', 'dodge', 'burn', 'negation'],
    },
    {
        id: 'mixer/alphaMask',
        label: 'alpha',
        driver: 'mix',
        defaults: { maskMode: 0 },
        dslArgs: (xfade) => `tex: read(o1), mix: ${xfade.toFixed(3)}`,
    },
    {
        id: 'mixer/applyMode',
        label: 'apply',
        driver: 'mix',
        defaults: { mode: 'brightness' },
        dslArgs: (xfade, overrides = {}) => {
            const mode = overrides.mode || 'brightness'
            return `tex: read(o1), mode: ${mode}, mix: ${xfade.toFixed(3)}`
        },
        modes: ['brightness', 'hue', 'saturation'],
    },
    {
        id: 'mixer/centerMask',
        label: 'center',
        driver: 'mix',
        defaults: { shape: 'circle', hardness: 0.5 },
        dslArgs: (xfade, overrides = {}) => {
            const shape = overrides.shape || 'circle'
            const hard = overrides.hardness ?? 0.5
            return `tex: read(o1), shape: ${shape}, hardness: ${hard.toFixed(3)}, mix: ${xfade.toFixed(3)}`
        },
    },
    {
        id: 'mixer/split',
        label: 'split',
        driver: 'position',
        defaults: { rotation: 0, softness: 0.05 },
        dslArgs: (xfade, overrides = {}) => {
            const rot = overrides.rotation ?? 0
            const soft = overrides.softness ?? 0.05
            return `tex: read(o1), position: ${xfade.toFixed(3)}, rotation: ${rot}, softness: ${soft}`
        },
    },
    {
        id: 'mixer/cellSplit',
        label: 'cells',
        driver: 'edgeWidth',
        defaults: { scale: 8, seed: 1 },
        dslArgs: (xfade, overrides = {}) => {
            const scale = overrides.scale ?? 8
            const seed = overrides.seed ?? 1
            // xfade drives edgeWidth so 0 = sharp cell boundary
            // showing roughly half A / half B, 1 = wide soft blend.
            const edge = MIX(0.001, 0.5)(xfade).toFixed(3)
            return `tex: read(o1), scale: ${scale}, edgeWidth: ${edge}, seed: ${seed}`
        },
    },
    {
        id: 'mixer/patternMix',
        label: 'pattern',
        driver: 'thickness',
        defaults: { type: 'stripes', scale: 8, smoothness: 0.5, rotation: 0 },
        dslArgs: (xfade, overrides = {}) => {
            const type = overrides.type || 'stripes'
            const scale = overrides.scale ?? 8
            const smooth = overrides.smoothness ?? 0.5
            const rot = overrides.rotation ?? 0
            // xfade drives stripe thickness 0→1 so 0 = all A, 1 = all B
            const thick = xfade.toFixed(3)
            return `tex: read(o1), type: ${type}, scale: ${scale}, thickness: ${thick}, smoothness: ${smooth}, rotation: ${rot}`
        },
    },
    {
        id: 'mixer/shapeMask',
        label: 'shape',
        driver: 'radius',
        defaults: { shape: 'circle', edgeSmooth: 0.05, posX: 0.5, posY: 0.5 },
        dslArgs: (xfade, overrides = {}) => {
            const shape = overrides.shape || 'circle'
            const edge = overrides.edgeSmooth ?? 0.05
            const px = overrides.posX ?? 0.5
            const py = overrides.posY ?? 0.5
            // xfade drives shape radius 0→0.9 so the shape grows from
            // a point (all A) to cover most of the frame (mostly B).
            const radius = MIX(0, 0.9)(xfade).toFixed(3)
            return `tex: read(o1), shape: ${shape}, radius: ${radius}, edgeSmooth: ${edge}, posX: ${px}, posY: ${py}`
        },
    },
]

export function getMixer(id) {
    return MIXERS.find(m => m.id === id) || MIXERS[0]
}

export const DEFAULT_MIXER_ID = 'mixer/blendMode'
