<!-- repo-hero -->
<a href="https://visualize.noisedeck.app/"><img src="docs/hero.jpg" alt="VISUALIZE Music visualizer and VJ gig player" width="100%"></a>

<sub>Open source from <a href="https://noisefactor.io">Noise Factor</a> &middot; <a href="https://github.com/noisefactorllc">more projects</a></sub>

# Visualize

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![No build step](https://img.shields.io/badge/build-none-success.svg)](#run)
[![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-43853d.svg)](https://nodejs.org/)

**Ultimate music visualizer & VJ gig player.** Two decks. Crossfader. Audio-reactive shaders. MIDI control. Auto-VJ mode. Scenes. Browser-based, no install for end users.

Built on the [Noisemaker](https://shaders.noisedeck.app/) shader engine, [Noisedeck](https://noisedeck.app/) / [Polymorphic](https://polymorphic.noisedeck.app/) program library, and the [Handfish](https://handfish.noisefactor.io/) design system.

## Run

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev
```

Open <http://localhost:3007>. Click **START SET**. Click **⚙ → audio device** to enable mic/loopback input.

> Without Node, use any static server. `python3 -m http.server 3007` works too.

## Features

- **Two decks** with independent shader programs, speed control, and live preview.
- **Crossfader** with four blend curves (linear / sharp / dipped equal-power / hard cut).
- **117 curated programs** — 89 audio-reactive (use `audio(band: 0|1|2)` DSL automation), 28 base presets.
- **Audio analyzer** maps low/mid/high FFT bands into each deck's `audioState` so DSL programs using `audio()` automation react to live mic/loopback input. Device picker + sensitivity slider.
- **MIDI** with `requestMIDIAccess()` — learn any CC **or Note** to crossfader, speed A/B, or any of the 6 main FX. Faders use **soft-takeover** (no jumps after a scene/auto-mix move). FX toggles are edge-detected (momentary `flash`, latching others). Per-mapping range + invert editing, live value bars, and conflict warnings. Persisted to localStorage. Optional MIDI clock follower drives BPM.
- **Beat scheduler** with tap tempo, manual BPM input, and beat indicator. Synchronizes auto-mix and strobe.
- **Main FX**: strobe (beat-synced), invert, B&W, zoom, freeze, flash. Invert/B&W use CSS filters on the main canvas (cheap). The compositor draw loop handles strobe/flash/freeze.
- **Auto-VJ mode**: every N bars, picks a fresh random program, loads into the off-side deck, and fades to it over the chosen curve.
- **Scenes**: save a full snapshot (both decks' programs + speeds, crossfader, BPM, FX, auto-VJ config) as a named scene. Recall instantly via the panel or Shift+1…9. Stored in browser localStorage.
- **Recording**: capture the main canvas to a webm/mp4 via `MediaRecorder`. Warns at 15 min, hard-stops at 60 min to protect browser memory.
- **Output window**: dedicated popup that mirrors the main canvas for second-display / projector use.
- **Fullscreen main** (F key).
- **Keyboard shortcuts**: Space (auto-VJ), T (tap), F (fullscreen), R (record), S (settings drawer), Z/X/C (cut A / auto / cut B), 1-6 (FX), Q/W (random A/B), E / Shift+E (rebind EQ deck A / B), M / Shift+M (rebind MIDI deck A / B), arrows (nudge xfade), Shift+S (scenes drawer), Shift+1…9 (recall scene), Esc (close drawer / exit fullscreen).

## Architecture

```
js/ (core modules — abridged)
├── app.js              wiring + keyboard shortcuts
├── noisemaker/
│   ├── bundle.js       ESM re-export of shader core from shaders.noisedeck.app
│   └── deck.js         Deck = thin wrapper around CanvasRenderer
├── audio.js            SharedAudio — one analyser → many deck audioStates
├── midi.js             SharedMidi — CC routing, learn, clock-to-BPM
├── bpm.js              BeatScheduler — tap tempo + beat events
├── compositor.js       MainCompositor — 2D drawImage blend of decks + FX
├── mixer.js            MixerRenderer — third pipeline that blends A+B via a mixer effect
├── mixers.js           registry of mixer effects + DSL-arg builder
├── library.js          Library — load programs.json, render grid
├── automix.js          AutoMix — beat-driven scene-swap automation
├── autoxfade.js        AutoXfade — oscillator / audio-driven crossfader automation
├── rebind.js           rebind a program's params to audio / MIDI / oscillators
├── scenes.js           Scenes — named state snapshots (localStorage)
├── userEffects.js      portable-effect (.zip) import + IndexedDB persistence
├── deckMedia.js        per-deck camera / video / image input
├── recorder.js         Recorder — MediaRecorder of main canvas
├── output.js           OutputWindow — popup mirror for projector
├── dslSourceBuilder.js, dslHelpers.js   DSL source synthesis helpers
├── sharingLoader.js    load shared compositions via ?code=
├── thumbnailRenderer.js, thumbnailCache.js   offscreen library-tile thumbs (IndexedDB)
└── ui/                 codeEditor + mixerControls panels (plus tooltips, about-dialog, handfish-theme)
```

Each deck uses its own `CanvasRenderer` to render to a canvas visible in the deck preview pane.
A third `CanvasRenderer`, owned by the `MixerRenderer`, blends the two deck canvases through the selected mixer effect.
Once the mixer is ready, the main canvas uses a 2D context to copy that blended frame.

During boot, before the mixer compiles, the main canvas samples both deck canvases directly and blends with the active crossfade curve.
It also uses this fallback if the mixer pipeline fails.
The main canvas remains a plain 2D context in either case.
Thus, the recorder, fullscreen, and output-window features can exchange plain `HTMLCanvasElement` references.
No `OffscreenCanvas` or `captureStream` chaining is required.

## Adding programs

Programs are written in the [Polymorphic Shader Language (DSL)](https://polymorphic.noisedeck.app/). Each entry in `data/programs.json` has:

```json
{
  "title": "Bass Bloom",
  "tagline": "Kicks pulse the rotation",
  "tint": "#4ea8ff",
  "tags": ["reactive", "bass"],
  "category": "abstract",
  "dsl": "search classicNoisedeck, synth, filter\nlet bass = audio(band: 0, min: 0, max: 1)\nnoise(scale: bass).write(o0)\nrender(o0)"
}
```

- `tint` — color of the card gradient in the library panel
- `tags` — used by the search/filter box
- `category` — optional. Groups the program into a library section (`abstract`, `attractor`, `geometric`, `life`, `particles`). Programs without a category fall into the default section.
- `dsl` — multi-line DSL (use `\n` for line breaks)

For audio reactivity, declare `let name = audio(band: 0|1|2, min: ..., max: ...)`. Use the name as a parameter value. Band 0 = bass, 1 = mid, 2 = treble.

Edit the file. Reload the page. No build step is needed.

## Testing

```bash
npx playwright install   # first time only
npm test
```

`npm test` runs the Playwright suite (11 specs) against headless Chromium.
The **smoke** spec drives a full session: boot, shader load, deck compile, crossfader mixing, FX toggle, tap tempo, auto-VJ, and scene save/recall.
The other specs cover:

- Audio + MIDI and auto-xfade oscillators.
- EQ/MIDI rebind and MIDI-learn value mapping (soft-takeover + conflict detection).
- Scenes round-trip, the share-loader, and library sections.
- User-effect (.zip) import and the global typeface.
- The WebGPU renderer preference (persist + restore across reload).

These tests catch regressions in the listed features before they reach production.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Noise Factor LLC
