/**
 * ESM bundle loader for the Noisemaker shaders core.
 *
 * Dynamically imports from the shaders CDN — minified in production,
 * non-minified for local dev so stack traces stay readable.
 */

const SHADER_CDN = (typeof window !== 'undefined' && window.electronAPI?.isElectron)
    ? 'app://visualize/vendor/noisemaker/0.8.0'
    : 'https://shaders.noisedeck.app/1'

const isLocalDev = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
)

const bundlePath = isLocalDev
    ? `${SHADER_CDN}/noisemaker-shaders-core.esm.js`
    : `${SHADER_CDN}/noisemaker-shaders-core.esm.min.js`

const bundle = await import(bundlePath)

export const CDN_BASE = SHADER_CDN

export const {
    CanvasRenderer,
    Effect,
    registerEffect,
    unregisterEffect,
    getEffect,
    getAllEffects,
    registerOp,
    registerStarterOps,
    mergeIntoEnums,
    stdEnums,
    compile,
    lex,
    parse,
    unparse,
    extractEffectNamesFromDsl,
    extractEffectsFromDsl,
    AudioInputManager,
    MidiInputManager,
    ExternalInputManager,
    UIController,
    ProgramState,
    setToastProvider,
    formatValue,
    formatDslError,
    isStarterEffect,
    isIOFunction,
    hasTexSurfaceParam,
    hasExplicitTexParam,
    getVolGeoParams,
    is3dGenerator,
    is3dProcessor,
    unparseCall,
    VERSION
} = bundle

export const _bundle = bundle
