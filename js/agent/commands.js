/**
 * VisualizeAgent command handlers. Each handler receives (args, ctx) and
 * returns { result, image?, warnings? }; the dispatcher builds the envelope.
 *
 * ctx comes from app.js: the decks, library, scenes, mixer and other app
 * objects, plus functions that run the same code as the controls (load a
 * program, move the crossfader, save a scene...). Handlers use those, so the
 * labels, editors, online session, stored settings and toasts follow an
 * agent's change exactly as they follow a person's.
 *
 * `via.remote` marks a request from a Seance session. Everyone in the session
 * reads its answer, so such a request never reaches what this browser stores
 * for the person (installed user effects, the library programs made from
 * them, scene images), nor what Visualize keeps out of the session: a deck's
 * unpublished draft, live camera or video input, and images the session does
 * not hold.
 *
 * @module agent/commands
 */

import { commandError } from './dispatcher.js'
import { buildSnapshot, crossfaderSnapshot, deckSnapshot, fxSnapshot, autoMixSourceKey, autoMixSourceName } from './snapshot.js'
import { BAR_CHOICES } from './schemas.js'
import { compile as compileDsl, extractEffectNamesFromDsl, getAllEffects, getEffect, stdEnums } from '../noisemaker/bundle.js'
import { curatedRuntimeDsl } from '../noisemaker/curatedEffects.js'
import { MIXERS, getMixer as mixerById } from '../mixers.js'
import { fileInlineImages } from '../sharingLoader.js'
import { MAX_SCENES } from '../scenes.js'

const IMAGE_URL = /^image:[a-f0-9]{64}$/
const IMAGE_REF = /image:([a-f0-9]{64})/g

const isError = d => d.severity === 'error'

// Resolves on the next animation frame. A hidden tab runs no frames, so a
// short timer bounds the wait.
function nextFrame() {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, 250)
        requestAnimationFrame(() => {
            clearTimeout(timer)
            resolve()
        })
    })
}

async function frames(count) {
    for (let i = 0; i < count; i++) await nextFrame()
}

export async function getState(_args, ctx) {
    return { result: buildSnapshot(ctx) }
}

export async function getProgram({ deck = 'A' }, ctx, via = {}) {
    // A session reads the deck's program as the session holds it.
    const text = (via.remote ? ctx.sessionText(deck) : ctx.programText(deck)) || ''
    const current = ctx.decks[deck].currentDsl
    // A curated library program reads as the deck editor shows it: in the
    // `curated` namespace that Visualize runs it from.
    let dsl = curatedRuntimeDsl(text)
    // A program typed with an inline image keeps the image as text. Name it
    // by its id instead, so no image travels as text.
    if (/\burl\b/.test(dsl) && dsl.includes('data:')) {
        const filed = await fileInlineImages(dsl, await ctx.imageTools(), { skipInvalid: true })
        for (const image of filed.images) {
            if (!ctx.decks[deck].images.some(asset => asset.id === image.id)) ctx.decks[deck].images.push(image)
        }
        dsl = filed.dsl
    }
    return { result: { dsl, running: Boolean(current) && current === text } }
}

// A program that names the `user` namespace: in its search line, or as
// `user.effect()` or `from(user, ...)`.
const USER_NAMESPACE = /^\s*search\b[^\n]*\buser\b|\buser\s*\.\s*\w+\s*\(|\bfrom\s*\(\s*user\b/m

// The engine sees a program the way a deck compiles it: a curated library
// program runs its curated form, and media() loses its `url` argument,
// which the deck binds as an image itself. A session request cannot use the
// user effects installed in the person's browser, nor learn which exist.
async function engineProgram(dsl, ctx, via) {
    const runtime = curatedRuntimeDsl(dsl)
    if (via.remote && USER_NAMESPACE.test(runtime)) {
        return {
            text: runtime,
            stop: true,
            diagnostics: [{ code: 'USER_EFFECT', severity: 'error', message: 'A session cannot run the user effects installed in the person\'s browser. Use the curated namespace or built-in effects.' }],
        }
    }
    if (!/\burl\b/.test(runtime)) return { text: runtime, diagnostics: [] }
    const tools = await ctx.imageTools()
    let sources
    try {
        sources = tools.getMediaSources(runtime)
    } catch (err) {
        return { text: runtime, diagnostics: [{ code: 'MEDIA_URL', severity: 'error', message: err?.message || String(err) }] }
    }
    const diagnostics = sources
        .filter(source => source.url && !IMAGE_URL.test(source.url))
        .map(source => ({
            code: 'MEDIA_URL',
            severity: 'error',
            message: `media() image ${source.mediaIndex + 1} must be named image:<sha256>, not ${source.url.slice(0, 40)}`,
        }))
    return { text: tools.stripMediaUrls(runtime), diagnostics }
}

async function loadProgramEffects(text, { decks }) {
    const renderer = decks.A.inner
    let ids
    try {
        ids = extractEffectNamesFromDsl(text, renderer.manifest || {}).map(effect => effect.effectId)
    } catch {
        return
    }
    if (!ids.length) return
    try {
        await renderer.loadEffects(ids)
    } catch (err) {
        throw commandError('EFFECT_LOAD_FAILED', `Could not load effects: ${err?.message || err}`, { effectIds: ids })
    }
}

function compileDiagnostics(text) {
    try {
        const compiled = compileDsl(text)
        return (compiled?.diagnostics || []).map(d => ({
            code: d.code,
            severity: d.severity,
            message: d.message,
            ...(d.location ? { location: d.location } : {}),
        }))
    } catch (err) {
        // The parser throws on syntax errors: "Expected ... at line N col M".
        const at = /line (\d+) col (\d+)/.exec(err?.message || '')
        return [{
            code: 'SYNTAX',
            severity: 'error',
            message: err?.message || String(err),
            ...(at ? { location: { line: Number(at[1]), column: Number(at[2]) } } : {}),
        }]
    }
}

async function diagnose(dsl, ctx, via) {
    const program = await engineProgram(dsl, ctx, via)
    if (program.stop) return program.diagnostics
    await loadProgramEffects(program.text, ctx)
    return [...program.diagnostics, ...compileDiagnostics(program.text)]
}

export async function validateProgram({ dsl }, ctx, via = {}) {
    const diagnostics = await diagnose(dsl, ctx, via)
    return { result: { valid: !diagnostics.some(isError), diagnostics } }
}

// Every image the program names must be ready before the deck loads it: the
// deck binds images after it installs the program. A session request uses
// only images the session already holds, so the tab never uploads an image
// that this browser keeps for the person.
async function ensureImages(dsl, deckId, ctx, via) {
    const deck = ctx.decks[deckId]
    const other = ctx.decks[deckId === 'A' ? 'B' : 'A']
    for (const id of new Set([...dsl.matchAll(IMAGE_REF)].map(match => match[1]))) {
        if (via.remote) {
            try {
                if (!deck.resolveImage) throw new Error('Visualize is not online')
                await deck.resolveImage(id)
            } catch (err) {
                throw commandError('NOT_FOUND_IMAGE',
                    `Image ${id} is not in the online session. Add it with image-put first. ${err?.message || ''}`.trim(), { id })
            }
            continue
        }
        if (deck.images.some(image => image.id === id)) continue
        const shared = other.images.find(image => image.id === id)
        if (shared) {
            deck.images.push(shared)
            continue
        }
        try {
            const stored = await deck.storedImage?.(id)
            if (stored) {
                const image = await (await ctx.imageTools()).prepareImageFile(stored)
                if (image.id === id) {
                    deck.images.push(image)
                    continue
                }
            }
        } catch { /* not in this browser's scene images */ }
        try {
            if (!deck.resolveImage) throw new Error('Visualize is not online')
            await deck.resolveImage(id)
        } catch (err) {
            throw commandError('NOT_FOUND_IMAGE',
                `Image ${id} is not in deck ${deckId}, in this browser or in the online session. Add it to the session first. ${err?.message || ''}`.trim(),
                { id })
        }
    }
}

async function runProgram(deckId, program, ctx) {
    const deck = ctx.decks[deckId]
    const before = { dsl: deck.currentDsl, title: deck.currentName }
    const res = await ctx.loadProgram(deckId, program)
    if (res?.superseded) {
        throw commandError('CONFLICT_SUPERSEDED',
            `A newer program load on deck ${deckId} replaced this one before it ran.`, { deck: deckId })
    }
    if (!res?.success) {
        // A deck that installed the program and then failed to bind its
        // image would keep the new program; put the previous one back.
        if (before.dsl && deck.currentDsl !== before.dsl) await ctx.loadProgram(deckId, before)
        throw commandError('COMPILE_FAILED',
            `The renderer rejected the program. Deck ${deckId} still runs its previous program. ${res?.error || ''}`.trim(),
            { deck: deckId })
    }
    await frames(2)
}

export async function setProgram({ dsl, deck = 'A' }, ctx, via = {}) {
    const diagnostics = await diagnose(dsl, ctx, via)
    if (diagnostics.some(isError)) {
        throw commandError('INVALID_PROGRAM', 'The program does not compile. Nothing changed.', { diagnostics })
    }
    await ensureImages(dsl, deck, ctx, via)
    await runProgram(deck, { title: '(custom)', dsl }, ctx)
    return { result: { applied: true, diagnostics } }
}

const isUserEffect = effectId => effectId.startsWith('user/')

function registryEffects(via) {
    const out = []
    for (const [key, instance] of getAllEffects() || []) {
        if (typeof key !== 'string' || !/^(user|curated)\//.test(key)) continue
        if (via.remote && isUserEffect(key)) continue
        out.push([key, { description: instance?.description || '', tags: instance?.tags || [] }])
    }
    return out
}

export async function searchEffects({ query = '', namespace, limit = 50 }, { decks }, via = {}) {
    const q = query.toLowerCase()
    const manifest = decks.A.inner.manifest || {}
    const entries = [...Object.entries(manifest), ...registryEffects(via).filter(([id]) => !manifest[id])]
    const matches = entries
        .map(([effectId, entry]) => {
            const [ns, name] = effectId.split('/')
            return { effectId, namespace: ns, name, description: entry.description || '', tags: entry.tags || [] }
        })
        .filter(e => (!namespace || e.namespace === namespace)
            && (!q || `${e.effectId} ${e.description} ${e.tags.join(' ')}`.toLowerCase().includes(q)))
    return { result: { total: matches.length, effects: matches.slice(0, limit) } }
}

function enumChoices(spec, enums) {
    if (spec.choices) return { choices: spec.choices }
    const path = spec.enum || spec.enumPath
        || (spec.type === 'member' && typeof spec.default === 'string'
            ? spec.default.split('.').slice(0, -1).join('.') : '')
    if (!path) return {}
    const node = path.split('.').reduce((value, key) => value?.[key], enums)
    if (!node || typeof node !== 'object') return {}
    return { enum: path, choices: Object.fromEntries(Object.entries(node).map(([key, value]) =>
        [key, spec.type === 'member' ? `${path}.${key}` : value?.value ?? value])) }
}

export async function getEffectDefinition({ effectId }, { decks }, via = {}) {
    const renderer = decks.A.inner
    if (via.remote && isUserEffect(effectId)) {
        throw commandError('NOT_FOUND_EFFECT',
            `${effectId} is installed in the person's browser; a session cannot read user effects.`, { effectId })
    }
    const inManifest = Boolean(renderer.manifest?.[effectId])
    if (inManifest) {
        try {
            await renderer.loadEffects([effectId])
        } catch (err) {
            throw commandError('EFFECT_LOAD_FAILED', `Could not load ${effectId}: ${err?.message || err}`, { effectId })
        }
    }
    const [namespace, name] = effectId.split('/')
    const def = (inManifest || /^(user|curated)\//.test(effectId))
        ? getEffect(effectId) || getEffect(`${namespace}.${name}`)
        : null
    if (!def || !name) throw commandError('NOT_FOUND_EFFECT', `Unknown effect: ${effectId}`, { effectId })
    const params = Object.entries(def.globals || {})
        .filter(([, spec]) => spec && !spec.internal && !spec.ui?.hidden)
        .map(([param, spec]) => ({
            name: param,
            type: spec.type,
            default: spec.default ?? null,
            ...(spec.min !== undefined ? { min: spec.min } : {}),
            ...(spec.max !== undefined ? { max: spec.max } : {}),
            ...enumChoices(spec, renderer.enums || stdEnums),
            ...(spec.ui?.label ? { label: spec.ui.label } : {}),
        }))
    return {
        result: {
            effectId,
            func: def.func || name,
            namespace,
            description: def.description || renderer.manifest?.[effectId]?.description || '',
            params,
        },
    }
}

// The library's `user` section is made from the user effects installed in
// this browser, and the Auto-VJ choices are the person's stored settings.
const isUserProgram = program => program?.source?.kind === 'engine-default'

function programSummary(program, library, via) {
    return {
        title: program.title,
        tagline: program.tagline || '',
        category: library.constructor.categoryFor(program),
        tags: program.tags || [],
        ...(via.remote ? {} : { autoVj: library.isIncluded(program.title) }),
    }
}

function libraryProgram(title, library, via) {
    const program = library.byTitle(title)
    if (!program || (via.remote && isUserProgram(program))) {
        throw commandError('NOT_FOUND_PROGRAM', `No library program is titled "${title}".`, { title })
    }
    return program
}

export async function searchLibrary({ query = '', category, limit = 50 }, { library }, via = {}) {
    const q = query.toLowerCase()
    const matches = library.programs.filter(p => {
        if (via.remote && isUserProgram(p)) return false
        if (category && library.constructor.categoryFor(p) !== category) return false
        if (!q) return true
        const source = p.source?.username ? `${p.source.username} ${p.source.app || ''}` : ''
        return `${p.title} ${p.tagline || ''} ${(p.tags || []).join(' ')} ${source}`.toLowerCase().includes(q)
    })
    return { result: { total: matches.length, programs: matches.slice(0, limit).map(p => programSummary(p, library, via)) } }
}

export async function getLibraryProgram({ title }, { library }, via = {}) {
    const program = libraryProgram(title, library, via)
    return { result: { ...programSummary(program, library, via), dsl: curatedRuntimeDsl(program.dsl) } }
}

export async function loadProgram({ title, deck = 'A' }, ctx, via = {}) {
    const program = libraryProgram(title, ctx.library, via)
    await runProgram(deck, program, ctx)
    return { result: { deck, title: program.title } }
}

// Like Library.randomExcept: a random Auto-VJ pool program whose title is not
// in `exclude`, or any pool program when every one is excluded.
function randomPoolProgram(library, exclude, via) {
    const pool = library.programs.filter(p => library.isIncluded(p.title) && !(via.remote && isUserProgram(p)))
    const eligible = pool.filter(p => !exclude.includes(p.title))
    const from = eligible.length ? eligible : pool
    return from.length ? from[Math.floor(Math.random() * from.length)] : null
}

export async function randomize({ deck = 'A' }, ctx, via = {}) {
    const { library, decks } = ctx
    let picks
    if (deck === 'both') {
        const a = randomPoolProgram(library, [], via)
        picks = { A: a, B: randomPoolProgram(library, [a?.title], via) }
    } else {
        picks = { [deck]: randomPoolProgram(library, [decks[deck].currentName], via) }
    }
    if (Object.values(picks).some(program => !program)) {
        throw commandError('NOT_FOUND_PROGRAM', 'The Auto-VJ pool is empty. Include programs with setAutoVjPool.', {})
    }
    await Promise.all(Object.entries(picks).map(([id, program]) => runProgram(id, program, ctx)))
    return { result: { programs: Object.fromEntries(Object.entries(picks).map(([id, program]) => [id, program.title])) } }
}

export async function setAutoVjPool({ title, included }, ctx) {
    const program = libraryProgram(title, ctx.library, {})
    ctx.setProgramIncluded(program.title, included)
    const now = ctx.library.isIncluded(program.title)
    const warnings = included && !now ? ['Utility programs are never in the Auto-VJ pool.'] : []
    return { result: { title: program.title, included: now }, warnings }
}

function deckControls(ctx, deck) {
    const { speed, density, bandpass, oscillators } = deckSnapshot(ctx, deck)
    return { deck, speed, density, bandpass, oscillators }
}

export async function setDeck({ deck = 'A', speed, density, bandpass, oscillators }, ctx) {
    if (speed !== undefined) ctx.setDeckSpeed(deck, speed)
    if (density !== undefined) {
        ctx.setDeckDensity(deck, density === 'auto'
            ? { mode: 'auto', value: 1.0 }
            : { mode: 'manual', value: Number(density) / 100 })
    }
    if (bandpass !== undefined || oscillators !== undefined) {
        ctx.setRebindOptions(deck, { bandpass, oscillatorCount: oscillators })
    }
    return { result: deckControls(ctx, deck) }
}

export async function rebind({ deck = 'A', kind }, ctx) {
    const applied = await ctx.rebindDeck(deck, kind)
    if (applied) await frames(2)
    return { result: { deck, kind, applied: Boolean(applied) } }
}

export async function setCrossfader({ position, curve, fadeSeconds }, ctx) {
    if (curve !== undefined) ctx.setCrossfadeCurve(curve)
    if (fadeSeconds !== undefined) ctx.setFadeSeconds(fadeSeconds)
    if (position !== undefined) ctx.moveCrossfader(position)
    return { result: crossfaderSnapshot(ctx) }
}

export async function crossfade({ action }, ctx) {
    if (action === 'autoFade') {
        const { target, seconds } = ctx.autoFade()
        return { result: { action, target, seconds } }
    }
    const target = action === 'cutA' ? 0 : 1
    ctx.moveCrossfader(target)
    return { result: { action, target, seconds: 0 } }
}

async function readyMixer(ctx) {
    await ctx.mixerStartup
    if (!ctx.mixerControls()) {
        throw commandError('CONFLICT_MIXER_UNAVAILABLE',
            'The mixer did not start. The decks crossfade without a mixer effect.', {})
    }
    return ctx.mixer
}

// The parameters that the mixer controls panel shows for an effect.
function mixerSpecs(effectId) {
    const driver = mixerById(effectId).driver
    return new Map(Object.entries(getEffect(effectId)?.globals || {}).filter(([name, spec]) =>
        spec && name !== driver && !['surface', 'volume', 'geometry'].includes(spec.type)
        && ((spec.choices && typeof spec.choices === 'object') || spec.type === 'float' || spec.type === 'int')))
}

const choiceNames = spec => Object.keys(spec.choices).filter(key => !key.endsWith(':'))

function choiceName(spec, value) {
    if (value == null || choiceNames(spec).includes(value)) return value ?? null
    return choiceNames(spec).find(key => String(spec.choices[key]) === String(value)) ?? value
}

function mixerResult(mixer) {
    const current = mixer.currentMixer
    const params = [...mixerSpecs(current.id)].map(([name, spec]) => {
        const value = mixer.getOverride(name) ?? spec.default ?? null
        if (spec.choices) {
            return { name, type: 'choice', value: choiceName(spec, value), default: choiceName(spec, spec.default), choices: choiceNames(spec) }
        }
        return {
            name, type: spec.type, value, default: spec.default ?? null,
            ...(spec.min !== undefined ? { min: spec.min } : {}),
            ...(spec.max !== undefined ? { max: spec.max } : {}),
        }
    })
    return {
        effect: current.id,
        driver: current.driver,
        effects: MIXERS.map(m => ({ effect: m.id, label: m.label, driver: m.driver })),
        params,
    }
}

export async function getMixer(_args, ctx) {
    return { result: mixerResult(await readyMixer(ctx)) }
}

function checkMixerParams(effectId, params) {
    const specs = mixerSpecs(effectId)
    for (const [name, value] of Object.entries(params)) {
        const field = `params.${name}`
        const spec = specs.get(name)
        if (!spec) {
            throw commandError('INVALID_ARGS_UNKNOWN', `${field}: ${effectId} has no parameter ${name} that you can set`, { field })
        }
        if (spec.choices) {
            const allowed = choiceNames(spec)
            if (!allowed.includes(value)) {
                throw commandError('INVALID_ARGS_ENUM', `${field}: expected one of [${allowed.join(', ')}]`, { field, allowed, got: value })
            }
            continue
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'int' && !Number.isInteger(value))) {
            throw commandError('INVALID_ARGS_TYPE', `${field}: expected ${spec.type === 'int' ? 'integer' : 'number'}`, { field, expected: spec.type })
        }
        if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
            throw commandError('INVALID_ARGS_RANGE', `${field}: ${value} is outside ${spec.min} to ${spec.max}`,
                { field, min: spec.min, max: spec.max, got: value })
        }
    }
}

export async function setMixer({ effect, params = {} }, ctx) {
    const mixer = await readyMixer(ctx)
    const target = effect || mixer.currentMixer.id
    if (target !== mixer.currentMixer.id) {
        try {
            await mixer.renderer.loadEffects([target])
        } catch (err) {
            throw commandError('EFFECT_LOAD_FAILED', `Could not load ${target}: ${err?.message || err}`, { effectId: target })
        }
    }
    checkMixerParams(target, params)
    if (target !== mixer.currentMixer.id) await ctx.selectMixerEffect(target)
    for (const [name, value] of Object.entries(params)) ctx.setMixerParam(name, value)
    return { result: mixerResult(mixer) }
}

export async function setFx(args, ctx) {
    for (const name of ['strobe', 'invert', 'bw', 'zoom', 'freeze']) {
        if (args[name] !== undefined) ctx.toggleFx(name, null, args[name])
    }
    if (args.flash) ctx.toggleFx('flash')
    return { result: fxSnapshot(ctx) }
}

function checkBars(field, value) {
    if (!BAR_CHOICES.includes(value)) {
        throw commandError('INVALID_ARGS_ENUM', `${field}: expected one of [${BAR_CHOICES.join(', ')}]`,
            { field, allowed: BAR_CHOICES, got: value })
    }
}

export async function setAutoVj({ enabled, bars }, ctx) {
    if (bars !== undefined) checkBars('bars', bars)
    if (bars !== undefined) ctx.setAutoVjBars(bars)
    if (enabled !== undefined) ctx.setAutoVj(enabled)
    return { result: { enabled: ctx.autoMix.enabled, bars: ctx.autoMix.barsPerScene } }
}

export async function setAutoMix({ enabled, source }, ctx) {
    if (source !== undefined) ctx.setAutoMixSource(autoMixSourceKey(source))
    if (enabled !== undefined) ctx.setAutoMixEnabled(enabled)
    return { result: { enabled: ctx.autoXfade.enabled, source: autoMixSourceName(ctx.autoXfade.source) } }
}

export async function setTempo({ bpm, divider, tap, resetPhase, followMidiClock }, ctx) {
    if (divider !== undefined) checkBars('divider', divider)
    if (followMidiClock !== undefined) ctx.setFollowMidiClock(followMidiClock)
    if (bpm !== undefined) ctx.setBpm(bpm)
    if (divider !== undefined) ctx.setDivider(divider)
    if (resetPhase) ctx.resetTempoPhase()
    if (tap) ctx.tapTempo()
    const { scheduler, midi } = ctx
    return { result: { bpm: Number(scheduler.bpm.toFixed(2)), divider: scheduler.divider, followMidiClock: midi.followClock } }
}

export async function setAudio({ sensitivity }, { audio }) {
    if (sensitivity !== undefined) audio.setSensitivity(sensitivity)
    return { result: { enabled: audio.enabled, sensitivity: audio.sensitivity } }
}

export async function setOutput({ resolution }, ctx) {
    if (resolution !== undefined) {
        const [width, height] = resolution.split('x').map(Number)
        ctx.setMainResolution(width, height)
    }
    const { width, height } = ctx.state.mainRes
    return { result: { width, height, backend: ctx.decks.A.activeBackend } }
}

export async function setRenderer({ preferWebGPU }, ctx) {
    ctx.setPreferWebGPU(preferWebGPU)
    return { result: { preferWebGPU: ctx.state.preferWebGPU === true, backend: ctx.decks.A.activeBackend } }
}

export async function listScenes(_args, { scenes }) {
    const list = scenes.scenes
    return {
        result: {
            total: list.length,
            max: MAX_SCENES,
            scenes: list.map((scene, i) => ({
                slot: i + 1,
                name: scene.name,
                bpm: Math.round(scene.bpm || 0),
                fx: Object.entries(scene.fx || {}).filter(([, on]) => on).map(([name]) => name),
                decks: { A: scene.decks?.A?.title || '', B: scene.decks?.B?.title || '' },
            })),
        },
    }
}

function sceneByName(name, scenes) {
    const scene = scenes.byName(name)
    if (!scene) throw commandError('NOT_FOUND_SCENE', `No scene is named "${name}".`, { name })
    return scene
}

export async function scene({ action, name, newName }, ctx) {
    const { scenes } = ctx
    if (action === 'save') {
        if (!name.trim()) throw commandError('INVALID_ARGS_RANGE', 'name: empty after trimming spaces', { field: 'name' })
        const saved = await ctx.saveScene(name)
        if (saved.ok) return { result: { action, name: saved.name } }
        if (saved.error === 'full') {
            throw commandError('CONFLICT_SCENES_FULL', 'The scene list is full. Delete or rename a scene first.', { max: MAX_SCENES })
        }
        if (saved.error === 'storage') {
            throw commandError('CONFLICT_STORAGE_FULL', 'Browser storage is full or unavailable. The scene was not saved.', {})
        }
        throw commandError('INTERNAL_ERROR', `Could not save scene: ${saved.message}`, {})
    }
    const found = sceneByName(name, scenes)
    if (action === 'recall') {
        const errors = await ctx.recallScene(found)
        await frames(2)
        return { result: { action, name: found.name }, warnings: errors || [] }
    }
    if (action === 'delete') {
        ctx.deleteScene(found.name)
        return { result: { action, name: found.name } }
    }
    if (newName === undefined) throw commandError('INVALID_ARGS_REQUIRED', 'newName is required to rename a scene', { field: 'newName' })
    const previous = found.name
    const renamed = ctx.renameScene(previous, newName)
    if (renamed.ok) return { result: { action, name: previous, newName: renamed.name } }
    if (renamed.error === 'duplicate') {
        throw commandError('CONFLICT_SCENE_EXISTS', renamed.message, { name: newName })
    }
    throw commandError('INVALID_ARGS_RANGE', `newName: ${renamed.message}`, { field: 'newName' })
}

export async function listUserEffects(_args, { userEffects }) {
    const installed = await userEffects.listInstalled()
    return {
        result: {
            total: installed.length,
            effects: installed.map(effect => ({
                effectId: effect.id,
                name: effect.name,
                installedAt: effect.uploadedAt ? new Date(effect.uploadedAt).toISOString() : null,
            })),
        },
    }
}

export async function getThumbnail({ maxDimension = 256, format = 'jpg', source = 'output' }, ctx, via = {}) {
    // Live camera or video input stays in the person's browser. The output
    // shows both decks.
    if (via.remote && (source === 'output' ? ['A', 'B'] : [source]).some(deck => ctx.hasLiveMedia(deck))) {
        throw commandError('REMOTE_UNAVAILABLE',
            'A deck shows live camera or video input, which stays in the person\'s browser. Its image is not available through a session.',
            { source })
    }
    // Give a program that just loaded its first frames on the deck, the
    // mixer and the output canvas. Capture only reads the canvas.
    await frames(source === 'output' ? 3 : 2)
    const canvas = source === 'output' ? ctx.mainCanvas : ctx.decks[source].canvas
    const scale = Math.min(1, maxDimension / Math.max(canvas.width, canvas.height, 1))
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(canvas.width * scale))
    out.height = Math.max(1, Math.round(canvas.height * scale))
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height)
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'
    const image = await new Promise((resolve, reject) => {
        out.toBlob(blob => blob ? resolve(blob) : reject(new Error('The canvas could not be encoded')), mimeType, 0.85)
    })
    return { result: { mimeType, width: out.width, height: out.height, source }, image }
}

export async function setAudioInput({ enabled }, ctx) {
    return { result: { enabled: await ctx.setAudioInput(enabled) } }
}

export async function setMidiInput({ enabled }, ctx) {
    await ctx.setMidiInput(enabled)
    return { result: { enabled: ctx.midi.enabled, inputs: ctx.midi.inputCount } }
}

export async function record({ recording }, ctx) {
    return { result: { recording: ctx.setRecording(recording) } }
}
