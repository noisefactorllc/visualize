# Oscillators + Auto-Mix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) per-deck oscillator count (0–4) that swaps audio/midi bindings for `osc()` bindings during rebind; (2) a new global Auto-Mix that drives the crossfader from a chosen source (oscillator / audio band / midi channel), mutually exclusive with Auto-VJ.

**Architecture:** Reuse the existing rebind module's resolved-form override pipeline for the new oscillator nodes. Add an `AutoXfade` class with a per-frame `tick()` that reads from the existing audio/MIDI/scheduler singletons and writes to `state.crossfade` via a callback. Mutual exclusion between auto-VJ and auto-mix happens via simple `onEnableChange` subscriptions wired in `app.js` — no shared global state.

**Tech Stack:** Vanilla ES modules, Noisemaker shader bundle (CDN), Playwright for tests.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `js/rebind.js` (MODIFY) | Add `OSC_TYPES`, `OSC_SPEEDS`, `oscNode()`. `buildAudioOverrides` and `buildMidiOverrides` take new `oscillatorCount` and emit oscillator nodes for the first `min(count, picked.length)` chosen params. `rebindEq`/`rebindMidi` read `deck.rebind.oscillatorCount`. |
| `js/noisemaker/deck.js` (MODIFY) | Add `oscillatorCount: 0` default to the per-deck `rebind` state. |
| `js/audio.js` (MODIFY) | Add `sub` band (`fft[0] / 255 * sens`) to `this.meters` AND write it into each deck's `audioState`. |
| `js/midi.js` (MODIFY) | Track `_lastCcByChannel` (Map). Expose `lastCcOnChannel(ch)` getter + `onLastCcChange(cb)` subscription. CC dispatch writes to both. |
| `js/autoxfade.js` (NEW) | `AutoXfade` class: `setEnabled`, `setSource`, `tick`, `snapshot`/`restore`, `onEnableChange`. |
| `js/app.js` (MODIFY) | OSC count button per deck; construct AutoXfade; mutual-exclusion wiring; auto-mix source dropdown; persist auto-mix + oscCount to localStorage; thread snapshot/apply through Scenes. |
| `js/scenes.js` (MODIFY) | Round-trip `autoXfade` config. |
| `index.html` (MODIFY) | OSC count button + new `.deck-head-row2` per deck (zoom moved into it); auto-mix UI strip in the status bar to the left of `#automix-toggle`. |
| `css/app.css` (MODIFY) | `.deck-head-row2` style; `.deck-osc-count` (same flavour as `.deck-density`); `.status-automixer` styling. |
| `tests/rebind.spec.js` (MODIFY) | Add a case: `oscillatorCount = 4` → rebound DSL contains `osc(` and no `audio(` overrides. |
| `tests/autoxfade.spec.js` (NEW) | AutoXfade construction, source switching, mutual exclusion with Auto-VJ. |

---

## Task 1: Add `sub` audio band to the analyzer

**Files:**
- Modify: `js/audio.js` (around line 196, the FFT band reduction in `_loop`)

- [ ] **Step 1: Add sub measurement + write into audioStates**

In `_loop()` find:

```javascript
        const sens = this._sensitivity
        const low  = Math.min(1, ((fft[0] + fft[1] + fft[2] + fft[3]) / 4 / 255) * sens)
        const mid  = Math.min(1, ((fft[4] + fft[6] + fft[8] + fft[10]) / 4 / 255) * sens)
        const high = Math.min(1, ((fft[16] + fft[20] + fft[24] + fft[28]) / 4 / 255) * sens)
        const vol  = (low + mid + high) / 3

        this.meters.low = low
        this.meters.mid = mid
        this.meters.high = high
        this.meters.vol = vol

        for (const state of this._audioStates.values()) {
            state.low = low
            state.mid = mid
            state.high = high
            state.vol = vol
            state.setSpectrum?.(this._fftData)
            state.setWaveform?.(this._timeDomainData)
        }
```

Replace with:

```javascript
        const sens = this._sensitivity
        // sub: just the deepest FFT bin (~0-187Hz at our 48kHz/256
        // fftSize). Distinct from low (bins 0-3 avg) so the operator
        // can target kick-drum fundamentals specifically — used by
        // Auto-Mix's audio source picker.
        const sub  = Math.min(1, (fft[0] / 255) * sens)
        const low  = Math.min(1, ((fft[0] + fft[1] + fft[2] + fft[3]) / 4 / 255) * sens)
        const mid  = Math.min(1, ((fft[4] + fft[6] + fft[8] + fft[10]) / 4 / 255) * sens)
        const high = Math.min(1, ((fft[16] + fft[20] + fft[24] + fft[28]) / 4 / 255) * sens)
        const vol  = (low + mid + high) / 3

        this.meters.sub = sub
        this.meters.low = low
        this.meters.mid = mid
        this.meters.high = high
        this.meters.vol = vol

        for (const state of this._audioStates.values()) {
            state.sub = sub
            state.low = low
            state.mid = mid
            state.high = high
            state.vol = vol
            state.setSpectrum?.(this._fftData)
            state.setWaveform?.(this._timeDomainData)
        }
```

- [ ] **Step 2: Reset sub on disable**

In `disable()` find:

```javascript
        this.meters.low = this.meters.mid = this.meters.high = this.meters.vol = 0
        for (const state of this._audioStates.values()) {
            state.low = 0; state.mid = 0; state.high = 0; state.vol = 0
```

Replace with:

```javascript
        this.meters.sub = this.meters.low = this.meters.mid = this.meters.high = this.meters.vol = 0
        for (const state of this._audioStates.values()) {
            state.sub = 0; state.low = 0; state.mid = 0; state.high = 0; state.vol = 0
```

- [ ] **Step 3: Initialize sub on construction**

In the constructor find `this.meters = { low: 0, mid: 0, high: 0, vol: 0 }` and change to `this.meters = { sub: 0, low: 0, mid: 0, high: 0, vol: 0 }`.

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 2: Track last-CC-per-channel in SharedMidi

**Files:**
- Modify: `js/midi.js`

- [ ] **Step 1: Add fields + subscription helpers**

In the constructor of `SharedMidi`, after the existing `this._inputs = []` initializations, add:

```javascript
        // Track the most recent CC value (0..1) per MIDI channel. Used
        // by Auto-Mix's MIDI source picker — "whichever knob the user
        // just touched on this channel" drives the fader.
        this._lastCcByChannel = new Map()
        this._lastCcListeners = []
```

After the existing `onStatusChange`/`onBpm`/`onTransport` methods, add:

```javascript
    /** Subscribe to every CC arrival. Callback fires (channel, value01). */
    onLastCcChange(cb) { this._lastCcListeners.push(cb) }

    /** Synchronous: most recent CC value on a channel, or null if none. */
    lastCcOnChannel(channel) {
        return this._lastCcByChannel.has(channel)
            ? this._lastCcByChannel.get(channel)
            : null
    }
```

- [ ] **Step 2: Update the CC dispatch path**

In `_onMessage`, find the CC dispatch block (around line 285):

```javascript
            // Dispatch to bound control(s), normalising into the
            // assigned min/max range. Defaults to 0..127 for assignments
            // saved before range-learn existed.
            for (const [controlId, asg] of Object.entries(this._assignments)) {
                if (asg.ch === channel && asg.cc === cc) {
                    const min = asg.min ?? 0
                    const max = asg.max ?? 127
                    const span = Math.max(1, max - min)
                    const value01 = Math.max(0, Math.min(1, (value - min) / span))
                    const handler = this._controlHandlers.get(controlId)?.handler
                    if (handler) handler(value01)
                }
            }

            // Mirror into each deck's midiState (use raw 0..1 scaling
            // here — the noisemaker midi() automation does its own
            // mapping with min/max args)
            const raw01 = value / 127
            for (const state of this._midiStates.values()) {
                this._writeCcIntoMidiState(state, channel, cc, raw01)
            }
        }
```

Replace with (adding the last-CC tracking right before the deck-state mirror):

```javascript
            // Dispatch to bound control(s), normalising into the
            // assigned min/max range. Defaults to 0..127 for assignments
            // saved before range-learn existed.
            for (const [controlId, asg] of Object.entries(this._assignments)) {
                if (asg.ch === channel && asg.cc === cc) {
                    const min = asg.min ?? 0
                    const max = asg.max ?? 127
                    const span = Math.max(1, max - min)
                    const value01 = Math.max(0, Math.min(1, (value - min) / span))
                    const handler = this._controlHandlers.get(controlId)?.handler
                    if (handler) handler(value01)
                }
            }

            // Mirror into each deck's midiState (use raw 0..1 scaling
            // here — the noisemaker midi() automation does its own
            // mapping with min/max args)
            const raw01 = value / 127
            for (const state of this._midiStates.values()) {
                this._writeCcIntoMidiState(state, channel, cc, raw01)
            }

            // Track the latest CC value for the channel + fan out to
            // subscribers (Auto-Mix watches this).
            this._lastCcByChannel.set(channel, raw01)
            for (const cb of this._lastCcListeners) cb(channel, raw01)
        }
```

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 3: Add `oscillatorCount` to Deck's rebind state

**Files:**
- Modify: `js/noisemaker/deck.js`

- [ ] **Step 1: Default the new field**

In the `Deck` constructor find:

```javascript
        this.rebind = {
            originalDsl: '',
            bandpass: true,
            overrides: {}
        }
```

Replace with:

```javascript
        this.rebind = {
            originalDsl: '',
            bandpass: true,
            oscillatorCount: 0,   // 0..4 oscillators per rebind roll
            overrides: {}
        }
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 4: Add oscillator emission to rebind module

**Files:**
- Modify: `js/rebind.js`

- [ ] **Step 1: Add pools + node builder**

Near the top of `js/rebind.js`, after the existing `MIDI_MODE_INDICES` constant, add:

```javascript
// Oscillator types we'll randomize across. Mirrors oscKindNames order
// in the bundle:
//   0 sine, 1 tri, 2 saw, 3 sawInv, 4 square
// Noise types (5, 6) are intentionally skipped — they're scrolling
// random walks rather than repeating waveforms.
const OSC_TYPE_INDICES = [0, 1, 2, 3, 4]

// Integer speeds = clean loops against the deck's loop duration.
// 1 = one cycle per loop, 2 = two cycles, etc.
const OSC_SPEEDS = [1, 2, 4, 8]
```

After the `midiNode` helper, add:

```javascript
/** Build an Oscillator automation in resolved form. */
function oscNode(typeIndex, speed, m1, m2) {
    return {
        type: 'Oscillator',
        oscType: typeIndex,
        min: m1,
        max: m2,
        speed
    }
}
```

- [ ] **Step 2: Add oscillator branch to `buildAudioOverrides`**

Find:

```javascript
export function buildAudioOverrides({
    rebindable, homeBands, bandpass, count, rand = Math.random
}) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const bands = bandpass ? homeBands : [0, 1, 2]
    const out = {}
    for (const p of picked) {
        const bandIdx = bands[Math.floor(rand() * bands.length)]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        out[p.stepIndex][p.paramName] = audioNode(bandIdx, m1, m2)
    }
    return out
}
```

Replace with:

```javascript
export function buildAudioOverrides({
    rebindable, homeBands, bandpass, count, oscillatorCount = 0,
    rand = Math.random
}) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const bands = bandpass ? homeBands : [0, 1, 2]
    const nOsc = Math.max(0, Math.min(oscillatorCount, picked.length))
    const out = {}
    for (let i = 0; i < picked.length; i++) {
        const p = picked[i]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        if (i < nOsc) {
            const typeIdx = OSC_TYPE_INDICES[Math.floor(rand() * OSC_TYPE_INDICES.length)]
            const speed   = OSC_SPEEDS[Math.floor(rand() * OSC_SPEEDS.length)]
            out[p.stepIndex][p.paramName] = oscNode(typeIdx, speed, m1, m2)
        } else {
            const bandIdx = bands[Math.floor(rand() * bands.length)]
            out[p.stepIndex][p.paramName] = audioNode(bandIdx, m1, m2)
        }
    }
    return out
}
```

- [ ] **Step 3: Add the same branch to `buildMidiOverrides`**

Find:

```javascript
export function buildMidiOverrides({ rebindable, count, rand = Math.random }) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const out = {}
    for (const p of picked) {
        const channel = Math.floor(rand() * 16)
        const modeIndex = MIDI_MODE_INDICES[Math.floor(rand() * MIDI_MODE_INDICES.length)]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        out[p.stepIndex][p.paramName] = midiNode(channel, modeIndex, m1, m2)
    }
    return out
}
```

Replace with:

```javascript
export function buildMidiOverrides({ rebindable, count, oscillatorCount = 0, rand = Math.random }) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const nOsc = Math.max(0, Math.min(oscillatorCount, picked.length))
    const out = {}
    for (let i = 0; i < picked.length; i++) {
        const p = picked[i]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        if (i < nOsc) {
            const typeIdx = OSC_TYPE_INDICES[Math.floor(rand() * OSC_TYPE_INDICES.length)]
            const speed   = OSC_SPEEDS[Math.floor(rand() * OSC_SPEEDS.length)]
            out[p.stepIndex][p.paramName] = oscNode(typeIdx, speed, m1, m2)
        } else {
            const channel = Math.floor(rand() * 16)
            const modeIndex = MIDI_MODE_INDICES[Math.floor(rand() * MIDI_MODE_INDICES.length)]
            out[p.stepIndex][p.paramName] = midiNode(channel, modeIndex, m1, m2)
        }
    }
    return out
}
```

- [ ] **Step 4: Pass `oscillatorCount` through `rebindEq` and `rebindMidi`**

Find:

```javascript
export async function rebindEq(deck, program, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const homeBands = homeBandsForProgram(program)
    const count = 2 + Math.floor(rand() * 3)   // 2,3,4
    const overrides = buildAudioOverrides({
        rebindable, homeBands, bandpass: rebind.bandpass, count, rand
    })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}
```

Replace with:

```javascript
export async function rebindEq(deck, program, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const homeBands = homeBandsForProgram(program)
    const count = 2 + Math.floor(rand() * 3)   // 2,3,4
    const overrides = buildAudioOverrides({
        rebindable, homeBands, bandpass: rebind.bandpass, count,
        oscillatorCount: rebind.oscillatorCount || 0, rand
    })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}
```

Find:

```javascript
export async function rebindMidi(deck, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const count = 2 + Math.floor(rand() * 3)
    const overrides = buildMidiOverrides({ rebindable, count, rand })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}
```

Replace with:

```javascript
export async function rebindMidi(deck, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const count = 2 + Math.floor(rand() * 3)
    const overrides = buildMidiOverrides({
        rebindable, count,
        oscillatorCount: rebind.oscillatorCount || 0, rand
    })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}
```

- [ ] **Step 5: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 5: Spec test — oscillator emission in rebound DSL

**Files:**
- Modify: `tests/rebind.spec.js`

- [ ] **Step 1: Add the test**

After the existing `rebind: clearRebinds restores original DSL` test, add:

```javascript
test('rebind: oscillatorCount=4 emits osc() in regenerated DSL', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            deck.rebind.oscillatorCount = 4
            const ok = await window.__visualize.rebind.rebindEq(deck, program)
            return { ok, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        // With count=4 and rebindEq picking 2-4 params, every binding
        // should be an osc() — there should be no NEW audio() bindings
        // beyond whatever the program's original DSL declared.
        const oscCount = (result.newDsl.match(/osc\(/g) || []).length
        expect(oscCount).toBeGreaterThanOrEqual(2)
        // At least one oscType reference should appear.
        expect(/oscKind\.(sine|tri|saw|sawInv|square)/.test(result.newDsl)).toBe(true)
    } finally {
        await context.close()
    }
})
```

- [ ] **Step 2: Run just this test**

Run: `npx playwright test tests/rebind.spec.js --reporter=line --retries=0 -g "oscillatorCount=4"`

Expected: PASS. (If a roll happens to pick 0 rebindable params, the test would fail — but the program "Bass Bloom" has many numeric params and `2 + floor(rand*3)` always ≥ 2, so picked.length ≥ 2, so nOsc ≥ 2.)

---

## Task 6: Create `AutoXfade` class

**Files:**
- Create: `js/autoxfade.js`

- [ ] **Step 1: Write the module**

Create the file with this exact content:

```javascript
// SPDX-License-Identifier: MIT
/**
 * AutoXfade — automate the crossfader from a single chosen source.
 *
 * Mutually exclusive with AutoMix (auto-VJ) — both raise an
 * onEnableChange event, and the app wires each to call setEnabled(false)
 * on the other.
 *
 * Source kinds:
 *   { kind: 'osc',   oscType: 0..4 }      sine/tri/saw/sawInv/square,
 *                                          one full cycle per bar
 *   { kind: 'audio', band: 'sub'|'low'|'mid'|'high' }
 *   { kind: 'midi',  channel: 0..15 }      latest CC seen on the channel
 *
 * tick(nowMs) is called from the compositor's per-frame hook; it reads
 * the current source value and writes via setXfade(value01).
 */

const OSC_NAMES = ['sine', 'tri', 'saw', 'sawInv', 'square']

function evalOsc(typeIndex, phase) {
    // phase in [0, 1); return value in [0, 1]
    const t = phase - Math.floor(phase)
    switch (typeIndex) {
        case 0: return 0.5 + 0.5 * Math.sin(2 * Math.PI * t)   // sine
        case 1: return t < 0.5 ? 2 * t : 2 * (1 - t)            // tri
        case 2: return t                                         // saw
        case 3: return 1 - t                                     // sawInv
        case 4: return t < 0.5 ? 0 : 1                           // square
        default: return 0.5
    }
}

const DEFAULT_SOURCE = { kind: 'osc', oscType: 0 }

export class AutoXfade {
    constructor({ scheduler, audio, midi, setXfade }) {
        this.scheduler = scheduler
        this.audio = audio
        this.midi = midi
        this.setXfade = setXfade
        this._enabled = false
        this._source = { ...DEFAULT_SOURCE }
        this._enableListeners = []
    }

    get enabled() { return this._enabled }
    get source() { return { ...this._source } }

    onEnableChange(cb) { this._enableListeners.push(cb) }

    setEnabled(v) {
        const next = !!v
        if (next === this._enabled) return
        this._enabled = next
        for (const cb of this._enableListeners) cb(this._enabled)
    }

    /** Source must be { kind: 'osc'|'audio'|'midi', ... }. Invalid
     *  inputs are silently ignored — the picker constrains to valid
     *  values. */
    setSource(src) {
        if (!src || typeof src !== 'object') return
        if (src.kind === 'osc' && Number.isFinite(src.oscType)) {
            this._source = { kind: 'osc', oscType: src.oscType | 0 }
        } else if (src.kind === 'audio'
                   && ['sub', 'low', 'mid', 'high'].includes(src.band)) {
            this._source = { kind: 'audio', band: src.band }
        } else if (src.kind === 'midi' && Number.isFinite(src.channel)) {
            this._source = { kind: 'midi', channel: src.channel | 0 }
        }
    }

    /** Read the live source value as a 0..1 float, or null if no
     *  signal yet (only happens for MIDI before any CC arrives). */
    readSource(nowMs) {
        const s = this._source
        if (s.kind === 'osc') {
            const barSec = this.scheduler?.barSeconds?.() || 2
            const phase = (nowMs / 1000) / barSec
            return evalOsc(s.oscType, phase)
        }
        if (s.kind === 'audio') {
            return this.audio?.meters?.[s.band] ?? 0
        }
        if (s.kind === 'midi') {
            const v = this.midi?.lastCcOnChannel?.(s.channel)
            return v == null ? null : v
        }
        return null
    }

    tick(nowMs) {
        if (!this._enabled) return
        const v = this.readSource(nowMs)
        // Null only happens for MIDI-no-signal — park the fader at
        // 0.5 so it doesn't snap to either side.
        const xfade = v == null ? 0.5 : Math.max(0, Math.min(1, v))
        this.setXfade(xfade)
    }

    snapshot() {
        return { enabled: this._enabled, source: { ...this._source } }
    }

    restore(snap) {
        if (!snap) return
        if (snap.source) this.setSource(snap.source)
        this.setEnabled(!!snap.enabled)
    }
}

/** Display name for an oscillator type index. */
export function oscTypeName(i) { return OSC_NAMES[i] || `osc${i}` }
```

- [ ] **Step 2: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 7: Wire OSC count button into HTML + CSS

**Files:**
- Modify: `index.html`
- Modify: `css/app.css`

- [ ] **Step 1: Restructure deck A head**

Find:

```html
            <div class="deck deck-a" data-deck="A">
                <div class="deck-head">
                    <button class="deck-density" data-deck="A" id="deck-a-density" title="Render zoom (click to cycle 100/75/50/25%)">
                        <span class="icon">zoom_in</span>
                        <span class="density-value">100%</span>
                    </button>
                    <div class="deck-head-actions">
                        <button class="deck-rebind-eq" data-deck="A" title="Reshuffle audio bindings (E)"><span class="icon">graphic_eq</span></button>
                        <button class="deck-rebind-midi" data-deck="A" title="Reshuffle MIDI bindings (M)"><span class="icon">piano</span></button>
                        <button class="deck-bandpass" data-deck="A" title="Bandpass: EQ rebind stays in this program's bands"><span class="icon">filter_alt</span></button>
                        <button class="deck-edit-toggle" data-deck="A" title="Edit DSL"><span class="icon">code</span></button>
                        <button class="deck-load-random" data-deck="A" title="Load random program"><span class="icon">shuffle</span></button>
                    </div>
                </div>
```

Replace with:

```html
            <div class="deck deck-a" data-deck="A">
                <div class="deck-head">
                    <button class="deck-osc-count" data-deck="A" id="deck-a-osc-count" title="Oscillator count for rebind (click to cycle 0–4)">
                        <span class="icon">graphic_eq</span>
                        <span class="osc-value">×0</span>
                    </button>
                    <div class="deck-head-actions">
                        <button class="deck-rebind-eq" data-deck="A" title="Reshuffle audio bindings (E)"><span class="icon">graphic_eq</span></button>
                        <button class="deck-rebind-midi" data-deck="A" title="Reshuffle MIDI bindings (M)"><span class="icon">piano</span></button>
                        <button class="deck-bandpass" data-deck="A" title="Bandpass: EQ rebind stays in this program's bands"><span class="icon">filter_alt</span></button>
                        <button class="deck-edit-toggle" data-deck="A" title="Edit DSL"><span class="icon">code</span></button>
                        <button class="deck-load-random" data-deck="A" title="Load random program"><span class="icon">shuffle</span></button>
                    </div>
                </div>
                <div class="deck-head-row2">
                    <button class="deck-density" data-deck="A" id="deck-a-density" title="Render zoom (click to cycle 100/75/50/25%)">
                        <span class="icon">zoom_in</span>
                        <span class="density-value">100%</span>
                    </button>
                </div>
```

- [ ] **Step 2: Same for deck B**

Find the deck B equivalent block and apply the matching restructure (swap A → B everywhere, update id `deck-b-osc-count` / `deck-b-density`).

- [ ] **Step 3: Add CSS for the new row + button**

In `css/app.css` find the `.deck-head { ... }` rule (around line 568). Right after it (before the `.deck-head-actions` rule), add:

```css
/* Second deck-head row — holds the density/zoom button now that
   OSC + the action rail fill the top row. */
.deck-head-row2 {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--hf-space-2);
    padding: 0 var(--hf-space-3) var(--hf-space-2);
    font-family: var(--hf-font-family-mono);
}
```

Then find the `.deck-density { ... }` block (around line 622) and extend its selector list to include `.deck-osc-count`:

Find:

```css
.deck-density {
    appearance: none;
    background: transparent;
    border: var(--hf-border-width) solid var(--hf-border-subtle);
    color: var(--hf-text-dim);
    border-radius: var(--hf-radius-sm);
    height: 32px;
    padding: 0 8px;
    font-family: var(--hf-font-family-mono);
    font-size: var(--hf-size-xs);
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: var(--hf-transition-color), var(--hf-transition-border);
}
.deck-density:hover { color: var(--hf-accent); border-color: var(--hf-accent); }
.deck-density[data-mode="manual"] {
    color: var(--hf-text-bright);
    border-color: color-mix(in srgb, var(--hf-accent) 60%, transparent);
}
```

Replace with:

```css
.deck-density,
.deck-osc-count {
    appearance: none;
    background: transparent;
    border: var(--hf-border-width) solid var(--hf-border-subtle);
    color: var(--hf-text-dim);
    border-radius: var(--hf-radius-sm);
    height: 32px;
    padding: 0 8px;
    font-family: var(--hf-font-family-mono);
    font-size: var(--hf-size-xs);
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: var(--hf-transition-color), var(--hf-transition-border);
    display: inline-flex;
    align-items: center;
    gap: 4px;
}
.deck-density:hover,
.deck-osc-count:hover { color: var(--hf-accent); border-color: var(--hf-accent); }
.deck-density[data-mode="manual"],
.deck-osc-count[data-active="1"] {
    color: var(--hf-text-bright);
    border-color: color-mix(in srgb, var(--hf-accent) 60%, transparent);
}
```

- [ ] **Step 4: Lint via http-server probe (no JS to lint)**

Skip — these are HTML/CSS only.

---

## Task 8: Wire OSC count button in `app.js`

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Extend persistence to include `oscillatorCount`**

Find:

```javascript
    function loadBandpassState() {
        try {
            const raw = localStorage.getItem(REBIND_STORAGE_KEY)
            const parsed = raw ? JSON.parse(raw) : {}
            return {
                A: parsed.A !== false,
                B: parsed.B !== false
            }
        } catch {
            return { A: true, B: true }
        }
    }
    function persistBandpassState() {
        try {
            localStorage.setItem(REBIND_STORAGE_KEY, JSON.stringify({
                A: state.decks.A.rebind.bandpass,
                B: state.decks.B.rebind.bandpass
            }))
        } catch {}
    }
```

Replace with:

```javascript
    function loadRebindUiState() {
        try {
            const raw = localStorage.getItem(REBIND_STORAGE_KEY)
            const parsed = raw ? JSON.parse(raw) : {}
            const pick = (side) => {
                const e = (parsed[side] && typeof parsed[side] === 'object')
                    ? parsed[side] : { bandpass: parsed[side] }
                return {
                    bandpass: e.bandpass !== false,
                    oscillatorCount: Math.max(0, Math.min(4, e.oscillatorCount | 0))
                }
            }
            return { A: pick('A'), B: pick('B') }
        } catch {
            return {
                A: { bandpass: true, oscillatorCount: 0 },
                B: { bandpass: true, oscillatorCount: 0 }
            }
        }
    }
    function persistRebindUiState() {
        try {
            localStorage.setItem(REBIND_STORAGE_KEY, JSON.stringify({
                A: {
                    bandpass: state.decks.A.rebind.bandpass,
                    oscillatorCount: state.decks.A.rebind.oscillatorCount
                },
                B: {
                    bandpass: state.decks.B.rebind.bandpass,
                    oscillatorCount: state.decks.B.rebind.oscillatorCount
                }
            }))
        } catch {}
    }
```

- [ ] **Step 2: Add an `updateOscCountBtn` helper**

Right after `updateBandpassBtn` add:

```javascript
    function updateOscCountBtn(deckId) {
        const btn = document.querySelector(`.deck-osc-count[data-deck="${deckId}"]`)
        if (!btn) return
        const n = state.decks[deckId].rebind.oscillatorCount || 0
        const label = btn.querySelector('.osc-value')
        if (label) label.textContent = `×${n}`
        btn.dataset.active = n > 0 ? '1' : '0'
        btn.title = n === 0
            ? 'Oscillator count for rebind (click to cycle 0–4)'
            : `Rebind uses ${n} oscillator${n === 1 ? '' : 's'} (click to cycle 0–4)`
    }
```

- [ ] **Step 3: Wire the click handler + replace bandpass-only persistence calls**

In `wireRebindButtons`, find:

```javascript
    function wireRebindButtons() {
        const persisted = loadBandpassState()
        for (const deckId of ['A', 'B']) {
            state.decks[deckId].rebind.bandpass = persisted[deckId]
            const eqBtn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
            const midiBtn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
            const bpBtn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
            if (eqBtn) eqBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindEq(state.decks[deckId], programForDeck(deckId))
                if (ok) {
                    flashRebindBtn(eqBtn)
                    audio.refreshDeckStates()
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (midiBtn) midiBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindMidi(state.decks[deckId])
                if (ok) {
                    flashRebindBtn(midiBtn)
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (bpBtn) bpBtn.addEventListener('click', () => {
                state.decks[deckId].rebind.bandpass = !state.decks[deckId].rebind.bandpass
                updateBandpassBtn(deckId)
                persistBandpassState()
            })
            updateBandpassBtn(deckId)
        }
    }
    wireRebindButtons()
```

Replace with:

```javascript
    function wireRebindButtons() {
        const persisted = loadRebindUiState()
        for (const deckId of ['A', 'B']) {
            state.decks[deckId].rebind.bandpass = persisted[deckId].bandpass
            state.decks[deckId].rebind.oscillatorCount = persisted[deckId].oscillatorCount
            const eqBtn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
            const midiBtn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
            const bpBtn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
            const oscBtn = document.querySelector(`.deck-osc-count[data-deck="${deckId}"]`)
            if (eqBtn) eqBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindEq(state.decks[deckId], programForDeck(deckId))
                if (ok) {
                    flashRebindBtn(eqBtn)
                    audio.refreshDeckStates()
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (midiBtn) midiBtn.addEventListener('click', async () => {
                const ok = await rebind.rebindMidi(state.decks[deckId])
                if (ok) {
                    flashRebindBtn(midiBtn)
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (bpBtn) bpBtn.addEventListener('click', () => {
                state.decks[deckId].rebind.bandpass = !state.decks[deckId].rebind.bandpass
                updateBandpassBtn(deckId)
                persistRebindUiState()
            })
            if (oscBtn) oscBtn.addEventListener('click', () => {
                const r = state.decks[deckId].rebind
                r.oscillatorCount = ((r.oscillatorCount || 0) + 1) % 5
                updateOscCountBtn(deckId)
                persistRebindUiState()
            })
            updateBandpassBtn(deckId)
            updateOscCountBtn(deckId)
        }
    }
    wireRebindButtons()
```

- [ ] **Step 4: Add `updateOscCountBtn` to the refreshRebind hook**

In `applyAccessors()` find:

```javascript
            refreshRebind: () => {
                // After a scene recall the deck's _currentDsl is the
                // regenerated rebind DSL — push it back into any open
                // editor and refresh the per-deck UI chrome too.
                updateBandpassBtn('A')
                updateBandpassBtn('B')
                updateDensityButton('A')
                updateDensityButton('B')
                syncDeckEditor('A')
                syncDeckEditor('B')
            }
```

Replace with:

```javascript
            refreshRebind: () => {
                // After a scene recall the deck's _currentDsl is the
                // regenerated rebind DSL — push it back into any open
                // editor and refresh the per-deck UI chrome too.
                updateBandpassBtn('A')
                updateBandpassBtn('B')
                updateOscCountBtn('A')
                updateOscCountBtn('B')
                updateDensityButton('A')
                updateDensityButton('B')
                syncDeckEditor('A')
                syncDeckEditor('B')
            }
```

- [ ] **Step 5: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 9: Add Auto-Mix UI strip to `index.html`

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Insert the AutoMix block before the existing AutoVJ**

Find:

```html
                <span class="status-divider"></span>

                <button id="automix-toggle" class="status-pill status-toggle status-automix" data-state="off" title="Auto-VJ — cycle through library">
                    <span class="status-icon icon">autorenew</span>
                    <span class="status-text">AUTO-VJ</span>
                </button>
                <label class="status-field" title="Auto-VJ cycle length">
                    <span class="status-field-label">cycle</span>
                    <select id="automix-bars">
                        <option value="4">4 bars</option>
                        <option value="8" selected>8 bars</option>
                        <option value="16">16 bars</option>
                        <option value="32">32 bars</option>
                    </select>
                </label>
```

Replace with:

```html
                <span class="status-divider"></span>

                <button id="automixer-toggle" class="status-pill status-toggle status-automixer" data-state="off" title="Auto-Mix — automate crossfader from a single source (mutually exclusive with Auto-VJ)">
                    <span class="status-icon icon">tune</span>
                    <span class="status-text">AUTO-MIX</span>
                </button>
                <label class="status-field" title="Auto-Mix source">
                    <span class="status-field-label">source</span>
                    <select id="automixer-source">
                        <optgroup label="osc">
                            <option value="osc:0" selected>sine</option>
                            <option value="osc:1">tri</option>
                            <option value="osc:2">saw</option>
                            <option value="osc:3">sawInv</option>
                            <option value="osc:4">square</option>
                        </optgroup>
                        <optgroup label="audio">
                            <option value="audio:sub">sub</option>
                            <option value="audio:low">low</option>
                            <option value="audio:mid">mid</option>
                            <option value="audio:high">high</option>
                        </optgroup>
                        <optgroup label="midi">
                            <option value="midi:0">ch 1</option>
                            <option value="midi:1">ch 2</option>
                            <option value="midi:2">ch 3</option>
                            <option value="midi:3">ch 4</option>
                            <option value="midi:4">ch 5</option>
                            <option value="midi:5">ch 6</option>
                            <option value="midi:6">ch 7</option>
                            <option value="midi:7">ch 8</option>
                            <option value="midi:8">ch 9</option>
                            <option value="midi:9">ch 10</option>
                            <option value="midi:10">ch 11</option>
                            <option value="midi:11">ch 12</option>
                            <option value="midi:12">ch 13</option>
                            <option value="midi:13">ch 14</option>
                            <option value="midi:14">ch 15</option>
                            <option value="midi:15">ch 16</option>
                        </optgroup>
                    </select>
                </label>

                <span class="status-divider"></span>

                <button id="automix-toggle" class="status-pill status-toggle status-automix" data-state="off" title="Auto-VJ — cycle through library">
                    <span class="status-icon icon">autorenew</span>
                    <span class="status-text">AUTO-VJ</span>
                </button>
                <label class="status-field" title="Auto-VJ cycle length">
                    <span class="status-field-label">cycle</span>
                    <select id="automix-bars">
                        <option value="4">4 bars</option>
                        <option value="8" selected>8 bars</option>
                        <option value="16">16 bars</option>
                        <option value="32">32 bars</option>
                    </select>
                </label>
```

---

## Task 10: Construct + wire AutoXfade in `app.js`

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Import the module**

After the existing `import * as rebind from './rebind.js'` add:

```javascript
import { AutoXfade } from './autoxfade.js'
```

- [ ] **Step 2: Construct the instance + load persisted state**

In `boot()`, AFTER `const autoMix = new AutoMix({ ... })` block (and after the existing `compositor.onFrame(() => autoMix.tickFrame())` registration), add:

```javascript
    // ── Auto-Mix (crossfader automation) ─────────────────────────────
    // Mutually exclusive with Auto-VJ (above): each side calls
    // setEnabled(false) on the other when it turns on.
    const AUTOXFADE_STORAGE_KEY = 'visualize.autoxfade.v1'
    const autoXfade = new AutoXfade({
        scheduler, audio, midi,
        setXfade: (v) => {
            state.crossfade = v
            compositor.setCrossfade(v)
            xfaderEl.value = String(v)
            updateLiveIndicator()
        }
    })
    // Mutual exclusion. setEnabled is idempotent.
    autoXfade.onEnableChange(on => { if (on) autoMix.setEnabled(false) })
    // Auto-VJ's enable path doesn't fire callbacks today; we wrap its
    // toggle in the click handler below instead.

    function persistAutoXfade() {
        try {
            localStorage.setItem(
                AUTOXFADE_STORAGE_KEY,
                JSON.stringify(autoXfade.snapshot())
            )
        } catch {}
    }
    function loadAutoXfade() {
        try {
            const raw = localStorage.getItem(AUTOXFADE_STORAGE_KEY)
            if (raw) autoXfade.restore(JSON.parse(raw))
        } catch {}
    }
    loadAutoXfade()

    // Drive the autoXfade per-frame; honours its own enabled flag.
    compositor.onFrame(() => autoXfade.tick(performance.now()))
```

- [ ] **Step 3: Wire the toggle + source dropdown + mutual exclusion to auto-VJ**

After the existing `$('automix-toggle').addEventListener('click', () => { ... })` block, add:

```javascript
    // ── Auto-Mix UI wiring ───────────────────────────────────────────
    const autoXfadeToggleEl = $('automixer-toggle')
    const autoXfadeSourceEl = $('automixer-source')

    function updateAutoXfadeToggleUi() {
        autoXfadeToggleEl.dataset.state = autoXfade.enabled ? 'on' : 'off'
    }
    function syncAutoXfadeSourceUi() {
        const s = autoXfade.source
        let key = 'osc:0'
        if (s.kind === 'osc') key = `osc:${s.oscType}`
        else if (s.kind === 'audio') key = `audio:${s.band}`
        else if (s.kind === 'midi') key = `midi:${s.channel}`
        if (autoXfadeSourceEl) autoXfadeSourceEl.value = key
    }
    syncAutoXfadeSourceUi()
    updateAutoXfadeToggleUi()

    autoXfadeToggleEl.addEventListener('click', () => {
        autoXfade.setEnabled(!autoXfade.enabled)
        updateAutoXfadeToggleUi()
        // Mirror the auto-VJ pill in case mutual exclusion flipped it.
        $('automix-toggle').dataset.state = autoMix.enabled ? 'on' : 'off'
        persistAutoXfade()
    })

    autoXfadeSourceEl.addEventListener('change', () => {
        const v = autoXfadeSourceEl.value
        const [kind, rest] = v.split(':')
        if (kind === 'osc') autoXfade.setSource({ kind: 'osc', oscType: parseInt(rest, 10) })
        else if (kind === 'audio') autoXfade.setSource({ kind: 'audio', band: rest })
        else if (kind === 'midi') autoXfade.setSource({ kind: 'midi', channel: parseInt(rest, 10) })
        persistAutoXfade()
    })
```

- [ ] **Step 4: Make the auto-VJ click handler turn off auto-mix**

Find:

```javascript
    $('automix-toggle').addEventListener('click', () => {
        const on = autoMix.toggle()
        $('automix-toggle').dataset.state = on ? 'on' : 'off'
    })
```

Replace with:

```javascript
    $('automix-toggle').addEventListener('click', () => {
        const on = autoMix.toggle()
        $('automix-toggle').dataset.state = on ? 'on' : 'off'
        // Mutual exclusion: if auto-VJ just came on, kill auto-mix.
        if (on && autoXfade.enabled) {
            autoXfade.setEnabled(false)
            updateAutoXfadeToggleUi()
            persistAutoXfade()
        }
    })
```

- [ ] **Step 5: Expose autoXfade on the test hook**

Find the existing test hook block:

```javascript
    window.__visualize = { audio, midi, decks: state.decks, rebind, state }
```

Replace with:

```javascript
    window.__visualize = { audio, midi, decks: state.decks, rebind, state, autoXfade, autoMix }
```

- [ ] **Step 6: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 11: Round-trip auto-mix config in scenes

**Files:**
- Modify: `js/scenes.js`
- Modify: `js/app.js`

- [ ] **Step 1: Snapshot field**

In `Scenes.snapshot`, find:

```javascript
    static snapshot({ decks, getXfade, getCurve, scheduler, getFxState, getAutoMixConfig, getMixerState, getDeckDensity }) {
```

Replace with:

```javascript
    static snapshot({ decks, getXfade, getCurve, scheduler, getFxState, getAutoMixConfig, getMixerState, getDeckDensity, getAutoXfadeConfig }) {
```

In the same method's return object, after `autoMix: getAutoMixConfig(),` add:

```javascript
            autoXfade: getAutoXfadeConfig?.() || null,
```

- [ ] **Step 2: Apply field**

In `Scenes.apply`, find:

```javascript
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, setMixerState, setDeckDensity, refreshAudio, refreshRebind }) {
```

Replace with:

```javascript
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, setAutoXfadeConfig, setMixerState, setDeckDensity, refreshAudio, refreshRebind }) {
```

In the same method, find the end of the body just before `if (snapshot.mixer && setMixerState) {`:

```javascript
        if (snapshot.autoMix) setAutoMixConfig(snapshot.autoMix)
        if (snapshot.mixer && setMixerState) {
```

Replace with (inserting autoXfade restore between autoMix and mixer — autoXfade goes last so its setEnabled fires after autoMix's, letting the mutual-exclusion wiring win cleanly if both were saved on):

```javascript
        if (snapshot.autoMix) setAutoMixConfig(snapshot.autoMix)
        if (snapshot.autoXfade && setAutoXfadeConfig) {
            try { setAutoXfadeConfig(snapshot.autoXfade) }
            catch (err) { errors.push(`autoXfade: ${err?.message || err}`) }
        }
        if (snapshot.mixer && setMixerState) {
```

- [ ] **Step 3: Provide the accessors in `app.js`**

In `snapshotAccessors()` find:

```javascript
            getDeckDensity: () => ({
                A: { ...state.deckDensity.A },
                B: { ...state.deckDensity.B }
            })
        }
    }
```

Replace with:

```javascript
            getDeckDensity: () => ({
                A: { ...state.deckDensity.A },
                B: { ...state.deckDensity.B }
            }),
            getAutoXfadeConfig: () => autoXfade.snapshot()
        }
    }
```

In `applyAccessors()` find:

```javascript
            setDeckDensity: (d) => {
                if (!d) return
                for (const id of ['A', 'B']) {
                    const saved = d[id]
                    if (!saved) continue
                    state.deckDensity[id] = { mode: saved.mode, value: saved.value }
                    state.decks[id].setPixelDensity(saved.value)
                }
            },
```

Right after that block add:

```javascript
            setAutoXfadeConfig: (cfg) => {
                autoXfade.restore(cfg)
                syncAutoXfadeSourceUi()
                updateAutoXfadeToggleUi()
                persistAutoXfade()
            },
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 12: Spec test — AutoXfade construction + sources + mutex

**Files:**
- Create: `tests/autoxfade.spec.js`

- [ ] **Step 1: Write the spec**

Create the file with this content:

```javascript
// SPDX-License-Identifier: MIT
/**
 * Auto-Mix smoke. Boots the full app, verifies:
 *   - osc source: tick moves the xfade across the 0..1 range over time
 *   - audio source: meter value drives the xfade
 *   - midi source: synthetic CC drives the xfade
 *   - mutual exclusion with Auto-VJ
 *   - source survives scene round-trip
 */
import { test, expect } from '@playwright/test'

test.describe.configure({ timeout: 120_000, retries: 1 })

async function boot(browser) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[browser error]', msg.text())
    })
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() => !!window.__visualize?.autoXfade,
        null, { timeout: 30_000 })
    return { context, page }
}

test('autoXfade: osc source sweeps the crossfader', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        // Sample the autoXfade osc value across an artificial range
        // of nowMs. The renderer + compositor are running in the
        // background; we just call autoXfade.readSource directly.
        const samples = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            ax.setSource({ kind: 'osc', oscType: 0 })   // sine
            const out = []
            for (let i = 0; i < 11; i++) {
                // 0..barSec*1000 in 11 steps, one full cycle.
                const barMs = (window.__visualize.state ? 2000 : 2000)
                out.push(ax.readSource(i * barMs / 10))
            }
            return out
        })
        // A sine evaluated 0..1 should span a wide range.
        const min = Math.min(...samples), max = Math.max(...samples)
        expect(max - min).toBeGreaterThan(0.8)
    } finally {
        await context.close()
    }
})

test('autoXfade: audio source reads from meters', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const audio = window.__visualize.audio
            ax.setSource({ kind: 'audio', band: 'low' })
            audio.meters.low = 0.42
            const v = ax.readSource(0)
            return { v }
        })
        expect(result.v).toBeCloseTo(0.42, 5)
    } finally {
        await context.close()
    }
})

test('autoXfade: midi source reads latest CC on channel', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const midi = window.__visualize.midi
            // Inject latest CC directly via the new tracking field.
            midi._lastCcByChannel.set(3, 0.77)
            ax.setSource({ kind: 'midi', channel: 3 })
            return ax.readSource(0)
        })
        expect(result).toBeCloseTo(0.77, 5)
    } finally {
        await context.close()
    }
})

test('autoXfade: mutual exclusion with auto-VJ', async ({ browser }) => {
    const { context, page } = await boot(browser)
    try {
        const result = await page.evaluate(() => {
            const ax = window.__visualize.autoXfade
            const am = window.__visualize.autoMix
            // Turn auto-VJ on, then auto-mix on — auto-VJ should turn off.
            am.setEnabled(true)
            ax.setEnabled(true)
            return { autoMixEnabled: am.enabled, autoXfadeEnabled: ax.enabled }
        })
        expect(result.autoMixEnabled).toBe(false)
        expect(result.autoXfadeEnabled).toBe(true)
    } finally {
        await context.close()
    }
})
```

- [ ] **Step 2: Run just this spec**

Run: `npx playwright test tests/autoxfade.spec.js --reporter=line --retries=0`

Expected: 4 PASS.

---

## Task 13: Full lint + Playwright suite

- [ ] **Step 1: Lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 2: Full suite**

Run: `npm test`

Expected: ALL pass. If audio-midi or smoke flakes once (pre-existing under heavy load) and the retry passes, treat as pass.

---

## Task 14: Single commit + push

- [ ] **Step 1: Review the diff**

Run: `git status` and `git diff --stat`

Verify only the files in the file-structure section above are modified.

- [ ] **Step 2: Stage everything**

Run:

```bash
git add docs/superpowers/specs/2026-05-27-oscillators-and-auto-mix-design.md \
        docs/superpowers/plans/2026-05-27-oscillators-and-auto-mix.md \
        js/rebind.js js/noisemaker/deck.js js/audio.js js/midi.js \
        js/autoxfade.js js/app.js js/scenes.js \
        index.html css/app.css \
        tests/rebind.spec.js tests/autoxfade.spec.js
```

- [ ] **Step 3: Commit + push**

Run:

```bash
git commit -m "$(cat <<'EOF'
feat: per-deck oscillator rebind + Auto-Mix crossfader automation

Two related features:

1. Per-deck OSC×N (0–4) — when N > 0, EQ/MIDI rebind swaps
   min(N, picked.length) of its random-bind picks for randomized
   osc() bindings (sine/tri/saw/sawInv/square at integer loop
   speeds 1/2/4/8). UI button cycles 0→4 on each deck; density
   button moves to a new second header row.

2. Auto-Mix — drives the crossfader from a single chosen source:
   an oscillator type (BPM-locked to one cycle per bar), an audio
   band (sub/low/mid/high, with sub = fft[0] new), or a MIDI
   channel (whichever CC last moved on that channel). Mutually
   exclusive with Auto-VJ. Survives scene round-trip and
   localStorage persistence.

New js/autoxfade.js owns the per-frame tick logic. js/rebind.js
gains an OSC pool that flows through buildAudioOverrides /
buildMidiOverrides. js/audio.js exposes a new sub meter;
js/midi.js tracks last-CC-per-channel for the Auto-Mix MIDI source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)" && git push origin main
```

Expected: push succeeds.

---

## Self-review

**Spec coverage:**
- F1: deck.rebind.oscillatorCount, default 0 → Task 3
- F1: persistence with bandpass → Task 8
- F1: scene round-trip → covered by Task 3 (added to deck.rebind) + the existing `cloneRebind` in `scenes.js` which deep-clones the whole rebind object — no scenes.js change needed
- F1: rebind algorithm changes (nOsc params) → Task 4
- F1: oscillator pool (5 types, 4 speeds) → Task 4
- F1: UI button cycle 0–4 + density moves → Tasks 7, 8
- F1: spec test → Task 5
- F2: AutoXfade class with osc/audio/midi sources → Task 6
- F2: sub audio band → Task 1
- F2: midi latest-CC-per-channel → Task 2
- F2: UI strip + dropdown → Task 9
- F2: app wiring + mutual exclusion + persistence → Task 10
- F2: scene round-trip → Task 11
- F2: spec test → Task 12

**Type consistency:**
- `oscillatorCount` field name appears identically in Tasks 3, 4, 5, 8.
- `OSC_TYPE_INDICES`/`OSC_SPEEDS` defined once (Task 4); referenced internally.
- `AutoXfade` method names (`setEnabled`, `setSource`, `tick`, `snapshot`, `restore`, `onEnableChange`) consistent across Tasks 6, 10, 11, 12.
- `getAutoXfadeConfig`/`setAutoXfadeConfig` parameter names match in Tasks 11 spec for scenes + accessors.
- `_lastCcByChannel` (Task 2) used by `lastCcOnChannel` (Task 2) and tested directly (Task 12).

No placeholders found.
