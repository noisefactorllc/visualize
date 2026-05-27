# UI pass + util effects — Design

Date: 2026-05-27
Status: approved (proceed autonomously)

## Goal

One focused pass that:

1. Replaces every native `<select>` in the app with handfish's
   `<select-dropdown>` so dropdown interactions don't block the
   main render thread.
2. Relocates the mixer-effect picker into the main column,
   directly under the audio meter, styled to match the mixer
   param dropdowns (same widget as #1).
3. Pulls the "output" button onto that same row, right-aligned,
   icon-only (PIP / window glyph instead of the word "output").
4. Adds a new "util" category to the top of the library:
   `Camera Input`, `Media Input`, `solid (black)`, `solid (blue)`,
   `scope`, `spectrum`, `roll`. These never get auto-rebound, and
   the two media-driven entries (Camera, Media) gain per-deck
   source pickers.
5. Bug fix: the second deck-head row (where the zoom button now
   lives) is grabbing the 1fr middle grid track and pushing
   itself away from the top. Update the grid template so the new
   row sits flush under the action rail.

## Non-goals

- No bundle changes to handfish or noisemaker.
- No DSL changes for util effects beyond the minimum needed to
  bind them.
- No new auto-VJ feature for util programs — they're skipped
  from the auto-rebind path entirely.

## Task 1 — Native `<select>` → `<select-dropdown>`

The handfish `<select-dropdown>` web component is a drop-in
substitute: same `<option>` children, same `value` getter/setter,
same `change` event bubbling. The custom element is already
registered by the handfish bundle (which is loaded for the deck
DSL editor + AboutDialog).

Selects to convert:

| Location | id |
|----------|----|
| BPM controls | `#bpm-divider` |
| Center controls — mixer picker | `#mixer-effect` (also relocated, task 2) |
| Center controls — fade curve | `#automix-curve` |
| Status bar — auto-mix source | `#automixer-source` |
| Status bar — auto-VJ cycle | `#automix-bars` |
| Settings — audio device | `#audio-device` |
| Settings — main resolution | `#main-resolution` |
| Theme picker (mounted programmatically by `mountThemePicker`) | (rebuilt to use `select-dropdown`) |

For each: change tag from `<select>` to `<select-dropdown>`,
remove width-related CSS that assumed the native form (the
component's `min-width: 5em` handles it). Any code that wrote
`sel.value = X` keeps working.

**One known incompatibility:** the audio-device picker
re-renders `<option>` children dynamically via
`refreshAudioDevices()` and currently relies on the rebuild
happening before re-selecting. The `<select-dropdown>` parses
its options on `connectedCallback` so dynamic re-population
needs to either (a) clear children then re-add then call a
re-parse, or (b) detach + reattach. Path (a) is documented in
the handfish source via `_parseOptionChildren`; we'll call it
manually after rebuild. If that helper isn't on the public
surface (it isn't), the simplest robust path is to fully replace
the element each refresh (clone with `cloneNode(false)`, attach
new `<option>` children, swap in DOM, rewire listener).

For the audio-device specifically we'll go the "rebuild + swap"
route. The other selects are static-option so they need nothing
beyond the tag rename.

## Task 2 — Move mixer-effect picker

Current location: inside `.controls-transport > .controls-center
> .mixer-picker`, between the speed-A control and the
crossfader.

New location: a new row inside `.main`, between `.main-head`
(the audio meter strip) and `.main-canvas-wrap`. The row also
holds the relocated output button (task 3).

```
.main
├── .main-head             (audio meters)
├── .main-toolbar  ← NEW   (mixer picker left, output button right)
├── .main-canvas-wrap      (canvas)
├── .main-fx               (fx buttons)
└── .mixer-controls        (param panel below canvas)
```

The mixer picker becomes a `<select-dropdown>` (per task 1)
styled to match the mixer-param dropdowns in
`MixerControls`. Those use the handfish default
`<select-dropdown>` styling already — same component, same
visual.

The handler stays in `wireMixerPicker(mixer)` (no rename needed
beyond the tag swap).

## Task 3 — Move "output" button

The existing `#output-window` button sits at the right end of
the status bar with the text label "output". Move it into the
new `.main-toolbar` row, right-aligned. Replace the text with a
material symbols glyph — `picture_in_picture_alt` is the
clearest "open in a popup window" icon and is in the
Material Symbols Outlined font we already load.

The click handler stays bound to `outputWin.toggle()`.

Resulting `.main-toolbar` markup:

```html
<div class="main-toolbar">
    <select-dropdown id="mixer-effect" class="mixer-select" title="Center mixer effect (noisemaker mixer/*)"></select-dropdown>
    <button id="output-window" class="main-output-btn icon-button" title="Open mirrored output window">
        <span class="icon">picture_in_picture_alt</span>
    </button>
</div>
```

CSS: `display: flex; justify-content: space-between; align-items:
center;`. The select fills naturally (no flex-grow needed; the
button stays at its natural size on the right).

## Task 4 — Util library entries + per-deck media UI

### Library entries

Add 7 entries at the **start** of `data/programs.json`. They use
a new `util` tag so the library sort/render can group them at
the top, and so the rebind module + AutoMix know to skip them.

| Title | DSL | Notes |
|-------|-----|-------|
| `Camera Input` | `search synth\nmedia().write(o0)\nrender(o0)` | needs camera source on the deck |
| `Media Input`  | `search synth\nmedia().write(o0)\nrender(o0)` | needs file source on the deck |
| `solid (black)` | `search synth\nsolid(color: #000000).write(o0)\nrender(o0)` | |
| `solid (blue)`  | `search synth\nsolid(color: #4a88fb).write(o0)\nrender(o0)` | |
| `scope`         | `search synth\nscope().write(o0)\nrender(o0)` | uses live audio |
| `spectrum`      | `search synth\nspectrum().write(o0)\nrender(o0)` | uses live audio |
| `roll`          | `search synth\nroll().write(o0)\nrender(o0)` | uses live MIDI |

Each entry: `{ title, tagline, tint, tags: ['util', ...], dsl }`
plus optional `mediaSource: 'camera'|'file'` for the Camera and
Media entries — the app uses this to know which picker to wire
up on the deck.

### Library sort

Existing `Library` renders programs in their JSON order. We add
a stable sort that puts `util`-tagged programs first, preserving
existing order otherwise. (Touches `library.js _matches` /
`render` paths.)

### Per-deck media picker UI

A new `.deck-media-row` rendered inside `.deck-head-row2`
(reusing the same below-action-rail row that holds the density
button). Visible **only** when the deck's current program is
`Camera Input` or `Media Input`.

- For `Camera Input`: a `<select-dropdown id="deck-X-camera">`
  populated with `enumerateDevices()` videoinput entries; on
  change, swaps the deck's camera stream.
- For `Media Input`: a button "choose file" + filename display.
  Opens a hidden `<input type="file" accept="image/*,video/*">`
  trigger.

### Media wiring (`js/deckMedia.js`)

A new per-deck controller. One instance per Deck. API:

```js
class DeckMedia {
    constructor({ deck, audio })
    async setCamera(deviceId)          // getUserMedia + bind
    async setFile(file)                 // file → <video>|<img> → bind
    stop()                              // detach, stop streams
    get active()                        // 'camera' | 'file' | null
    get currentLabel()                  // deviceLabel or file.name
}
```

Internally:
- Holds a hidden `<video autoplay muted playsinline>` or `<img>`
  element.
- Discovers the deck pipeline's `imageTex` step index via
  `extractEffectsFromDsl(deck._currentDsl)` + matching
  `effectKey === 'synth/media'`.
- Per-frame, calls `deck._renderer.updateTextureFromSource(...)`
  with the live element. We piggyback on the deck's renderer
  rAF (it already loops via `_renderer.start()`); since
  `updateTextureFromSource` is cheap on a stable source, we
  hook into `compositor.onFrame` so the call rate matches the
  visible frame rate.

The mixer already does the exact same `updateTextureFromSource`
dance against `imageTex_step_N` — we reuse the same pattern.

### Auto-rebind skip

`automix.js` (the auto-VJ module) calls `rebind.rebindEq(deck,
program)` after each load. Add a guard:

```js
if (this._autoRebindEq && this.rebind && !isUtilProgram(program)) {
    this.rebind.rebindEq(deck, program)
}
```

`isUtilProgram(program)` returns `program?.tags?.includes('util')`.
Lives in the rebind module (or as a tiny helper in automix —
either works).

The manual `EQ ↻` / `MIDI ↻` buttons still fire — operators can
hit them if they want. With util programs having 0–1 numeric
params, most rolls will toast `no rebindable params` and be
no-ops, which is the right behaviour.

## Task 5 — Deck grid fix

`.deck` is currently `grid-template-rows: auto 1fr auto`. With
the second head row added, the implicit auto-placement assigns
`.deck-head-row2` to the 1fr middle track, blowing it up.

Fix: `grid-template-rows: auto auto 1fr auto`. That puts
deck-head + deck-head-row2 in the two leading `auto` tracks,
the middle 1fr stays the canvas area (where the absolutely-
positioned canvas-wrap centers itself), and the trailing auto
holds the meta strip.

The deck-content (editor) is also a flow child — at the moment
it lives between canvas-wrap and meta, so under 4 tracks it
ends up in the trailing 1fr-or-auto position. To keep the
original behaviour, the deck-content needs to NOT compete with
canvas-wrap. We solve this by explicitly placing deck-content
in the 1fr track via `grid-row: 3 / 4`. (Cleanest: explicitly
place every child to avoid any future implicit-flow surprises.)

Explicit placement:

```css
.deck-head      { grid-row: 1; }
.deck-head-row2 { grid-row: 2; }
.deck-content   { grid-row: 3; }    /* canvas-wrap overlays here */
.deck-meta      { grid-row: 4; }
```

`.deck-canvas-wrap` stays `position: absolute` (no grid-row
needed, it overlays).

## Files

| File | Change |
|------|--------|
| `index.html` | `<select>` → `<select-dropdown>` everywhere; new `.main-toolbar` between `.main-head` and `.main-canvas-wrap`; relocate `#output-window` into it; remove the old `.mixer-picker` from `.controls-center`. |
| `css/app.css` | `.deck` grid template update; `.deck-head-row2` row layout polish (top-aligned button); `.main-toolbar` styling; old `.mixer-picker` rules dropped or no-op'd; `#output-window` icon-only style. |
| `js/handfish-theme.js` | Theme picker uses `<select-dropdown>` instead of native `<select>`. Public API (returned element) unchanged. |
| `js/app.js` | Audio-device refresh now rebuilds the picker via clone+swap pattern; output-window click wiring moves to its new id-only path (no change required, id stays the same). |
| `js/library.js` | Stable sort: `util`-tagged programs first. |
| `js/rebind.js` | `isUtilProgram(program)` helper exported. |
| `js/automix.js` | Skip auto-rebind when program is util. |
| `js/deckMedia.js` (NEW) | `DeckMedia` controller per deck. |
| `js/noisemaker/deck.js` | Helper to detect "does this DSL use synth/media" (for the app to gate the media picker UI). |
| `data/programs.json` | 7 util entries prepended. |
| `tests/rebind.spec.js` | new case: util program + autorebind → no rebind fired. |
| `tests/ui-selects.spec.js` (NEW) | smoke: every former-`<select>` exists as `select-dropdown` and responds to value sets / change events. |

## Edge cases & error handling

- **Audio-device select rebuild:** clone+swap keeps the same id
  + event listener. The change-listener attaches to the new node
  after swap.
- **Util programs in scene snapshot:** `program.title` is
  captured; `library.byTitle` still finds them. Their DSL has
  no audio bindings to round-trip, so the rebind state stays at
  defaults (empty overrides). No change needed.
- **Media program with no source picked yet:** `media()` shows
  whatever default the bundle renders for an unbound `imageTex`
  (usually the deck `bgColor`). Operator picks camera/file from
  the deck row; the visual starts immediately.
- **Multiple decks both running camera:** each `DeckMedia`
  manages its own `MediaStreamTrack`; getUserMedia returns a
  fresh stream per call.
- **Camera permission denied:** toast the error; the deck stays
  on whatever was running before.

## Open follow-ups (out of scope)

- A "media library" of saved file picks.
- WebGPU-only path for media (current path is WebGL via
  updateTextureFromSource — already abstracted, no extra work).
- Util-only programs surfacing in scene panels with a different
  visual chip.
