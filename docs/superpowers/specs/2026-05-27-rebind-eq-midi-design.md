# Rebind EQ / Rebind MIDI — Design

Date: 2026-05-27
Status: approved

## Goal

Make the visualize program library *visibly* audioreactive. Today, each
program hard-codes a single `let X = audio(...)` binding per parameter
in its DSL; many of those bindings are too subtle or in the wrong range
to actually pop on stage. The fix is a runtime "reshuffle" workflow:
the operator hits a button to randomize which parameters get bound to
which audio bands (and ranges) until the visual lands.

## Non-goals

- No new authoring schema. The DSL string in `data/programs.json` is the
  source of truth and stays human-editable.
- No per-program curation work. Every existing program becomes more
  dynamic for free.
- No changes to the Noisemaker shader bundle. We use existing exports
  (`compile`, `unparse`, `extractEffectsFromDsl`, `getEffect`).
- Not building a long-term "favourite settings" store. Rebinds are
  throw-away state by design — operator rolls until one lands.

## Core concepts

### Home bands

Derived from the program's existing `tags` field:

| tag    | band index | enum name |
|--------|------------|-----------|
| `bass` | 0          | `low`     |
| `mid`  | 1          | `mid`     |
| `high` | 2          | `high`    |

A program tagged `["bass", "mid"]` has home bands `[low, mid]`. A program
with no band tag has home bands `[low, mid, high]` (all). This is the
only inference we do over the existing data.

### Rebindable parameters

A parameter on a compiled step is rebindable iff its effect-manifest
spec (`getEffect(effectKey).globals[paramName]`) satisfies:

- `spec.type` is `"float"` or `"int"`
- `spec.ui?.control !== false` (skips internal-only knobs)
- `spec.min` and `spec.max` are both defined (so we know the range)
- Not a hard-coded routing identifier (`tex`, `surface`, etc — these are
  not in the numeric type set anyway)

Discovered via `extractEffectsFromDsl(originalDsl)` walking each step's
`globals` and intersecting with the spec rules.

### Rebind state (per deck)

Held on the `Deck` instance, not on the program:

```js
deck.rebind = {
    originalDsl: '...',          // pristine DSL from programs.json
    bandpass: true,              // operator-set, persisted
    overrides: {                 // last-rolled state, ephemeral
        [stepIndex]: {
            [paramName]: { type: "Audio" | "Midi", ... AST node }
        }
    }
}
```

`overrides` is empty when the deck is freshly loaded — the deck runs
the author's original DSL. Each `rebindEq()` / `rebindMidi()` call
overwrites `overrides` and pushes the regenerated DSL to the renderer.

## Algorithms

### `rebindEq(deck)`

```
1. compiled = compile(deck.rebind.originalDsl)
2. rebindable = collect (stepIndex, paramName, spec) where spec is
                a rebindable numeric param
3. n = random integer in [2, 4], clamped to rebindable.length
4. chosen = shuffle(rebindable).slice(0, n)
5. overrides = {}
6. for each (stepIndex, paramName, spec) in chosen:
       band  = pick from homeBands if bandpass on else [low,mid,high]
       (m1,m2) = randomSubWindow(spec.min, spec.max)
       overrides[stepIndex][paramName] = {
           type: "Audio",
           band: { type: "Member", path: ["audioBand", bandName] },
           min:  { type: "Number", value: m1 },
           max:  { type: "Number", value: m2 }
       }
7. newDsl = unparse(compiled, overrides, {
       enums, customFormatter: formatValue,
       getEffectDef: name => getEffect(name)
   })
8. deck.reloadDsl(newDsl)   // does NOT touch originalDsl or rebind state
9. audio.refreshDeckStates()
```

#### `randomSubWindow(min, max)`

Picks one of three flavors with equal weight:

- **full sweep**: `(min, max)`
- **narrow window**: random 20–40% slice somewhere inside `[min, max]`
- **inverted**: full sweep with `min` and `max` swapped (the visual
  parameter still moves through the full range, but it tracks audio
  inversely — useful for things like "scale collapses on the kick"
  rather than "scale opens on the kick")

### `rebindMidi(deck)`

Identical to `rebindEq` except:

- The bandpass toggle is ignored (there is no MIDI equivalent of home
  bands)
- Each automation is:
  ```
  {
      type: "Midi",
      channel:     { type: "Number", value: random 0..15 },
      mode:        { type: "Member", path: ["midiMode", modeName] },
      min:         { type: "Number", value: m1 },
      max:         { type: "Number", value: m2 },
      sensitivity: { type: "Number", value: 1 }
  }
  ```
  where `modeName` is chosen with equal weight from
  `["velocity", "gateVelocity", "triggerNote"]` — the three modes
  matched the "operator hits a key and something jumps" feel; the
  pitch-driven modes (`noteChange`, `gateNote`) are skipped because
  they're unintuitive for VJ use.
- `(m1, m2)` is `randomSubWindow(spec.min, spec.max)` — the bundle's
  midi() automation maps the raw 0-127 controller value through the
  supplied `min`/`max` directly, so we use the same sub-window logic
  as `rebindEq` and the operator gets the same flavours (full sweep,
  narrow, inverted).

### `clearRebinds(deck)`

```
deck.rebind.overrides = {}
deck.reloadDsl(deck.rebind.originalDsl)
```

### Two Deck load entry points

To avoid the rebind state being wiped every time the rebind code
re-pushes a DSL to the renderer, the deck exposes two paths:

| Method                  | Use case                          | Touches rebind state? |
|-------------------------|-----------------------------------|-----------------------|
| `deck.load(dsl, name)`  | New program (library, drag-drop, AutoMix, editor) | YES: `originalDsl = dsl`, `overrides = {}` |
| `deck.reloadDsl(dsl)`   | Rebind-driven re-push to renderer | NO                    |

Both call the same underlying renderer compile path internally; the
only difference is whether they reset `originalDsl` and `overrides`.

### `toggleBandpass(deck)`

Flips `deck.rebind.bandpass`. Does NOT re-roll — the operator has to
hit "EQ ↻" again to see the change.

## UI

Three new compact buttons in each deck's header row, sitting alongside
the existing "🎲 random" and density buttons:

| Button   | Label   | Action               | Visual state         |
|----------|---------|----------------------|----------------------|
| EQ       | `EQ ↻`  | `rebindEq(deck)`     | static (action)      |
| MIDI     | `MIDI ↻`| `rebindMidi(deck)`   | static (action)      |
| Bandpass | `🎯` / `🌐` | `toggleBandpass(deck)` | lit when on (default) |

Bandpass tooltip — on: "EQ rebind stays in this program's bands"; off:
"EQ rebind picks any band".

Keyboard shortcuts:

| Key     | Action          |
|---------|-----------------|
| `e`     | rebind EQ on A  |
| `E`     | rebind EQ on B  |
| `m`     | rebind MIDI on A|
| `M`     | rebind MIDI on B|

Skipped when typing in `INPUT` / `SELECT` / `TEXTAREA` (matches existing
shortcut handler).

## Persistence

- **Bandpass** persists across reloads in `localStorage` key
  `visualize.rebind.v1` as `{ A: bool, B: bool }`.
- **Overrides** are explicitly not persisted globally — but they ARE
  included in scene snapshots so an operator can save a particularly
  good roll as a scene and recall it later.

## Lifecycle hooks

| Event                            | Effect                                             |
|----------------------------------|----------------------------------------------------|
| `deck.load(dsl, name)` (manual)  | sets `originalDsl = dsl`; clears `overrides`       |
| AutoMix loads program            | sets `originalDsl = dsl`; clears `overrides`; THEN auto-fires `rebindEq()` (controlled by an automix-level toggle, default on) |
| Scene save                       | snapshot includes per-deck `overrides`             |
| Scene recall                     | sets `overrides` then re-runs `applyRebinds()`     |
| Editor hot-reload                | sets `originalDsl = editorDsl`; clears `overrides` |

## Files

| File                              | Change                                    |
|-----------------------------------|-------------------------------------------|
| `js/rebind.js`                    | NEW. Pure module: `rebindEq`, `rebindMidi`, `applyRebinds`, `clearRebinds`, helper randomizers. No DOM. |
| `js/noisemaker/deck.js`           | Add `rebind` state; expose `originalDsl`; `load()` populates `originalDsl` and clears `overrides`. |
| `js/noisemaker/bundle.js`         | Export `compile`, `unparse`, `getEffect`, `formatValue` (already exported). |
| `js/app.js`                       | Wire deck-header buttons; keyboard shortcuts; persist bandpass; hook AutoMix `onLoad` to auto-rebind. |
| `js/automix.js`                   | `setAutoRebindEq(bool)` toggle; default `true`. |
| `js/scenes.js`                    | Include `rebind.overrides` per deck in snapshot + apply. |
| `index.html`                      | Three new buttons per deck header.        |
| `css/*`                           | Style for the new buttons (small, compact, themed). |
| `tests/audio-midi.spec.js`        | Smoke test: load a program, call `rebindEq`, assert that the rendered DSL contains `audio(` calls in stepIndex positions that the original did NOT have. Same for `rebindMidi`. Verify bandpass restricts band names. |
| `scripts/validate-programs.mjs`   | (no change — still validates per-program DSL compile)   |

## Edge cases & error handling

- `extractEffectsFromDsl` throws on unparseable DSL → log + return
  empty rebindable list → button is a no-op (toast "no rebindable params").
- Program has fewer than 2 rebindable params → `n = min(4,
  rebindable.length)` and we still rebind however many we have. If 0,
  toast "no rebindable params" and bail.
- `unparse` throws → toast the error; leave the deck on the previous
  (already-loaded) DSL. Don't try to revert programmatically — the deck
  is still running fine.
- Program has `subchain { ... }` blocks → step indices increment
  through subchain begin/end markers (per the bundle's
  `extractEffectsFromDsl`); our overrides key by the same global
  `stepIndex` so this is transparent.

## Open follow-ups (out of scope for this spec)

- A "rebind both decks at once" shortcut.
- Showing which params are currently rebound in the deck editor view.
- Per-program "ban list" of params that should never get rebound (for
  programs where one parameter would break the visual if randomized).
- Scene-recall reproducibility if a program's DSL has been edited in
  the library since the scene was saved (currently: silent drift).
