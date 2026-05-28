/**
 * DSL helper utilities.
 *
 * Tiny mirror of the helpers in noisedeck — visualize only needs
 * ensureRenderDirective right now (called by the default-program
 * synthesizer when an effect has no explicit defaultProgram).
 */

/**
 * Ensure DSL has an explicit render() directive. If none is found,
 * appends `render(oN)` where N is the last surface written to.
 */
export function ensureRenderDirective(dsl) {
    if (!dsl || typeof dsl !== 'string') return 'render(o0)'
    const trimmed = dsl.trim()
    if (/\brender\s*\(/.test(trimmed)) return dsl

    const writeMatches = [...trimmed.matchAll(/\.(?:write|out)\s*\(\s*(o\d+)\s*\)/g)]
    const renderSurface = writeMatches.length
        ? writeMatches[writeMatches.length - 1][1]
        : 'o0'

    return `${trimmed}\nrender(${renderSurface})`
}
