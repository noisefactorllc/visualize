# Oscillators + Auto-Mix — Design

Date: 2026-05-27
Status: approved

## Goal

Two related features that broaden the operator's automation palette:

1. **Per-deck oscillator count in rebind** — the existing rebind EQ /
   MIDI workflow gains a per-deck "OSC ×N" knob (0–4). When N>0,
   `min(N, picked.length)` of the rebound params get random
   *oscillator* automations instead of audio/MIDI ones — sine/tri/saw
   waves locked to the deck's loop. Audio/MIDI fall through for the
   remaining picked params.

2. **Auto-Mix** — a new global automation that drives the crossfader
   from a single chosen source: an oscillator, an audio band, or a
   MIDI channel. Mutually exclusive with Auto-VJ.

## Non-goals

- No new authoring schema for programs; everything still lives in
  the rebind state + the existing DSL.
- No `audio(band: audioBand.sub)` in the DSL — the new sub
  measurement is for Auto-Mix's UI only.
- No new osc speed picker for Auto-Mix — fixed at one cycle per bar.
- No per-source per-deck rebind oscillator speed control beyond the
  internal random pick from `{1, 2, 4, 8}`.

## Feature 1 — Oscillators in rebind

### State

```js
deck.rebind = {
    originalDsl: '...',
    bandpass: true,
    oscillatorCount: 0,           // NEW: 0..4
    overrides: { ... }
}
```

Persisted with bandpass to `visualize.rebind.v1` as
`{ A: { bandpass, oscillatorCount }, B: { bandpass, oscillatorCount } }`.
Survives scene snapshot/recall via `cloneRebind`.

### Algorithm

`rebindEq(deck, program)` and `rebindMidi(deck)` change:

```
1. compiled = compile(originalDsl)
2. rebindable = collectRebindableParams(...)
3. n  = random 2..4 picked from rebindable
4. nOsc = min(deck.rebind.oscillatorCount, picked.length)
5. for i in 0..nOsc-1:
       overrides[stepIndex][paramName] = oscNode(...)
6. for i in nOsc..picked.length-1:
       overrides[stepIndex][paramName] = audioNode(...)  // or midiNode for rebindMidi
```

### Oscillator node

```js
{
    type: 'Oscillator',
    oscType: <0..4>,           // sine|tri|saw|sawInv|square — numeric index
    min: <m1>,
    max: <m2>,
    speed: <1|2|4|8>           // integer for clean loop alignment
}
```

In *resolved* form to match the inline-kwarg unparse path (same
discovery from the previous rebind work). `offset` and `seed` left
at defaults (the unparse formatter elides defaults).

### Oscillator pool

- `OSC_TYPES = [0, 1, 2, 3, 4]` — sine/tri/saw/sawInv/square
- `OSC_SPEEDS = [1, 2, 4, 8]`
- Random pick from each pool per binding

`noise1d` (5) and `noise2d` (6) are excluded — they're scrolling
random walks rather than repeating waveforms, and the user wanted
"speeds integers for looping".

### UI

- New compact button per deck: `OSC ×N` with `waveform` icon.
- Click cycles `0 → 1 → 2 → 3 → 4 → 0` (same pattern as the
  density button).
- The **density button moves out of the top row** to a new
  `.deck-head-row2` strip below it, since the top row is already
  full after we add OSC.

```
┌─[.deck-head]─────────────────────────────────────────────────┐
│ OSC×N    EQ↻ MIDI↻ 🎯 code shuffle                            │
├─[.deck-head-row2]────────────────────────────────────────────┤
│ zoom 100%                                                     │
├─[.deck-canvas-wrap]──────────────────────────────────────────┤
│  ...                                                          │
```

## Feature 2 — Auto-Mix

### Module

`js/autoxfade.js` (the legacy `automix.js` keeps its name —
renaming would churn unrelated imports and the new feature is
distinct enough to warrant a separate file).

```js
export class AutoXfade {
    constructor({ scheduler, audio, midi, setXfade })
    setEnabled(bool)                              // also calls onEnableChange(bool)
    setSource(source)                             // { kind, ... }
    onEnableChange(cb)                            // for mutual-exclusion wiring
    tick(nowMs)                                   // called per frame from compositor
    get enabled()
    get source()
    snapshot()                                    // { enabled, source }
    restore(snap)
}
```

### Sources

Stored as a discriminated object:

| `source.kind` | extra fields                        |
|---------------|-------------------------------------|
| `'osc'`       | `oscType: 0..4` (sine..square)      |
| `'audio'`     | `band: 'sub'|'low'|'mid'|'high'`    |
| `'midi'`      | `channel: 0..15`                    |

Default on first enable: `{ kind: 'osc', oscType: 0 }` (sine).

### Per-tick value

- **osc**: `phase = (nowMs % barMs) / barMs` (0..1 across one bar
  via `scheduler.barSeconds() * 1000`); then evaluated using JS
  versions of the same wave functions the bundle emits — sine =
  `0.5 + 0.5 * sin(2π·phase)`, etc.
- **audio**: `audio.meters[band]` (already clamped 0..1 by the
  analyzer's sensitivity multiplier).
- **midi**: latest CC value seen on the channel (0..1), or 0.5
  if nothing has come in yet — avoids snapping the fader to either
  side just because no controller is connected.

`setXfade(value)` writes `state.crossfade` via the same callback
auto-VJ uses for its fade animation.

### Mutual exclusion with Auto-VJ

Both modules expose `onEnableChange(cb)`. In `app.js`:

```js
autoXfade.onEnableChange(on => { if (on) autoMix.setEnabled(false) })
autoMix.onEnableChange(on => { if (on) autoXfade.setEnabled(false) })
```

That's it — no shared global state. The UI buttons just reflect
each module's enabled flag.

### New audio "sub" measurement

`SharedAudio._loop()` adds:

```js
const sub = Math.min(1, (fft[0] / 255) * sens)
this.meters.sub = sub
state.sub = sub     // also write into each deck's audioState bag
```

DSL programs that look up `audioState.sub` will see it; DSL
programs using `audio(band: audioBand.<low|mid|high|vol>)` are
unaffected. The bundle's `audioBand` enum stays unchanged (no
sub in it) — that's deliberate; Auto-Mix is the only consumer.

### MIDI "latest CC on channel"

`SharedMidi` gains:

```js
_lastCcByChannel = new Map()    // channel -> latest value01
_lastCcListeners = []           // (channel, value01) callbacks

onLastCcChange(cb)              // subscribe to every CC arrival
lastCcOnChannel(channel)        // synchronous getter, returns 0..1 or null
```

Existing CC dispatch path additionally:

```js
this._lastCcByChannel.set(channel, value01)
for (const cb of this._lastCcListeners) cb(channel, value01)
```

### UI

New status section in the controls row, immediately to the **left
of `#automix-toggle`**, separated by a `.status-divider`:

```html
<span class="status-divider"></span>
<button id="automixer-toggle" class="status-pill status-toggle"
        data-state="off" title="Auto-Mix — automate crossfader">
    <span class="status-icon icon">tune</span>
    <span class="status-text">AUTO-MIX</span>
</button>
<label class="status-field" title="Auto-Mix source">
    <span class="status-field-label">source</span>
    <select id="automixer-source">
        <optgroup label="osc">
            <option value="osc:0">sine</option>
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
            ...
            <option value="midi:15">ch 16</option>
        </optgroup>
    </select>
</label>
<span class="status-divider"></span>
```

### Persistence

`visualize.autoxfade.v1` = `{ enabled, source }`. Loaded on boot;
written on every change.

### Scene snapshot

Per-deck:
- `cloneRebind` already snapshots the deck's whole rebind object;
  oscillatorCount comes along for free.

Global:
- `snapshot.autoXfade = autoXfade.snapshot()` — `{enabled, source}`
- `apply.setAutoXfadeConfig(cfg)` — restores it.

Mutual exclusion at recall time: apply Auto-VJ first, then
Auto-Mix. If both were saved as on (shouldn't happen, but defensive),
the last-applied wins by calling setEnabled on the other.

## Lifecycle ordering on apply

Updated apply sequence:

1. Density (was already first — buffer sizing precedes compile)
2. Decks (load + rebind restore; rebind state now includes
   oscillatorCount, which is just a number to round-trip)
3. refreshAudio / refreshRebind (UI sync)
4. BPM, divider
5. Curve, xfade
6. FX
7. AutoMix (auto-VJ) config
8. AutoXfade config  ← NEW, must come AFTER step 7 so it can
                       disable AutoMix if both were on
9. Mixer effect

## Files

| File                              | Change                                    |
|-----------------------------------|-------------------------------------------|
| `js/rebind.js`                    | `OSC_TYPES`, `OSC_SPEEDS`, `oscNode()`, oscillator branch in `buildAudioOverrides` + `buildMidiOverrides`. |
| `js/noisemaker/deck.js`           | Default `oscillatorCount: 0` in `this.rebind`. |
| `js/audio.js`                     | `sub` band — `fft[0] / 255 * sens` — written to meters + each deck's audioState. |
| `js/midi.js`                      | `_lastCcByChannel`, `onLastCcChange`, `lastCcOnChannel`. |
| `js/autoxfade.js` (NEW)           | `AutoXfade` class. |
| `js/app.js`                       | Construct AutoXfade; wire OSC count button; mutual-exclusion; auto-mix source dropdown; persist; scene snapshot/apply hooks. |
| `js/scenes.js`                    | Round-trip auto-mix config (`getAutoXfadeConfig`/`setAutoXfadeConfig`). |
| `index.html`                      | OSC count button + `.deck-head-row2` per deck; auto-mix section. |
| `css/app.css`                     | `.deck-head-row2` style; OSC count button (reuse `.deck-density` flavour); `.status-automixer` styling. |
| `tests/rebind.spec.js`            | New case: `oscillatorCount=4` → rebound DSL contains `osc(`. |
| `tests/autoxfade.spec.js` (NEW)   | Construct + tick under each source kind; verify mutual exclusion. |

## Edge cases & error handling

- **`unparse` for oscillator override:** the existing inline-kwarg
  path in the bundle (`formatValue` → `formatOscillator`) handles
  resolved-form `{type:"Oscillator", oscType:<n>, min, max, speed}`.
  Same shape proven by the audio/midi work. If anything regresses,
  the spec test will catch it.
- **Auto-Mix with no live audio / no MIDI:** the picker still lets
  you choose those sources. With audio off, meter reads 0 → fader
  pinned at A. With MIDI off, `lastCcOnChannel` returns null →
  fader sits at 0.5 (midpoint). Both are non-broken behaviours.
- **Auto-Mix tick frequency:** drives from `compositor.onFrame`
  (same hook auto-VJ uses for its fade animation). No new
  scheduler needed.
- **Rebind with oscillatorCount > rebindable.length:** clamp via
  `min(count, picked.length)` — the algorithm already handles this.
- **Bandpass UI** stays exactly as it was; OSC count is independent.

## Open follow-ups (out of scope)

- DSL-level `audioBand.sub` enum (needs bundle change).
- Auto-Mix oscillator speed picker.
- Per-deck rebind oscillator type/speed preferences.
- UI for the operator to see the live source value (a tiny meter
  next to the source dropdown).
