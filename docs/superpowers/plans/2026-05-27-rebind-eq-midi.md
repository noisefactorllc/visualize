# Rebind EQ / Rebind MIDI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-deck operator-triggered reshuffle of audio/MIDI parameter bindings — pure runtime DSL mutation via the Noisemaker bundle's existing `compile`/`unparse`/`getEffect` exports, no new authoring schema.

**Architecture:** New `js/rebind.js` module owns the pure transform logic. `js/noisemaker/deck.js` grows `originalDsl` + `rebindOverrides` state plus a `reloadDsl()` entry point that does not stomp them. `js/app.js` wires three new per-deck buttons (`EQ ↻`, `MIDI ↻`, bandpass toggle) + keyboard shortcuts + persistence. `js/automix.js` gets a toggle for auto-rebinding on every load. `js/scenes.js` round-trips the overrides.

**Tech Stack:** Vanilla ES modules, Noisemaker shader bundle (CDN), Playwright for smoke tests.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `js/rebind.js` (NEW) | Pure module. `rebindEq(deck, opts)`, `rebindMidi(deck, opts)`, `clearRebinds(deck)`, `applyRebinds(deck)`, helpers `randomSubWindow`, `homeBandsForProgram`, `collectRebindableParams`. Imports `compile`, `unparse`, `getEffect`, `formatValue`, `extractEffectsFromDsl` from the bundle. |
| `js/noisemaker/bundle.js` (MODIFY) | Add `compile`, `formatValue` to the re-export list (already in the bundle but not currently re-exported by visualize). |
| `js/noisemaker/deck.js` (MODIFY) | Add `rebind: { originalDsl, bandpass, overrides }` field. `load()` sets `originalDsl` + clears `overrides`. New `reloadDsl(dsl)` reloads renderer without touching rebind state. |
| `js/app.js` (MODIFY) | Wire HTML buttons, keyboard shortcuts (`e`/`E`/`m`/`M`), persist bandpass to localStorage, hook into AutoMix `onLoad` for auto-rebind, hook scene apply. |
| `js/automix.js` (MODIFY) | Add `autoRebindEq` flag (default true) + setter. `_triggerSceneSwap` fires rebind after successful load. |
| `js/scenes.js` (MODIFY) | Include each deck's `rebind.overrides` + `bandpass` in snapshot + apply. |
| `index.html` (MODIFY) | Add three buttons per deck in `.deck-head-actions`. |
| `css/app.css` (MODIFY) | Style the new buttons (re-use `.deck-load-random` style; add `.bandpass-toggle.lit` accent state). |
| `tests/rebind.spec.js` (NEW) | Playwright spec: load a known reactive program, call `rebindEq` via `window.__visualize.rebind`, assert the regenerated DSL contains `audio(` automations on previously-literal params and (with bandpass on) only `audioBand.<homeband>` enum names. Same shape for `rebindMidi` checking `midi(` + `midiMode.*`. Bandpass-off test asserts at least some non-home band appears across multiple rolls. |

---

## Task 1: Re-export `compile` and `formatValue` from the visualize bundle wrapper

**Files:**
- Modify: `js/noisemaker/bundle.js` (re-export list)

- [ ] **Step 1: Read current re-export list to confirm gaps**

The current file re-exports `parse`, `unparse`, `extractEffectsFromDsl` but the rebind module will also need `compile` (already re-exported) and `formatValue` (not re-exported). Check with grep:

```bash
grep -n "compile\|formatValue\|getEffect\b" js/noisemaker/bundle.js
```

Expected output should show `compile` and `getEffect` already re-exported on lines 32 and 28. `formatValue` may already be present too — confirm.

- [ ] **Step 2: Add any missing re-exports**

If `formatValue` is absent from the destructuring list, add it. The file is short — modify the destructured `const {...}` block on lines 24-51. After this task the re-export block must include at minimum: `CanvasRenderer`, `CDN_BASE`, `compile`, `parse`, `unparse`, `extractEffectsFromDsl`, `getEffect`, `getAllEffects`, `formatValue`, `stdEnums`.

- [ ] **Step 3: Sanity-check with the linter**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 4: Commit deferred**

Hold all commits until the end (single-commit mandate from the user).

---

## Task 2: Write the pure rebind module (skeleton + unit-testable helpers)

**Files:**
- Create: `js/rebind.js`

- [ ] **Step 1: Write the module skeleton with helper functions**

Create `js/rebind.js` with this exact content:

```javascript
// SPDX-License-Identifier: MIT
/**
 * Rebind — per-deck reshuffle of audio/MIDI parameter bindings.
 *
 * Each program's original DSL is the source of truth. On a "rebind"
 * action we:
 *   1. compile(originalDsl) → compiled
 *   2. pick 2-4 random numeric params from the compiled pipeline
 *   3. generate Audio (or Midi) automation override objects for them
 *   4. unparse(compiled, overrides) → new DSL
 *   5. deck.reloadDsl(newDsl) — does NOT touch rebind state
 *
 * Numeric param discovery comes straight from the effect manifest
 * (getEffect(effectKey).globals[paramName]). No per-program curation.
 */

import {
    compile, unparse, extractEffectsFromDsl,
    getEffect, formatValue, stdEnums
} from './noisemaker/bundle.js'

// Band index → enum name used by audio(band: audioBand.<name>).
const BAND_NAMES = ['low', 'mid', 'high']

// Tag → band index (matches tags written by the curated library).
const TAG_TO_BAND = { bass: 0, mid: 1, high: 2 }

// MIDI modes we'll randomize across. Pitch-driven modes (noteChange,
// gateNote) are intentionally skipped — they map note pitch to value,
// which is unintuitive when the operator hasn't picked specific notes.
const MIDI_MODES = ['velocity', 'gateVelocity', 'triggerNote']

/**
 * Pick home bands for a program from its tags. A program tagged
 * ["bass", "mid"] returns [0, 1]. Untagged → all three bands.
 */
export function homeBandsForProgram(program) {
    const tags = program?.tags || []
    const set = new Set()
    for (const tag of tags) {
        const idx = TAG_TO_BAND[tag]
        if (idx !== undefined) set.add(idx)
    }
    if (set.size === 0) return [0, 1, 2]
    return [...set].sort()
}

/**
 * Walk the compiled DSL and collect every (stepIndex, paramName, spec)
 * tuple that's rebindable: numeric scalar (float/int), with min+max
 * defined, not a `ui.control: false` knob.
 */
export function collectRebindableParams(originalDsl) {
    const effects = extractEffectsFromDsl(originalDsl) || []
    const out = []
    for (const eff of effects) {
        const def = getEffect(eff.effectKey)
        if (!def?.globals) continue
        for (const [paramName, spec] of Object.entries(def.globals)) {
            if (!spec) continue
            if (spec.type !== 'float' && spec.type !== 'int') continue
            if (spec.ui && spec.ui.control === false) continue
            if (spec.min === undefined || spec.max === undefined) continue
            // Skip internal-looking params; the bundle prefixes private
            // knobs with `_`.
            if (paramName.startsWith('_')) continue
            out.push({
                stepIndex: eff.stepIndex,
                effectKey: eff.effectKey,
                paramName,
                spec
            })
        }
    }
    return out
}

/**
 * Pick a random (min, max) sub-window inside [lo, hi]. One of three
 * flavours, equally weighted:
 *   full   — (lo, hi)
 *   narrow — random 20-40% slice somewhere inside
 *   invert — (hi, lo)  (parameter still sweeps the same range but
 *                       tracks audio inversely)
 *
 * `rand` is an optional injected RNG for deterministic tests; defaults
 * to Math.random.
 */
export function randomSubWindow(lo, hi, rand = Math.random) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
        return [lo, hi]
    }
    const flavour = Math.floor(rand() * 3)
    if (flavour === 0) return [lo, hi]
    if (flavour === 2) return [hi, lo]
    const span = hi - lo
    const widthPct = 0.2 + rand() * 0.2     // 20%-40%
    const width = span * widthPct
    const startPct = rand() * (1 - widthPct)
    const start = lo + span * startPct
    return [round3(start), round3(start + width)]
}

function round3(v) { return Math.round(v * 1000) / 1000 }

function shuffle(arr, rand = Math.random) {
    const out = [...arr]
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
            ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
}

function pickN(arr, n, rand = Math.random) {
    return shuffle(arr, rand).slice(0, n)
}

/**
 * Build an Audio automation AST node for a given (band, m1, m2).
 */
function audioNode(bandIndex, m1, m2) {
    return {
        type: 'Audio',
        band: { type: 'Member', path: ['audioBand', BAND_NAMES[bandIndex]] },
        min: { type: 'Number', value: m1 },
        max: { type: 'Number', value: m2 }
    }
}

/**
 * Build a Midi automation AST node.
 */
function midiNode(channel, modeName, m1, m2) {
    return {
        type: 'Midi',
        channel: { type: 'Number', value: channel },
        mode: { type: 'Member', path: ['midiMode', modeName] },
        min: { type: 'Number', value: m1 },
        max: { type: 'Number', value: m2 },
        sensitivity: { type: 'Number', value: 1 }
    }
}

/**
 * Convert the override map to the shape `unparse` expects: keyed by
 * globalStepIndex, with `{ [paramName]: value }` per step.
 */
function overridesToUnparseShape(overrideMap) {
    const out = {}
    for (const [stepIndex, params] of Object.entries(overrideMap)) {
        out[stepIndex] = { ...params }
    }
    return out
}

/**
 * Core rewrite: compile the original DSL, splice in the overrides,
 * unparse to text. Returns the new DSL string, or null on failure.
 */
export function regenerateDsl(originalDsl, overrideMap) {
    let compiled
    try {
        compiled = compile(originalDsl)
    } catch (err) {
        console.warn('[rebind] compile failed:', err?.message || err)
        return null
    }
    try {
        return unparse(compiled, overridesToUnparseShape(overrideMap), {
            enums: stdEnums,
            customFormatter: (v, spec) => formatValue(v, spec, { enums: stdEnums }),
            getEffectDef: (name) => getEffect(name)
        })
    } catch (err) {
        console.warn('[rebind] unparse failed:', err?.message || err)
        return null
    }
}

/**
 * Build a fresh override map of n random Audio bindings, drawn from
 * `rebindable` and constrained to `homeBands` when bandpass is true.
 */
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

/**
 * Build a fresh override map of n random Midi bindings.
 */
export function buildMidiOverrides({ rebindable, count, rand = Math.random }) {
    if (rebindable.length === 0) return {}
    const n = Math.max(1, Math.min(count, rebindable.length))
    const picked = pickN(rebindable, n, rand)
    const out = {}
    for (const p of picked) {
        const channel = Math.floor(rand() * 16)
        const mode = MIDI_MODES[Math.floor(rand() * MIDI_MODES.length)]
        const [m1, m2] = randomSubWindow(p.spec.min, p.spec.max, rand)
        out[p.stepIndex] ||= {}
        out[p.stepIndex][p.paramName] = midiNode(channel, mode, m1, m2)
    }
    return out
}

/**
 * Roll a new Audio rebind on the given deck. Returns true on success.
 */
export function rebindEq(deck, program, { rand = Math.random } = {}) {
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

/**
 * Roll a new Midi rebind on the given deck. Returns true on success.
 */
export function rebindMidi(deck, { rand = Math.random } = {}) {
    const rebind = deck.rebind
    if (!rebind?.originalDsl) return false
    const rebindable = collectRebindableParams(rebind.originalDsl)
    if (rebindable.length === 0) return false
    const count = 2 + Math.floor(rand() * 3)
    const overrides = buildMidiOverrides({ rebindable, count, rand })
    rebind.overrides = overrides
    return _applyAndLoad(deck)
}

/**
 * Drop all overrides and reload the original DSL.
 */
export function clearRebinds(deck) {
    if (!deck.rebind) return false
    deck.rebind.overrides = {}
    if (!deck.rebind.originalDsl) return false
    return _reloadInner(deck, deck.rebind.originalDsl)
}

/**
 * Re-apply the current override map. Useful for scene recall.
 */
export function applyRebinds(deck) {
    return _applyAndLoad(deck)
}

function _applyAndLoad(deck) {
    const dsl = regenerateDsl(deck.rebind.originalDsl, deck.rebind.overrides)
    if (!dsl) return false
    return _reloadInner(deck, dsl)
}

function _reloadInner(deck, dsl) {
    const p = deck.reloadDsl(dsl)
    if (p && typeof p.then === 'function') {
        p.catch(err => console.warn('[rebind] reload failed:', err))
    }
    return true
}
```

- [ ] **Step 2: Lint the new file**

Run: `npm run lint`

Expected: PASS (no syntax errors).

---

## Task 3: Extend the Deck class with rebind state and `reloadDsl()`

**Files:**
- Modify: `js/noisemaker/deck.js`

- [ ] **Step 1: Add rebind state in the constructor**

Find the constructor in `js/noisemaker/deck.js` (around line 63). After the existing field initializations (`this._pixelDensity = 1.0` at line 90), add:

```javascript
        // Per-deck rebind state. originalDsl is the pristine DSL from
        // the library entry; overrides is the last-rolled EQ/MIDI
        // override map (cleared on a fresh load(), preserved across
        // reloadDsl() calls). bandpass is operator-set + persisted.
        this.rebind = {
            originalDsl: '',
            bandpass: true,
            overrides: {}
        }
```

- [ ] **Step 2: Update `load()` to populate `originalDsl` and clear overrides**

The existing `load()` method (around line 141) currently does the compile and updates `_currentDsl`. We need it to ALSO reset rebind state. Modify the success branch:

Find:
```javascript
            await this._renderer.compile(dsl)
            this._currentDsl = dsl
            this._currentName = name
            this._normalizeColorUniforms()
            if (!this._renderer.isRunning) this._renderer.start()
            return { success: true }
```

Replace with:
```javascript
            await this._renderer.compile(dsl)
            this._currentDsl = dsl
            this._currentName = name
            // New program → rebind state resets to the author's
            // original. `reloadDsl()` is the path that does NOT touch
            // this (used by the rebind module to push regenerated DSL).
            this.rebind.originalDsl = dsl
            this.rebind.overrides = {}
            this._normalizeColorUniforms()
            if (!this._renderer.isRunning) this._renderer.start()
            return { success: true }
```

- [ ] **Step 3: Add `reloadDsl()` method**

Below the `load()` method, before `setSpeed()`, add this method:

```javascript
    /**
     * Reload the renderer with a new DSL string WITHOUT resetting the
     * deck's rebind state (originalDsl, overrides). Used by the rebind
     * module to push regenerated DSL.
     *
     * On compile error the deck keeps running the previous DSL — same
     * behaviour as load(). Returns { success, error? }.
     */
    async reloadDsl(dsl) {
        if (!this._initialized) await this.init()
        try {
            const effectData = extractEffectNamesFromDsl(dsl, this._renderer.manifest || {})
            const effectIds = effectData.map(e => e.effectId)
            if (effectIds.length > 0) {
                await this._renderer.loadEffects(effectIds)
            }
            await this._renderer.compile(dsl)
            this._currentDsl = dsl
            this._normalizeColorUniforms()
            if (!this._renderer.isRunning) this._renderer.start()
            return { success: true }
        } catch (err) {
            const msg = typeof err === 'string' ? err
                : err?.message || err?.error || 'Unknown compile error'
            console.error(`[${this.id}] reloadDsl error:`, err)
            return { success: false, error: msg }
        }
    }
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 4: Add three buttons per deck to `index.html`

**Files:**
- Modify: `index.html` (deck A around line 207, deck B around line 261)

- [ ] **Step 1: Add buttons to deck A's `.deck-head-actions`**

Find this block (around line 207-210):
```html
                    <div class="deck-head-actions">
                        <button class="deck-edit-toggle" data-deck="A" title="Edit DSL"><span class="icon">code</span></button>
                        <button class="deck-load-random" data-deck="A" title="Load random program"><span class="icon">shuffle</span></button>
                    </div>
```

Replace with:
```html
                    <div class="deck-head-actions">
                        <button class="deck-rebind-eq" data-deck="A" title="Reshuffle audio bindings (E)"><span class="icon">graphic_eq</span></button>
                        <button class="deck-rebind-midi" data-deck="A" title="Reshuffle MIDI bindings (M)"><span class="icon">piano</span></button>
                        <button class="deck-bandpass" data-deck="A" title="Bandpass: EQ rebind stays in this program's bands"><span class="icon">filter_alt</span></button>
                        <button class="deck-edit-toggle" data-deck="A" title="Edit DSL"><span class="icon">code</span></button>
                        <button class="deck-load-random" data-deck="A" title="Load random program"><span class="icon">shuffle</span></button>
                    </div>
```

- [ ] **Step 2: Add the same three buttons to deck B's `.deck-head-actions`**

Find the matching block around line 261-264 and replace identically, swapping `data-deck="A"` for `data-deck="B"` and changing the keyboard hint in titles to "(Shift+E)" and "(Shift+M)" respectively:

```html
                    <div class="deck-head-actions">
                        <button class="deck-rebind-eq" data-deck="B" title="Reshuffle audio bindings (Shift+E)"><span class="icon">graphic_eq</span></button>
                        <button class="deck-rebind-midi" data-deck="B" title="Reshuffle MIDI bindings (Shift+M)"><span class="icon">piano</span></button>
                        <button class="deck-bandpass" data-deck="B" title="Bandpass: EQ rebind stays in this program's bands"><span class="icon">filter_alt</span></button>
                        <button class="deck-edit-toggle" data-deck="B" title="Edit DSL"><span class="icon">code</span></button>
                        <button class="deck-load-random" data-deck="B" title="Load random program"><span class="icon">shuffle</span></button>
                    </div>
```

---

## Task 5: Style the new buttons

**Files:**
- Modify: `css/app.css` (around line 596 where `.deck-load-random` is defined)

- [ ] **Step 1: Extend the existing button selector chain**

Find the `.deck-load-random, .deck-edit-toggle { ... }` block at lines 596-608 and extend the selector to cover the three new buttons. Replace:

```css
.deck-load-random,
.deck-edit-toggle {
    appearance: none;
    background: transparent;
    border: var(--hf-border-width) solid var(--hf-border-subtle);
    color: var(--hf-text-dim);
    border-radius: var(--hf-radius-sm);
    width: 32px;
    height: 32px;
    font-size: var(--hf-size-base);
    cursor: pointer;
    transition: var(--hf-transition-color), var(--hf-transition-border);
}
.deck-load-random:hover,
.deck-edit-toggle:hover { color: var(--hf-accent); border-color: var(--hf-accent); }
```

With:

```css
.deck-load-random,
.deck-edit-toggle,
.deck-rebind-eq,
.deck-rebind-midi,
.deck-bandpass {
    appearance: none;
    background: transparent;
    border: var(--hf-border-width) solid var(--hf-border-subtle);
    color: var(--hf-text-dim);
    border-radius: var(--hf-radius-sm);
    width: 32px;
    height: 32px;
    font-size: var(--hf-size-base);
    cursor: pointer;
    transition: var(--hf-transition-color), var(--hf-transition-border);
}
.deck-load-random:hover,
.deck-edit-toggle:hover,
.deck-rebind-eq:hover,
.deck-rebind-midi:hover,
.deck-bandpass:hover { color: var(--hf-accent); border-color: var(--hf-accent); }

/* Bandpass toggle: lit border + bright text when on. */
.deck-bandpass.lit {
    color: var(--hf-text-bright);
    border-color: color-mix(in srgb, var(--hf-accent) 60%, transparent);
}

/* Brief flash to indicate a successful re-roll fired. */
.deck-rebind-eq.flash,
.deck-rebind-midi.flash {
    color: var(--hf-accent);
    border-color: var(--hf-accent);
}
```

---

## Task 6: Wire the new buttons + keyboard shortcuts in `app.js`

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: Add the rebind import near the top**

Find the import block in `js/app.js` (around lines 15-36). After `import { Scenes } from './scenes.js'` (line 26), add:

```javascript
import * as rebind from './rebind.js'
```

- [ ] **Step 2: Add the `wireRebindButtons` helper inside `boot()`**

Insert the following helper inside `boot()`, right after the existing `wireDensityButtons()` definition (around line 488). The function reads from `state` + `library` so it has to live inside boot() (closure over the live deck instances).

```javascript
    // ── Rebind (EQ + MIDI) ───────────────────────────────────────────
    const REBIND_STORAGE_KEY = 'visualize.rebind.v1'

    function loadBandpassState() {
        try {
            const raw = localStorage.getItem(REBIND_STORAGE_KEY)
            const parsed = raw ? JSON.parse(raw) : {}
            return {
                A: parsed.A !== false,   // default true
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
    function programForDeck(deckId) {
        const title = state.decks[deckId].currentName
        return library.byTitle(title) || { tags: [] }
    }
    function flashBtn(btn) {
        if (!btn) return
        btn.classList.add('flash')
        setTimeout(() => btn.classList.remove('flash'), 250)
    }
    function updateBandpassBtn(deckId) {
        const btn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
        if (!btn) return
        const on = state.decks[deckId].rebind.bandpass
        btn.classList.toggle('lit', on)
        btn.title = on
            ? "Bandpass on: EQ rebind stays in this program's bands"
            : 'Bandpass off: EQ rebind picks any band'
    }

    function wireRebindButtons() {
        const persisted = loadBandpassState()
        for (const deckId of ['A', 'B']) {
            state.decks[deckId].rebind.bandpass = persisted[deckId]
            const eqBtn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
            const midiBtn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
            const bpBtn = document.querySelector(`.deck-bandpass[data-deck="${deckId}"]`)
            if (eqBtn) eqBtn.addEventListener('click', () => {
                const ok = rebind.rebindEq(state.decks[deckId], programForDeck(deckId))
                if (ok) {
                    flashBtn(eqBtn)
                    audio.refreshDeckStates()
                    syncDeckEditor(deckId)
                } else {
                    toast(`${deckId}: no rebindable params`)
                }
            })
            if (midiBtn) midiBtn.addEventListener('click', () => {
                const ok = rebind.rebindMidi(state.decks[deckId])
                if (ok) {
                    flashBtn(midiBtn)
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

- [ ] **Step 3: Add keyboard shortcuts**

In the `document.addEventListener('keydown', (e) => {...})` block (around line 1102), add new cases to the `switch (key)`. Insert these BEFORE the `case 'escape':` line. Note: `key` is already lowercased, so we look at `e.shiftKey` to distinguish A vs B.

Find:
```javascript
            case '1': toggleFx('strobe'); break
            case '2': toggleFx('invert'); break
            case '3': toggleFx('bw'); break
            case '4': toggleFx('zoom'); break
            case '5': toggleFx('freeze'); break
            case '6': toggleFx('flash'); break
            case 'escape':
```

Replace with:
```javascript
            case '1': toggleFx('strobe'); break
            case '2': toggleFx('invert'); break
            case '3': toggleFx('bw'); break
            case '4': toggleFx('zoom'); break
            case '5': toggleFx('freeze'); break
            case '6': toggleFx('flash'); break
            case 'e': {
                const deckId = e.shiftKey ? 'B' : 'A'
                const btn = document.querySelector(`.deck-rebind-eq[data-deck="${deckId}"]`)
                btn?.click()
                break
            }
            case 'm': {
                const deckId = e.shiftKey ? 'B' : 'A'
                const btn = document.querySelector(`.deck-rebind-midi[data-deck="${deckId}"]`)
                btn?.click()
                break
            }
            case 'escape':
```

- [ ] **Step 4: Expose the rebind module on the test hook**

Find `window.__visualize = { audio, midi, decks: state.decks }` (around line 198). Add `rebind` to the object so the smoke test can call into it:

```javascript
    window.__visualize = { audio, midi, decks: state.decks, rebind }
```

- [ ] **Step 5: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 7: Hook AutoMix into auto-rebind on every load

**Files:**
- Modify: `js/automix.js`

- [ ] **Step 1: Add a flag for auto-rebinding + setter**

In `js/automix.js` constructor (around line 38), after `this._curve = 'dipped'`, add:

```javascript
        // When true, fire a rebindEq on the incoming deck immediately
        // after each successful auto-load. Default ON — the whole point
        // of auto-VJ is to keep the visual moving.
        this._autoRebindEq = true
```

Then add a setter just after `setCurve` (around line 72):

```javascript
    setAutoRebindEq(v) { this._autoRebindEq = !!v }
    get autoRebindEq() { return this._autoRebindEq }
```

- [ ] **Step 2: Take a rebind module dep and call it after load**

Add to the constructor argument destructure at line 24, alongside `library, decks, ...`:

Find:
```javascript
    constructor({ library, decks, compositor, scheduler, getXfade, setXfade, onStatus, onLoad }) {
```

Replace with:
```javascript
    constructor({ library, decks, compositor, scheduler, getXfade, setXfade, onStatus, onLoad, rebind }) {
```

Then add field assignments in the constructor body, right after `this.onLoad = onLoad || (() => {})`:

```javascript
        // Optional rebind module — when present, _triggerSceneSwap fires
        // a fresh rebindEq() on the just-loaded deck so each scene swap
        // also shuffles which params are audio-driven.
        this.rebind = rebind || null
```

In `_triggerSceneSwap` (around line 132), after the `this.onLoad(incomingDeckId, program)` call, add:

```javascript
            if (this._autoRebindEq && this.rebind) {
                try {
                    this.rebind.rebindEq(deck, program)
                } catch (err) {
                    console.warn('[AutoMix] auto-rebind failed', err)
                }
            }
```

- [ ] **Step 3: Pass `rebind` when constructing AutoMix in app.js**

In `js/app.js` find:
```javascript
    const autoMix = new AutoMix({
        library, decks: state.decks, compositor, scheduler,
        getXfade: () => state.crossfade,
```

Change the first argument-object line to include `rebind`:
```javascript
    const autoMix = new AutoMix({
        library, decks: state.decks, compositor, scheduler, rebind,
        getXfade: () => state.crossfade,
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 8: Round-trip rebind overrides through Scenes

**Files:**
- Modify: `js/scenes.js`

- [ ] **Step 1: Include rebind in `snapshot()`**

Find the `snapshot` static method (around line 41). Inside the `decks.A` and `decks.B` objects, add the `rebind` field:

Find:
```javascript
            decks: {
                A: {
                    title: decks.A.currentName,
                    dsl: decks.A.currentDsl,
                    speed: decks.A._speed ?? 1
                },
                B: {
                    title: decks.B.currentName,
                    dsl: decks.B.currentDsl,
                    speed: decks.B._speed ?? 1
                }
            },
```

Replace with:
```javascript
            decks: {
                A: {
                    title: decks.A.currentName,
                    dsl: decks.A.currentDsl,
                    speed: decks.A._speed ?? 1,
                    rebind: cloneRebind(decks.A.rebind)
                },
                B: {
                    title: decks.B.currentName,
                    dsl: decks.B.currentDsl,
                    speed: decks.B._speed ?? 1,
                    rebind: cloneRebind(decks.B.rebind)
                }
            },
```

- [ ] **Step 2: Add the `cloneRebind` helper at module scope**

Add this helper near the top of `scenes.js`, right after the `MAX_SCENES` constant:

```javascript
function cloneRebind(rebind) {
    if (!rebind) return { originalDsl: '', bandpass: true, overrides: {} }
    // Structured clone via JSON — overrides are pure AST nodes (no
    // functions or cycles).
    return {
        originalDsl: rebind.originalDsl || '',
        bandpass: rebind.bandpass !== false,
        overrides: JSON.parse(JSON.stringify(rebind.overrides || {}))
    }
}
```

- [ ] **Step 3: Apply rebind state in `apply()`**

Modify the per-deck restore in `apply` to also restore rebind state. Currently the body of the for-loop is:

```javascript
        for (const id of ['A', 'B']) {
            const d = snapshot.decks?.[id]
            if (!d || !d.dsl) continue
            try {
                const res = await decks[id].load(d.dsl, d.title || '')
                if (!res.success) errors.push(`deck ${id}: ${res.error}`)
                decks[id].setSpeed(d.speed ?? 1)
            } catch (err) {
                errors.push(`deck ${id}: ${err?.message || err}`)
            }
        }
```

Replace with:

```javascript
        for (const id of ['A', 'B']) {
            const d = snapshot.decks?.[id]
            if (!d || !d.dsl) continue
            try {
                // Load the original DSL first (this resets rebind state).
                const originalDsl = d.rebind?.originalDsl || d.dsl
                const res = await decks[id].load(originalDsl, d.title || '')
                if (!res.success) {
                    errors.push(`deck ${id}: ${res.error}`)
                    continue
                }
                decks[id].setSpeed(d.speed ?? 1)
                // Restore rebind state, then re-roll the saved DSL on top.
                if (d.rebind) {
                    decks[id].rebind.bandpass = d.rebind.bandpass !== false
                    decks[id].rebind.overrides = JSON.parse(JSON.stringify(d.rebind.overrides || {}))
                    // Push the override-rewritten DSL via reloadDsl so we
                    // don't reset overrides we just restored.
                    if (Object.keys(decks[id].rebind.overrides).length > 0) {
                        const { regenerateDsl } = await import('./rebind.js')
                        const newDsl = regenerateDsl(decks[id].rebind.originalDsl, decks[id].rebind.overrides)
                        if (newDsl) await decks[id].reloadDsl(newDsl)
                    }
                }
            } catch (err) {
                errors.push(`deck ${id}: ${err?.message || err}`)
            }
        }
```

- [ ] **Step 4: Update the bandpass toggle UI after recall in app.js**

In `js/app.js`, `applyAccessors()` returns an object with `refreshAudio`. Add a `refreshRebind` accessor and call it from scene recall.

Find `refreshAudio: () => audio.refreshDeckStates()` in `applyAccessors`. Add a line after it:

```javascript
            refreshAudio: () => audio.refreshDeckStates(),
            refreshRebind: () => {
                updateBandpassBtn('A')
                updateBandpassBtn('B')
            }
```

Then in `js/scenes.js` `apply()` signature, accept `refreshRebind`:

```javascript
    static async apply(snapshot, { decks, setXfade, setCurve, scheduler, setFx, setAutoMixConfig, refreshAudio, refreshRebind }) {
```

And call `refreshRebind?.()` at the end of `apply`, just after `refreshAudio?.()`:

```javascript
        refreshAudio?.()
        refreshRebind?.()
```

- [ ] **Step 5: Lint**

Run: `npm run lint`

Expected: PASS.

---

## Task 9: Add a Playwright smoke test for rebind

**Files:**
- Create: `tests/rebind.spec.js`

- [ ] **Step 1: Write the spec**

Create `tests/rebind.spec.js` with this content:

```javascript
// SPDX-License-Identifier: MIT
/**
 * Rebind smoke test. Boots the full app, loads a known bass-tagged
 * program, then verifies:
 *   - rebindEq() produces a deck DSL containing `audio(` automations
 *     on params that didn't have one in the original
 *   - With bandpass on, only audioBand.low appears (the program's home)
 *   - With bandpass off, repeated rolls eventually surface other bands
 *   - rebindMidi() produces `midi(` automations + midiMode.* enums
 *   - clearRebinds() restores the original DSL
 */
import { test, expect } from '@playwright/test'

test.describe.configure({ timeout: 120_000, retries: 1 })

async function bootAndLoad(browser, programTitle) {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto('/')
    await page.click('#boot-start')
    await page.waitForFunction(() =>
        !!window.__visualize?.decks?.A && !!window.__visualize?.rebind,
        null, { timeout: 30_000 })
    // Wait for library to finish loading
    await page.waitForFunction(() => {
        const lib = window.__visualize?.decks?.A
        return !!lib
    }, null, { timeout: 30_000 })
    // Load the target program into deck A via window.__visualize.
    // We call deck.load() directly so we don't depend on library UI
    // having rendered yet.
    await page.evaluate(async (title) => {
        const resp = await fetch('data/programs.json', { cache: 'no-cache' })
        const programs = await resp.json()
        const p = programs.find(x => x.title === title)
        if (!p) throw new Error(`no program titled ${title}`)
        await window.__visualize.decks.A.load(p.dsl, p.title)
        window.__visualize.__currentProgram = p
    }, programTitle)
    return { context, page }
}

test('rebind: EQ produces audio() automations on previously-literal params', async ({ browser }) => {
    // "Bass Bloom" is tagged bass, has multiple numeric params, and
    // declares only two audio bindings in the original DSL.
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(() => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            const originalDsl = deck.rebind.originalDsl
            const ok = window.__visualize.rebind.rebindEq(deck, program)
            return { ok, originalDsl, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        expect(result.newDsl).not.toBe(result.originalDsl)
        // Original Bass Bloom has 2 audio() calls (sub, bassHue). After
        // rebind there should be at least 2 (could be more).
        const origCount = (result.originalDsl.match(/audio\(/g) || []).length
        const newCount = (result.newDsl.match(/audio\(/g) || []).length
        expect(newCount).toBeGreaterThanOrEqual(2)
        // The bandpass default is ON and Bass Bloom's home band is low,
        // so every audio() in the new DSL should reference audioBand.low
        // (not mid/high).
        const allBands = [...result.newDsl.matchAll(/audioBand\.(\w+)/g)].map(m => m[1])
        for (const b of allBands) {
            expect(b).toBe('low')
        }
    } finally {
        await context.close()
    }
})

test('rebind: MIDI produces midi() automations with midiMode enums', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(() => {
            const deck = window.__visualize.decks.A
            const ok = window.__visualize.rebind.rebindMidi(deck)
            return { ok, newDsl: deck._currentDsl }
        })
        expect(result.ok).toBe(true)
        const midiCount = (result.newDsl.match(/midi\(/g) || []).length
        expect(midiCount).toBeGreaterThanOrEqual(2)
        // At least one of the chosen modes must appear. (velocity is the
        // unparse default — it's elided in the output — so we accept
        // either an explicit midiMode.<name> or a bare midi(channel: ...).)
        const hasModeOrDefault =
            /midiMode\.(velocity|gateVelocity|triggerNote)/.test(result.newDsl)
            || /midi\(channel:\s*\d+/.test(result.newDsl)
        expect(hasModeOrDefault).toBe(true)
    } finally {
        await context.close()
    }
})

test('rebind: clearRebinds restores original DSL', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(() => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            const original = deck.rebind.originalDsl
            window.__visualize.rebind.rebindEq(deck, program)
            const afterRebind = deck._currentDsl
            window.__visualize.rebind.clearRebinds(deck)
            const afterClear = deck._currentDsl
            return { original, afterRebind, afterClear }
        })
        expect(result.afterRebind).not.toBe(result.original)
        expect(result.afterClear).toBe(result.original)
    } finally {
        await context.close()
    }
})

test('rebind: bandpass off allows non-home bands across rolls', async ({ browser }) => {
    const { context, page } = await bootAndLoad(browser, 'Bass Bloom')
    try {
        const result = await page.evaluate(async () => {
            const deck = window.__visualize.decks.A
            const program = window.__visualize.__currentProgram
            deck.rebind.bandpass = false
            const bandsSeen = new Set()
            // 20 rolls — with bandpass off, probability of getting only
            // .low across 20×n picks is vanishingly small for the bands
            // assignment (1/3 per pick).
            for (let i = 0; i < 20; i++) {
                window.__visualize.rebind.rebindEq(deck, program)
                const matches = [...deck._currentDsl.matchAll(/audioBand\.(\w+)/g)]
                for (const m of matches) bandsSeen.add(m[1])
            }
            return [...bandsSeen]
        })
        // Expect at least 2 distinct bands across the 20 rolls.
        expect(result.length).toBeGreaterThan(1)
    } finally {
        await context.close()
    }
})
```

- [ ] **Step 2: Run only the new spec**

Run: `npx playwright test tests/rebind.spec.js --reporter=line`

Expected: 4 tests PASS. If something fails, read the error carefully — most likely culprits:
- `audioBand.low` not appearing: check that `tags` lookup in `homeBandsForProgram` matches "bass"
- `midi(` not in output: check that `unparse` accepts `Member`-shaped `mode` (it does, per the bundle code)
- Rebind no-op (`ok: false`): check that `extractEffectsFromDsl` returns non-empty effects (the `search` directive at the start of the DSL must compile)

---

## Task 10: Run the full test suite and verify nothing else broke

- [ ] **Step 1: Lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 2: Full Playwright suite**

Run: `npm test`

Expected: ALL specs PASS (smoke.spec.js, audio-midi.spec.js, rebind.spec.js).

If a previously-passing spec fails, investigate. The most likely regression: the AutoMix auto-rebind flag firing inside the smoke spec's auto-VJ path could produce a DSL that compiles slowly or differently than expected. If so, the smoke test may need a `setAutoRebindEq(false)` call before its auto-VJ assertion — but only adjust if a real regression appears.

---

## Task 11: Manual browser verification

- [ ] **Step 1: Start dev server**

Run in a background terminal: `npm run dev`

- [ ] **Step 2: Open the app + go through the rebind flow**

Open <http://localhost:3007>. Click START SET. Enable audio (settings → device → "default"). Once meters are climbing:

1. With Deck A loaded with any reactive program, click `EQ ↻` on Deck A. The deck should visibly redraw with new audio-bound params; the flash class should briefly light the button.
2. Hit `e` on the keyboard a few more times. Deck A keeps redrawing each press.
3. Hit `Shift+E`. Deck B redraws.
4. Click `🎯` (bandpass) on Deck A. The button border should dim (off state). Press `e` a few more times — over multiple rolls you should see the visual pull from non-home bands.
5. Click `MIDI ↻`. The deck redraws but with no audio meters driving it — the values just sit at the MIDI default (because nothing's connected). That's expected.
6. Save a scene. Reload the page. Recall the scene. The deck should come back with the same rebind state.
7. Reload again. The bandpass toggle's lit/unlit state should persist (localStorage).

If anything in the above sequence misbehaves, debug before moving on.

---

## Task 12: Single-commit + push

- [ ] **Step 1: Review the staged diff**

Run: `git status` then `git diff`

Verify only the files in the file-structure section are changed (no stray edits to node_modules, etc).

- [ ] **Step 2: Stage everything**

Run:
```bash
git add docs/superpowers/plans/2026-05-27-rebind-eq-midi.md \
        js/rebind.js \
        js/noisemaker/bundle.js \
        js/noisemaker/deck.js \
        js/app.js \
        js/automix.js \
        js/scenes.js \
        index.html \
        css/app.css \
        tests/rebind.spec.js
```

- [ ] **Step 3: Commit with a message describing the user-facing change**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(rebind): operator-triggered EQ/MIDI reshuffle per deck

Each deck gets three new buttons in its header rail:
  EQ ↻    — picks 2-4 random numeric params and binds them to
            random Audio automations (bands + ranges)
  MIDI ↻  — same flavour for Midi automations
  🎯/🌐    — bandpass toggle: when on, EQ rebind stays in the
            program's tagged bands; off picks any band

Implementation parses the program's existing DSL via the bundle's
compile()/unparse() and splices automation overrides in for the
chosen params. No new authoring schema; every existing reactive
program is more dynamic immediately. AutoMix auto-fires rebindEq
on each scene swap (toggleable). Scenes round-trip the override
state; bandpass persists to localStorage.

Keyboard: E/Shift+E for EQ-rebind A/B; M/Shift+M for MIDI-rebind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push to origin/main**

Run: `git push origin main`

Expected: push succeeds; CI (if any) starts.

---

## Self-review

**Spec coverage:**
- Home bands derivation → Task 2 (`homeBandsForProgram`)
- Rebindable param discovery → Task 2 (`collectRebindableParams`)
- Rebind state per deck → Task 3
- `rebindEq` / `rebindMidi` / `clearRebinds` → Task 2 (logic) + Task 6 (UI wiring)
- Three buttons per deck → Tasks 4, 5
- Keyboard shortcuts → Task 6
- AutoMix auto-rebind → Task 7
- Scenes round-trip → Task 8
- Bandpass localStorage persistence → Task 6
- Smoke test → Task 9
- `reloadDsl()` separation from `load()` → Task 3
- Single-commit push at end → Task 12

**Placeholder scan:** No TBD/TODO/placeholder text. Each step has either a precise command or a complete code block.

**Type consistency:** `rebind.originalDsl`, `rebind.bandpass`, `rebind.overrides` used identically across Tasks 2, 3, 6, 7, 8. `reloadDsl(dsl)` signature matches across Deck (Task 3), rebind module (Task 2), scenes (Task 8).
