/**
 * State snapshot attached to every VisualizeAgent envelope. It stays small:
 * program text comes from getProgram, images from getThumbnail. A Seance
 * session reads it too, so it holds only live state, nothing that the
 * browser stores for the person (scenes, user effects).
 *
 * @module agent/snapshot
 */

import { AUTOMIX_SOURCES } from './schemas.js'

/** Snapshot schema version. Bump for renamed or removed fields. */
export const SCHEMA_VERSION = '1.0'

const OSC_NAMES = ['sine', 'tri', 'saw', 'sawInv', 'square']

/** Name an Auto-Mix source the way the agent API does ('osc:sine', 'midi:1'). */
export function autoMixSourceName(source) {
    if (source?.kind === 'osc') return `osc:${OSC_NAMES[source.oscType] ?? source.oscType}`
    if (source?.kind === 'audio') return `audio:${source.band}`
    if (source?.kind === 'midi') return `midi:${source.channel + 1}`
    return null
}

/** The app's Auto-Mix source key ('osc:0', 'midi:0') for an agent source name. */
export function autoMixSourceKey(name) {
    if (!AUTOMIX_SOURCES.includes(name)) return null
    const [kind, value] = name.split(':')
    if (kind === 'osc') return `osc:${OSC_NAMES.indexOf(value)}`
    if (kind === 'midi') return `midi:${Number(value) - 1}`
    return name
}

const round = (value, places = 3) => Number.isFinite(value) ? Number(value.toFixed(places)) : value

export function deckSnapshot(ctx, id) {
    const deck = ctx.decks[id]
    const text = ctx.programText(id) || ''
    const density = ctx.state.deckDensity[id]
    return {
        title: deck.currentName || '',
        chars: text.length,
        running: Boolean(deck.currentDsl) && deck.currentDsl === text,
        speed: round(deck.speed),
        density: { mode: density.mode, value: density.value },
        bandpass: deck.rebind.bandpass !== false,
        oscillators: deck.rebind.oscillatorCount || 0,
    }
}

export function crossfaderSnapshot({ state }) {
    return {
        position: round(state.crossfade),
        curve: state.curve,
        fadeSeconds: state.fadeDurSec,
        live: state.crossfade < 0.5 ? 'A' : 'B',
    }
}

export function fxSnapshot({ compositor }) {
    return {
        strobe: compositor.strobe,
        invert: compositor.invert,
        bw: compositor.bw,
        zoom: compositor.zoom,
        freeze: compositor.freeze,
    }
}

export function buildSnapshot(ctx) {
    const { state, decks, mixer, autoMix, autoXfade, scheduler, audio, midi, recorder } = ctx
    return {
        schemaVersion: SCHEMA_VERSION,
        decks: { A: deckSnapshot(ctx, 'A'), B: deckSnapshot(ctx, 'B') },
        crossfader: crossfaderSnapshot(ctx),
        mixer: { effect: ctx.mixerControls() ? mixer.currentMixer.id : null },
        fx: fxSnapshot(ctx),
        autoVj: { enabled: autoMix.enabled, bars: autoMix.barsPerScene },
        autoMix: { enabled: autoXfade.enabled, source: autoMixSourceName(autoXfade.source) },
        tempo: { bpm: round(scheduler.bpm, 2), divider: scheduler.divider, followMidiClock: midi.followClock },
        audio: { enabled: audio.enabled, sensitivity: audio.sensitivity },
        midi: { enabled: midi.enabled, inputs: midi.inputCount },
        output: { width: state.mainRes.width, height: state.mainRes.height, backend: decks.A.activeBackend },
        recording: recorder.isRecording,
        online: ctx.online()?.getStatus?.() || 'offline',
    }
}
