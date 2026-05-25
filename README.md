# Visualize

**Ultimate music visualizer & VJ gig player.** Two decks. Crossfader. Audio-reactive shaders. MIDI control. Auto-VJ mode. Browser-based, no install.

Built on the [Noisemaker](https://shaders.noisedeck.app/) shader engine, [Noisedeck/Polymorphic](https://polymorphic.noisedeck.app/) program library, and the [Handfish](https://handfish.noisefactor.io/) design system.

## Run

```
python3 -m http.server 8765
# open http://localhost:8765/
```

Click **START SET**, then **⚙ → audio device** to enable mic/loopback input.

## Features

- **Two decks** with independent shader programs, speed control, and live preview.
- **Crossfader** with four blend curves (linear / sharp / dipped equal-power / hard cut).
- **35 curated programs** — 12 audio-reactive (use `audio(band: 0|1|2)` DSL automation), 23 base presets.
- **Audio analyzer** maps low/mid/high FFT bands into each deck's `audioState` so DSL programs using `audio()` automation react to live mic/loopback input. Device picker + sensitivity slider.
- **MIDI** with `requestMIDIAccess()` — assign any CC to crossfader, speed A/B, or master FX via a learn workflow. Persisted to localStorage. Optional MIDI clock follower drives BPM.
- **Beat scheduler** with tap tempo, manual BPM input, and beat indicator. Synchronizes auto-mix and strobe.
- **Master FX**: strobe (beat-synced), invert, B&W, zoom, freeze, flash. Invert/B&W use CSS filters on the master canvas (cheap); strobe/flash/freeze are handled inside the compositor draw loop.
- **Auto-VJ mode**: every N bars, picks a fresh random program, loads into the off-side deck, and fades to it over the chosen curve.
- **Recording**: capture the master canvas to a webm via `MediaRecorder`.
- **Output window**: dedicated popup that mirrors the master canvas for second-display / projector use.
- **Fullscreen master** (F key).
- **Keyboard shortcuts**: Space (auto-VJ), T (tap), F (fullscreen), R (record), Z/X/C (cut A / auto / cut B), 1-6 (FX), Q/W (random A/B), arrows (nudge xfade).

## Architecture

```
js/
├── app.js              wiring + keyboard shortcuts
├── noisemaker/
│   ├── bundle.js       ESM re-export of shader core from shaders.noisedeck.app
│   └── deck.js         Deck = thin wrapper around CanvasRenderer
├── audio.js            SharedAudio — one analyser → many deck audioStates
├── midi.js             SharedMidi — CC routing, learn, clock-to-BPM
├── bpm.js              BeatScheduler — tap tempo + beat events
├── compositor.js       MasterCompositor — 2D drawImage blend of decks + FX
├── library.js          Library — load programs.json, render grid
├── automix.js          AutoMix — beat-driven scene-swap automation
├── recorder.js         Recorder — MediaRecorder of master canvas
└── output.js           OutputWindow — popup mirror for projector
```

Both decks render via their own `CanvasRenderer` to a hidden-ish offscreen-style canvas (technically visible in the deck preview pane). The master is a 2D context that samples both deck canvases each frame and blends with the active crossfade curve. This means the recorder, fullscreen, and output-window features can all hand around plain `HTMLCanvasElement` references — no `OffscreenCanvas` or `captureStream` chaining required.

## Adding programs

Programs are written in the [Polymorphic Shader Language (DSL)](https://polymorphic.noisedeck.app/). Each entry in `data/programs.json` has:

```json
{
  "title": "Bass Bloom",
  "tagline": "Kicks pulse the rotation",
  "tint": "#4ea8ff",
  "tags": ["reactive", "bass"],
  "dsl": "search classicNoisedeck, synth, filter\nlet bass = audio(band: 0, min: 0, max: 1)\nnoise(scale: bass).write(o0)\nrender(o0)"
}
```

- `tint` — color of the card gradient in the library panel
- `tags` — used by the search/filter box
- `dsl` — multi-line DSL (use `\n` for line breaks)

For audio reactivity, declare `let name = audio(band: 0|1|2, min: ..., max: ...)` and use the name as a parameter value. Band 0 = bass, 1 = mid, 2 = treble.

Edit the file and reload — no build step.
