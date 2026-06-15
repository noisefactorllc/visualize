# Contributing to Visualize

Thanks for your interest in contributing!

## Getting Set Up

```bash
git clone https://github.com/noisefactorllc/visualize.git
cd visualize
npm install
npm run dev
```

Open http://localhost:3007 and click **START SET**. Enable audio input from the settings drawer to drive the audio-reactive programs.

## Running Tests

```bash
npx playwright install   # first time only
npm test
```

`npm test` boots a local server and runs the Playwright suite (9 specs) against headless Chromium. The smoke spec verifies the bundle loads, both decks compile shaders from the CDN, the crossfader actually mixes them, FX toggle, tap tempo registers, auto-VJ activates, and scenes persist + recall; the remaining specs cover audio + MIDI, auto-xfade oscillators, EQ/MIDI rebind, scenes round-trip, the share-loader, library sections, user-effect (.zip) import, and the WebGPU renderer preference.

## Code Style

- Vanilla JavaScript — no frameworks, no transpilers, no build step.
- ES modules (`import` / `export`). Files in this repo are served directly.
- 4-space indentation, single quotes, no semicolons at line endings (match what's already in the file).
- Prefer editing existing files over creating new ones; new top-level modules should have a one-paragraph block comment at the top explaining their job.
- Keep it small. New runtime dependencies should be discussed in an issue first — Visualize loads its only large dependency (the Noisemaker shader engine) from a CDN at runtime.

## Adding Shader Programs

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

`category` is optional and groups the program into a library section (`abstract`, `attractor`, `geometric`, `life`, `particles`); programs without one fall into the default section.

For audio-reactive programs, declare `let name = audio(band: 0|1|2, min: ..., max: ...)` and use the binding name as a parameter value. Bands: `0` = bass, `1` = mid, `2` = treble. Test new programs by reloading the page and selecting them from the library panel.

## Submitting Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes — keep PRs focused, one concern each.
3. Run `npm run lint` to syntax-check JS, and `npm test` for the smoke test.
4. Open a pull request with a short description of what changed and why. Screenshots of any UI work are appreciated.

## Reporting Issues

Open an issue on [GitHub](https://github.com/noisefactorllc/visualize/issues). Include your browser + OS, what you expected, and what you saw. For shader-render bugs, include the affected program's `title`.

## Browser Support

Visualize targets evergreen Chrome / Firefox / Safari on desktop. It relies on `requestMIDIAccess` (Web MIDI), `getUserMedia` (Web Audio), `MediaRecorder.captureStream`, and `OffscreenCanvas`-free 2D compositing. Mobile is intentionally unsupported as a workspace; phone-sized viewports show a notice.
