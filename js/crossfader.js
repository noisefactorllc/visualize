// SPDX-License-Identifier: MIT
/**
 * Crossfader utilities and keyboard nudge calculations.
 *
 * Provides standardized nudge increments for VJ performance:
 * - Standard step: 5% (0.05) on ArrowLeft / ArrowRight
 * - Fine step: 1% (0.01) on Shift+ArrowLeft / Shift+ArrowRight
 *
 * All calculations clamp to [0, 1] and round to 4 decimal places to
 * eliminate IEEE 754 floating-point drift across successive nudges.
 */

export const CROSSFADE_NUDGE_STEP_STANDARD = 0.05
export const CROSSFADE_NUDGE_STEP_FINE = 0.01

export const CROSSFADE_ACCEL_REPEAT_THRESHOLD = 3
export const CROSSFADE_ACCEL_RAMP_RATE = 0.25
export const CROSSFADE_ACCEL_MAX_MULTIPLIER = 2.5

/**
 * Valid crossfade curve names, matching the compositor's XFADE_CURVES
 * (linear, dipped equal-power, sharp, hard cut) and the #automix-curve
 * dropdown options. Used to validate persisted / restored curve values.
 */
export const CROSSFADE_CURVES = ['linear', 'dipped', 'sharp', 'cut']
export const CROSSFADE_DEFAULT_CURVE = 'dipped'

/**
 * Validate and normalize a crossfade curve name.
 *
 * @param {*} raw - Raw value (e.g. from localStorage or a dropdown)
 * @param {Object} [options]
 * @param {string} [options.defaultCurve=CROSSFADE_DEFAULT_CURVE] - Fallback for invalid input
 * @returns {string} A valid curve name
 */
export function parseCrossfadeCurve(raw, { defaultCurve = CROSSFADE_DEFAULT_CURVE } = {}) {
    if (typeof raw !== 'string') return defaultCurve
    const name = raw.toLowerCase().trim()
    return CROSSFADE_CURVES.includes(name) ? name : defaultCurve
}

/**
 * Compute the acceleration multiplier for a sustained repeat count.
 *
 * @param {number} repeatCount - Number of consecutive repeat events (0 for initial keypress)
 * @param {Object} [options]
 * @param {number} [options.threshold=CROSSFADE_ACCEL_REPEAT_THRESHOLD] - Repeat count before acceleration begins
 * @param {number} [options.rampRate=CROSSFADE_ACCEL_RAMP_RATE] - Multiplier increase per repeat past threshold
 * @param {number} [options.maxMultiplier=CROSSFADE_ACCEL_MAX_MULTIPLIER] - Maximum multiplier cap
 * @returns {number} Multiplier >= 1.0 rounded to 4 decimals
 */
export function calculateNudgeMultiplier(repeatCount = 0, {
    threshold = CROSSFADE_ACCEL_REPEAT_THRESHOLD,
    rampRate = CROSSFADE_ACCEL_RAMP_RATE,
    maxMultiplier = CROSSFADE_ACCEL_MAX_MULTIPLIER
} = {}) {
    const count = typeof repeatCount === 'number' && Number.isFinite(repeatCount) ? Math.max(0, repeatCount) : 0
    if (count <= threshold) return 1.0
    const raw = Math.min(maxMultiplier, 1 + (count - threshold) * rampRate)
    return Math.round(raw * 10000) / 10000
}

/**
 * Calculate the next crossfader position when nudged.
 *
 * @param {number|string} current - Current crossfade value in [0, 1]
 * @param {'left'|'right'|'arrowleft'|'arrowright'|-1|1} direction - Nudge direction
 * @param {Object} [options]
 * @param {boolean} [options.shiftKey=false] - When true, use fine 1% (0.01) step instead of standard 5% (0.05)
 * @param {number} [options.step] - Explicit step override (bypasses acceleration when specified)
 * @param {boolean} [options.repeat=false] - Whether this nudge is a repeat event
 * @param {number} [options.repeatCount=0] - Consecutive repeat count for sustained acceleration
 * @param {number} [options.maxMultiplier] - Custom acceleration multiplier cap
 * @param {number} [options.rampRate] - Custom acceleration ramp rate
 * @param {number} [options.threshold] - Custom repeat count threshold before accelerating
 * @returns {number} Clamped and precision-rounded value in [0, 1]
 */
export function calculateCrossfadeNudge(current, direction, {
    shiftKey = false,
    step,
    repeat = false,
    repeatCount = 0,
    maxMultiplier,
    rampRate,
    threshold
} = {}) {
    const num = typeof current === 'number' ? current : Number(current)
    const cur = Number.isFinite(num) ? num : 0

    let resolvedStep
    if (typeof step === 'number' && Number.isFinite(step) && step > 0) {
        resolvedStep = step
    } else {
        const base = shiftKey ? CROSSFADE_NUDGE_STEP_FINE : CROSSFADE_NUDGE_STEP_STANDARD
        const count = typeof repeatCount === 'number' && Number.isFinite(repeatCount) && repeatCount > 0
            ? repeatCount
            : (repeat ? 1 : 0)
        const mult = calculateNudgeMultiplier(count, { maxMultiplier, rampRate, threshold })
        resolvedStep = base * mult
    }

    const dir = typeof direction === 'string' ? direction.toLowerCase().trim() : direction
    const isLeft = dir === 'left' || dir === 'arrowleft' || dir === 'arrowdown' || dir === 'down' || dir === -1
    const isRight = dir === 'right' || dir === 'arrowright' || dir === 'arrowup' || dir === 'up' || dir === 1

    if (!isLeft && !isRight) return cur

    const sign = isLeft ? -1 : 1
    const raw = Math.max(0, Math.min(1, cur + sign * resolvedStep))
    return Math.round(raw * 10000) / 10000
}

/**
 * Manages stateful repeat acceleration for live crossfader keyboard nudging.
 */
export class CrossfadeNudgeTracker {
    constructor() {
        this.activeDirection = null
        this.repeatCount = 0
    }

    /**
     * Register a nudge event and return the computed next crossfader value.
     *
     * @param {number} current - Current crossfade value [0, 1]
     * @param {string|number} direction - 'left' | 'right' | 'arrowleft' etc.
     * @param {Object} [options]
     * @param {boolean} [options.shiftKey=false]
     * @param {boolean} [options.repeat=false] - Event e.repeat flag
     * @param {number} [options.step]
     * @returns {{ value: number, repeatCount: number, multiplier: number, step: number }}
     */
    nudge(current, direction, { shiftKey = false, repeat = false, step } = {}) {
        const normDir = (typeof direction === 'string' ? direction.toLowerCase().trim() : direction)
        const isLeft = normDir === 'left' || normDir === 'arrowleft' || normDir === 'arrowdown' || normDir === 'down' || normDir === -1
        const isRight = normDir === 'right' || normDir === 'arrowright' || normDir === 'arrowup' || normDir === 'up' || normDir === 1
        const canonicalDir = isLeft ? 'left' : (isRight ? 'right' : null)

        if (!canonicalDir) {
            this.reset()
            return {
                value: calculateCrossfadeNudge(current, direction, { shiftKey, step }),
                repeatCount: 0,
                multiplier: 1.0,
                step: 0
            }
        }

        if (this.activeDirection !== canonicalDir) {
            this.activeDirection = canonicalDir
            this.repeatCount = 0
        } else if (repeat) {
            this.repeatCount++
        } else {
            this.repeatCount = 0
        }

        const mult = calculateNudgeMultiplier(this.repeatCount)
        const nextVal = calculateCrossfadeNudge(current, canonicalDir, {
            shiftKey,
            step,
            repeatCount: this.repeatCount
        })

        const base = shiftKey ? CROSSFADE_NUDGE_STEP_FINE : CROSSFADE_NUDGE_STEP_STANDARD
        const effStep = typeof step === 'number' && step > 0 ? step : base * mult

        return {
            value: nextVal,
            repeatCount: this.repeatCount,
            multiplier: mult,
            step: Math.round(effStep * 10000) / 10000
        }
    }

    /**
     * Reset tracker state (called on keyup, blur, window blur, visibility change).
     */
    reset() {
        this.activeDirection = null
        this.repeatCount = 0
    }
}
