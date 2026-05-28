/**
 * DSL Source Builder — synthesizes a default DSL program for any
 * registered effect, mirroring noisedeck's ui/dslSourceBuilder.js and
 * the demo UI's buildDslSource() so visualize's library demos match
 * what those tools show.
 *
 * Visualize only ever calls this with empty parameterValues (we want
 * each effect's pure-default form), but the function preserves the
 * same shape as noisedeck's so it can grow if we ever surface
 * parameter-aware defaults.
 */

import {
    isStarterEffect,
    hasTexSurfaceParam,
    hasExplicitTexParam,
    getVolGeoParams,
    is3dGenerator,
    is3dProcessor,
    unparseCall,
    formatValue,
} from './noisemaker/bundle.js'
import { ensureRenderDirective } from './dslHelpers.js'

function formatEffectCall(funcName, kwargs) {
    return unparseCall({ name: funcName, kwargs, args: [] })
}

function buildKwargs(globals, paramValues, boundFormatValue) {
    const kwargs = {}
    if (!globals) return kwargs

    for (const [key, spec] of Object.entries(globals)) {
        const value = paramValues[key]
        if (value === undefined || value === null) continue
        if (key === '_skip' && value === false) continue
        if (spec.default !== undefined) {
            const formattedValue = boundFormatValue(value, spec)
            const formattedDefault = boundFormatValue(spec.default, spec)
            if (formattedValue === formattedDefault) continue
        }
        kwargs[key] = value
    }
    return kwargs
}

/**
 * Build complete DSL source for an effect. Always returns a string
 * with an explicit render() directive.
 *
 * @param {object} effect - Effect entry from getAllEffects()
 * @param {object} [parameterValues={}] - Current parameter values
 * @param {Function} [boundFormatValue=formatValue] - Value formatter
 */
export function buildDslSource(effect, parameterValues = {}, boundFormatValue = formatValue) {
    if (!effect || !effect.instance) return ''

    if (effect.instance.defaultProgram) {
        return ensureRenderDirective(effect.instance.defaultProgram)
    }

    let searchNs = effect.namespace
    if (effect.namespace === 'render') {
        searchNs = 'synth, filter, render'
    } else if (effect.namespace === 'points') {
        searchNs = 'synth, points, render'
    } else if (['filter', 'mixer'].includes(effect.namespace)) {
        searchNs = `${effect.namespace}, synth`
    }
    const searchDirective = searchNs ? `search ${searchNs}\n\n` : ''
    const funcName = effect.instance.func

    const starter = isStarterEffect(effect)
    const hasTex = hasTexSurfaceParam(effect)
    const hasExplicitTex = hasExplicitTexParam(effect)
    const { volParam, geoParam } = getVolGeoParams(effect)
    const hasVolGeo = volParam && geoParam

    const fmtCall = (name, kwargs) => formatEffectCall(name, kwargs)
    const bkw = (globals) => buildKwargs(globals, parameterValues, boundFormatValue)

    // Paired points emit/render
    if (funcName === 'pointsEmit' || funcName === 'pointsRender') {
        return ensureRenderDirective(
            `search points, synth, render\n\nnoise()\n  .pointsEmit()\n  .physical()\n  .pointsRender()\n  .write(o0)\n\nrender(o0)`
        )
    }

    // Billboard render
    if (funcName === 'pointsBillboardRender') {
        return ensureRenderDirective(`search points, synth, render

polygon(
  radius: 0.7,
  fgAlpha: 0.1,
  bgAlpha: 0
)
  .write(o0)

noise(ridges: true)
  .pointsEmit(stateSize: x64)
  .physical()
  .pointsBillboardRender(
    tex: read(o0),
    pointSize: 40,
    sizeVariation: 50,
    rotationVar: 50
  )
  .write(o1)

render(o1)`)
    }

    // Mesh
    if (funcName === 'meshLoader' || funcName === 'meshRender') {
        return ensureRenderDirective(
            `search synth, render\n\nmeshLoader()\n  .meshRender()\n  .write(o0)\n\nrender(o0)`
        )
    }

    // Points namespace effects
    if (effect.namespace === 'points') {
        const kwargs = bkw(effect.instance.globals)
        const effectCall = fmtCall(funcName, kwargs)
        const viewModeSpec = effect.instance.globals?.viewMode
        const viewModeDefault = viewModeSpec?.default
        const pointsRenderArgs = viewModeDefault ? `viewMode: ${viewModeDefault}` : ''
        const pointsRenderCall = pointsRenderArgs ? `pointsRender(${pointsRenderArgs})` : 'pointsRender()'
        return ensureRenderDirective(
            `search points, synth, render\n\nnoise()\n  .pointsEmit()\n  .${effectCall}\n  .${pointsRenderCall}\n  .write(o0)\n\nrender(o0)`
        )
    }

    if (funcName === 'loopBegin' || funcName === 'loopEnd') {
        return ensureRenderDirective(
            `${searchDirective}noise(ridges: true)\n  .loopBegin(alpha: 95, intensity: 95)\n  .warp()\n  .loopEnd()\n  .write(o0)\n\nrender(o0)`
        )
    }

    const noiseCall = fmtCall('noise', { seed: 1, ridges: true })

    // 3D volume generators
    if (is3dGenerator(effect)) {
        let consumerVolumeSize = 32
        const kwargs = {}
        if (effect.instance.globals) {
            for (const [key, spec] of Object.entries(effect.instance.globals)) {
                if (key === volParam || key === geoParam) continue
                const value = parameterValues[key]
                if (value === undefined || value === null) continue
                if (key === 'volumeSize') consumerVolumeSize = value
                if (key === '_skip' && value === false) continue
                if (spec.default !== undefined) {
                    const formattedValue = boundFormatValue(value, spec)
                    const formattedDefault = boundFormatValue(spec.default, spec)
                    if (formattedValue === formattedDefault) continue
                }
                kwargs[key] = value
            }
        }

        if (hasVolGeo) {
            kwargs[volParam] = { type: 'Read3D', tex3d: { type: 'VolRef', name: 'vol0' }, geo: null }
            kwargs[geoParam] = { type: 'Read3D', tex3d: { type: 'GeoRef', name: 'geo0' }, geo: null }
            const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
            const effectCall = fmtCall(funcName, kwargs)
            return ensureRenderDirective(
                `search synth3d, filter3d, render\n\n${generatorCall}\n  .write3d(vol0, geo0)\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
            )
        }

        const effectCall = fmtCall(funcName, kwargs)
        return ensureRenderDirective(
            `search synth3d, filter3d, render\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
        )
    }

    // Effects with explicit vol/geo params
    if (hasVolGeo) {
        let consumerVolumeSize = 32
        const kwargs = {}
        if (effect.instance.globals) {
            for (const [key, spec] of Object.entries(effect.instance.globals)) {
                if (key === volParam || key === geoParam) continue
                const value = parameterValues[key]
                if (value === undefined || value === null) continue
                if (key === 'volumeSize') consumerVolumeSize = value
                if (key === '_skip' && value === false) continue
                if (spec.default !== undefined) {
                    const formattedValue = boundFormatValue(value, spec)
                    const formattedDefault = boundFormatValue(spec.default, spec)
                    if (formattedValue === formattedDefault) continue
                }
                kwargs[key] = value
            }
        }
        kwargs[volParam] = { type: 'Read3D', tex3d: { type: 'VolRef', name: 'vol0' }, geo: null }
        kwargs[geoParam] = { type: 'Read3D', tex3d: { type: 'GeoRef', name: 'geo0' }, geo: null }
        const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
        const effectCall = fmtCall(funcName, kwargs)
        return ensureRenderDirective(
            `search synth3d, filter3d, render\n\n${generatorCall}\n  .write3d(vol0, geo0)\n\n${effectCall}\n  .render3d()\n  .write(o0)\n\nrender(o0)`
        )
    }

    // Effects with explicit tex param
    if (hasExplicitTex) {
        const kwargs = bkw(effect.instance.globals)
        kwargs.tex = { type: 'Read', surface: 'o0' }
        const effectCall = fmtCall(funcName, kwargs)
        if (starter) {
            return ensureRenderDirective(
                `${searchDirective}${noiseCall}\n  .write(o0)\n\n${effectCall}\n  .write(o1)\n\nrender(o1)`
            )
        }
        const noiseCall2 = fmtCall('noise', { seed: 2, ridges: true })
        return ensureRenderDirective(
            `${searchDirective}${noiseCall}\n  .write(o0)\n\n${noiseCall2}\n  .${effectCall}\n  .write(o1)\n\nrender(o1)`
        )
    }

    if (starter) {
        const kwargs = bkw(effect.instance.globals)
        if (hasTex) {
            const sourceSurface = 'o0'
            const outputSurface = 'o1'
            const kwargsWithTex = { tex: { type: 'Read', surface: sourceSurface }, ...kwargs }
            const effectCall = fmtCall(funcName, kwargsWithTex)
            return ensureRenderDirective(
                `${searchDirective}${noiseCall}\n  .write(${sourceSurface})\n\n${effectCall}\n  .write(${outputSurface})\n\nrender(${outputSurface})`
            )
        }
        const effectCall = fmtCall(funcName, kwargs)
        return ensureRenderDirective(`${searchDirective}${effectCall}\n  .write(o0)\n\nrender(o0)`)
    }

    if (hasTex) {
        const kwargs = { tex: { type: 'Read', surface: 'o0' } }
        if (effect.instance.globals) {
            for (const [key, spec] of Object.entries(effect.instance.globals)) {
                if (key === 'tex' && spec.type === 'surface') continue
                const value = parameterValues[key]
                if (value === undefined || value === null) continue
                if (key === '_skip' && value === false) continue
                if (spec.default !== undefined) {
                    const formattedValue = boundFormatValue(value, spec)
                    const formattedDefault = boundFormatValue(spec.default, spec)
                    if (formattedValue === formattedDefault) continue
                }
                kwargs[key] = value
            }
        }
        const effectCall = fmtCall(funcName, kwargs)
        const noiseCall2 = fmtCall('noise', { seed: 2, ridges: true })
        return ensureRenderDirective(
            `${searchDirective}${noiseCall}\n  .write(o0)\n\n${noiseCall2}\n  .${effectCall}\n  .write(o1)\n\nrender(o1)`
        )
    }

    if (is3dProcessor(effect)) {
        let consumerVolumeSize = 32
        const kwargs = {}
        if (effect.instance.globals) {
            for (const [key, spec] of Object.entries(effect.instance.globals)) {
                const value = parameterValues[key]
                if (value === undefined || value === null) continue
                if (key === 'volumeSize') consumerVolumeSize = value
                if (key === '_skip' && value === false) continue
                if (spec.default !== undefined) {
                    const formattedValue = boundFormatValue(value, spec)
                    const formattedDefault = boundFormatValue(spec.default, spec)
                    if (formattedValue === formattedDefault) continue
                }
                kwargs[key] = value
            }
        }
        const generatorCall = fmtCall('noise3d', { volumeSize: `x${consumerVolumeSize}` })
        const effectCall = fmtCall(funcName, kwargs)
        const renderSuffix = (funcName === 'render3d' || funcName === 'renderLit3d') ? '' : '\n  .render3d()'
        return ensureRenderDirective(
            `search synth3d, filter3d, render\n\n${generatorCall}\n  .${effectCall}${renderSuffix}\n  .write(o0)\n\nrender(o0)`
        )
    }

    const kwargs = bkw(effect.instance.globals)
    const effectCall = fmtCall(funcName, kwargs)
    return ensureRenderDirective(`${searchDirective}${noiseCall}\n  .${effectCall}\n  .write(o0)\n\nrender(o0)`)
}
