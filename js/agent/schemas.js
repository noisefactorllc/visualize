/**
 * Argument schemas for VisualizeAgent commands, and the validator that checks
 * them. Every schema is strict: an undeclared field fails with
 * INVALID_ARGS_UNKNOWN, so a command with no arguments accepts only {}.
 * `default` documents the value a handler uses when the field is omitted.
 *
 * Supported subset: object (properties, required, additionalProperties),
 * string (enum, minLength), number and integer (min, max), boolean.
 *
 * @module agent/schemas
 */

import { CROSSFADE_CURVES } from '../crossfader.js'
import { MIXERS } from '../mixers.js'

const strict = (properties, required = []) =>
    ({ type: 'object', properties, required, additionalProperties: false })

const NONE = strict({})
const DECK = { type: 'string', enum: ['A', 'B'], default: 'A' }
const TITLE = { type: 'string', minLength: 1 }

/** Auto-Mix sources, named as the source control lists them. */
export const AUTOMIX_SOURCES = [
    ...['sine', 'tri', 'saw', 'sawInv', 'square'].map(name => `osc:${name}`),
    ...['sub', 'low', 'mid', 'high'].map(band => `audio:${band}`),
    ...Array.from({ length: 16 }, (_, i) => `midi:${i + 1}`),
]

/** The values the Auto-VJ cycle control and the tempo divider offer. */
export const BAR_CHOICES = [1, 2, 4, 8, 16, 32]

export const RESOLUTIONS = ['640x360', '1280x720', '1920x1080', '2560x1440']

export const SCHEMAS = {
    getState: NONE,
    getProgram: strict({ deck: DECK }),
    validateProgram: strict({ dsl: { type: 'string', minLength: 1 } }, ['dsl']),
    setProgram: strict({ dsl: { type: 'string', minLength: 1 }, deck: DECK }, ['dsl']),
    searchEffects: strict({
        query: { type: 'string' },
        namespace: { type: 'string' },
        limit: { type: 'integer', min: 1, max: 500, default: 50 },
    }),
    getEffectDefinition: strict({ effectId: { type: 'string', minLength: 1 } }, ['effectId']),
    searchLibrary: strict({
        query: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'integer', min: 1, max: 500, default: 50 },
    }),
    getLibraryProgram: strict({ title: TITLE }, ['title']),
    loadProgram: strict({ title: TITLE, deck: DECK }, ['title']),
    randomize: strict({ deck: { type: 'string', enum: ['A', 'B', 'both'], default: 'A' } }),
    setAutoVjPool: strict({ title: TITLE, included: { type: 'boolean' } }, ['title', 'included']),
    setDeck: strict({
        deck: DECK,
        speed: { type: 'number', min: 0.1, max: 4 },
        density: { type: 'string', enum: ['auto', '100', '75', '50', '25'] },
        bandpass: { type: 'boolean' },
        oscillators: { type: 'integer', min: 0, max: 4 },
    }),
    rebind: strict({ deck: DECK, kind: { type: 'string', enum: ['eq', 'midi'] } }, ['kind']),
    setCrossfader: strict({
        position: { type: 'number', min: 0, max: 1 },
        curve: { type: 'string', enum: CROSSFADE_CURVES },
        fadeSeconds: { type: 'number', min: 0.1, max: 16 },
    }),
    crossfade: strict({ action: { type: 'string', enum: ['cutA', 'cutB', 'autoFade'] } }, ['action']),
    getMixer: NONE,
    setMixer: strict({
        effect: { type: 'string', enum: MIXERS.map(mixer => mixer.id) },
        params: { type: 'object' },
    }),
    setFx: strict({
        strobe: { type: 'boolean' },
        invert: { type: 'boolean' },
        bw: { type: 'boolean' },
        zoom: { type: 'boolean' },
        freeze: { type: 'boolean' },
        flash: { type: 'boolean' },
    }),
    setAutoVj: strict({
        enabled: { type: 'boolean' },
        bars: { type: 'integer', min: 1, max: 32, enum: BAR_CHOICES },
    }),
    setAutoMix: strict({
        enabled: { type: 'boolean' },
        source: { type: 'string', enum: AUTOMIX_SOURCES },
    }),
    setTempo: strict({
        bpm: { type: 'number', min: 40, max: 300 },
        divider: { type: 'integer', min: 1, max: 32, enum: BAR_CHOICES },
        tap: { type: 'boolean' },
        resetPhase: { type: 'boolean' },
        followMidiClock: { type: 'boolean' },
    }),
    setAudio: strict({ sensitivity: { type: 'number', min: 0.5, max: 4 } }),
    setOutput: strict({ resolution: { type: 'string', enum: RESOLUTIONS } }),
    setRenderer: strict({ preferWebGPU: { type: 'boolean' } }, ['preferWebGPU']),
    listScenes: NONE,
    scene: strict({
        action: { type: 'string', enum: ['save', 'recall', 'rename', 'delete'] },
        name: { type: 'string', minLength: 1 },
        newName: { type: 'string', minLength: 1 },
    }, ['action', 'name']),
    listUserEffects: NONE,
    getThumbnail: strict({
        maxDimension: { type: 'integer', min: 16, max: 1024, default: 256 },
        format: { type: 'string', enum: ['png', 'jpg'], default: 'jpg' },
        source: { type: 'string', enum: ['output', 'A', 'B'], default: 'output' },
    }),
    setAudioInput: strict({ enabled: { type: 'boolean' } }, ['enabled']),
    setMidiInput: strict({ enabled: { type: 'boolean' } }, ['enabled']),
    record: strict({ recording: { type: 'boolean' } }, ['recording']),
}

function fail(code, message, details) {
    return { ok: false, code, message, details }
}

function typeName(v) {
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
}

/**
 * Validate `value` against `schema`.
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string, details: object}}
 */
export function validate(value, schema, path = '') {
    if (!schema) return { ok: true }
    const field = path || 'args'
    switch (schema.type) {
        case 'object': {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                return fail('INVALID_ARGS_TYPE', `${field}: expected object, got ${typeName(value)}`,
                    { field, expected: 'object', got: typeName(value) })
            }
            for (const req of schema.required || []) {
                if (!(req in value)) {
                    const f = path ? `${path}.${req}` : req
                    return fail('INVALID_ARGS_REQUIRED', `${f} is required`, { field: f })
                }
            }
            for (const key of Object.keys(value)) {
                const f = path ? `${path}.${key}` : key
                const sub = schema.properties?.[key]
                if (!sub) {
                    if (schema.additionalProperties === false) {
                        return fail('INVALID_ARGS_UNKNOWN', `${f}: unknown field`, { field: f })
                    }
                    continue
                }
                const r = validate(value[key], sub, f)
                if (!r.ok) return r
            }
            return { ok: true }
        }
        case 'string':
            if (typeof value !== 'string') {
                return fail('INVALID_ARGS_TYPE', `${field}: expected string, got ${typeName(value)}`,
                    { field, expected: 'string', got: typeName(value) })
            }
            if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
                return fail('INVALID_ARGS_RANGE', `${field}: shorter than ${schema.minLength} characters`,
                    { field, min: schema.minLength, got: value.length })
            }
            if (schema.enum && !schema.enum.includes(value)) {
                return fail('INVALID_ARGS_ENUM', `${field}: expected one of [${schema.enum.join(', ')}]`,
                    { field, allowed: schema.enum, got: value })
            }
            return { ok: true }
        case 'number':
        case 'integer':
            if (typeof value !== 'number' || !Number.isFinite(value)
                || (schema.type === 'integer' && !Number.isInteger(value))) {
                return fail('INVALID_ARGS_TYPE', `${field}: expected ${schema.type}, got ${typeName(value)}`,
                    { field, expected: schema.type, got: typeName(value) })
            }
            if ((typeof schema.min === 'number' && value < schema.min)
                || (typeof schema.max === 'number' && value > schema.max)) {
                return fail('INVALID_ARGS_RANGE', `${field}: ${value} is outside ${schema.min} to ${schema.max}`,
                    { field, min: schema.min, max: schema.max, got: value })
            }
            return { ok: true }
        case 'boolean':
            if (typeof value !== 'boolean') {
                return fail('INVALID_ARGS_TYPE', `${field}: expected boolean, got ${typeName(value)}`,
                    { field, expected: 'boolean', got: typeName(value) })
            }
            return { ok: true }
        default:
            return { ok: true }
    }
}
