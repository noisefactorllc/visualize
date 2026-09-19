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

/**
 * Calculate the next crossfader position when nudged.
 *
 * @param {number|string} current - Current crossfade value in [0, 1]
 * @param {'left'|'right'|'arrowleft'|'arrowright'|-1|1} direction - Nudge direction
 * @param {Object} [options]
 * @param {boolean} [options.shiftKey=false] - When true, use fine 1% (0.01) step instead of standard 5% (0.05)
 * @param {number} [options.step] - Explicit step override
 * @returns {number} Clamped and precision-rounded value in [0, 1]
 */
export function calculateCrossfadeNudge(current, direction, { shiftKey = false, step } = {}) {
    const num = typeof current === 'number' ? current : Number(current)
    const cur = Number.isFinite(num) ? num : 0

    const resolvedStep = typeof step === 'number' && Number.isFinite(step) && step > 0
        ? step
        : (shiftKey ? CROSSFADE_NUDGE_STEP_FINE : CROSSFADE_NUDGE_STEP_STANDARD)

    const dir = typeof direction === 'string' ? direction.toLowerCase().trim() : direction
    const isLeft = dir === 'left' || dir === 'arrowleft' || dir === 'arrowdown' || dir === 'down' || dir === -1
    const isRight = dir === 'right' || dir === 'arrowright' || dir === 'arrowup' || dir === 'up' || dir === 1

    if (!isLeft && !isRight) return cur

    const sign = isLeft ? -1 : 1
    const raw = Math.max(0, Math.min(1, cur + sign * resolvedStep))
    return Math.round(raw * 10000) / 10000
}
