/**
 * What each VisualizeAgent command does and returns, in the groups and order
 * that llms-full.txt lists them. scripts/build-llms-full.mjs renders the
 * command reference from this file and SCHEMAS, and
 * tests/agent-llms.node-test.js fails when they disagree.
 *
 * `remote: false` marks a command that needs the person at the browser, or
 * that reads or changes what this browser stores for the person (scenes,
 * user effects, the Auto-VJ pool). Everyone in a Seance session reads every
 * answer and any writer can send requests, so a session refuses these
 * commands with REMOTE_UNAVAILABLE.
 *
 * @module agent/descriptions
 */

export const COMMAND_GROUPS = [
    {
        title: 'Read state',
        commands: {
            getState: {
                does: 'Returns the state snapshot. Every envelope already includes it in `state`.',
                returns: 'the snapshot',
            },
            getProgram: {
                does: 'Returns the program text of deck `deck`, as its editor shows it, and whether it is the program that runs. Through a session it returns the text that the session holds for the deck: a change shows once the tab has published it, and a draft that stays out of the session does not show. A curated library program reads in the `curated` namespace. An image the program shows is named `image:<sha256>`.',
                returns: '`{ dsl, running }`',
            },
        },
    },
    {
        title: 'Programs',
        commands: {
            validateProgram: {
                does: 'Compiles `dsl` without applying it. Both decks compile a program the same way. Through a session, a program that names the `user` namespace gets a `USER_EFFECT` error diagnostic.',
                returns: '`{ valid, diagnostics }`',
            },
            setProgram: {
                does: 'Compiles `dsl` and runs it on deck `deck`, like a program typed into that deck\'s editor. A program that does not compile changes nothing and fails with INVALID_PROGRAM. Each `image:<sha256>` the program names must be in the online session, or, in the browser, in a deck or this browser\'s scene images. While Visualize is online, the program goes to the session document `deck:A` or `deck:B`.',
                returns: '`{ applied: true, diagnostics }` (warnings only)',
            },
        },
    },
    {
        title: 'Effects',
        commands: {
            searchEffects: {
                does: 'Lists effects whose id, description or tags contain `query`. `namespace` keeps one namespace. The list includes the `curated` effects that library programs use and, in the browser only, the `user` effects installed in this browser.',
                returns: '`{ total, effects: [{ effectId, namespace, name, description, tags }] }`',
            },
            getEffectDefinition: {
                does: 'Returns the DSL function name and the parameters of one effect. A session cannot read `user` effects.',
                returns: '`{ effectId, func, namespace, description, params: [{ name, type, default, min?, max?, enum?, choices?, label? }] }`',
            },
        },
    },
    {
        title: 'Library',
        commands: {
            searchLibrary: {
                does: 'Lists library programs whose title, tagline, tags or author contain `query`. `category` keeps one library section: `user`, `curated`, `abstract`, `attractor`, `geometric`, `life`, `particles`, `built-in`, `noiseblaster` or `util`. The `user` section, made from the user effects installed in this browser, is listed only in the browser.',
                returns: '`{ total, programs: [{ title, tagline, category, tags, autoVj }] }`, where `autoVj` tells whether Auto-VJ and `randomize` can pick the program. Through a session `autoVj` is left out',
            },
            getLibraryProgram: {
                does: 'Returns one library program with its DSL text, as a deck editor shows it after the program loads.',
                returns: '`{ title, tagline, category, tags, autoVj, dsl }`',
            },
            loadProgram: {
                does: 'Loads the library program titled `title` into deck `deck`, like the A or B button on its card.',
                returns: '`{ deck, title }`',
            },
            randomize: {
                does: 'Loads a random program from the Auto-VJ pool into deck `deck`, or into both decks, like the shuffle buttons. A deck gets a different program from the one it runs.',
                returns: '`{ programs }`, the loaded titles by deck, such as `{ A: "..." }`',
            },
            setAutoVjPool: {
                does: 'Includes or excludes one library program from the Auto-VJ pool, like the switch on its card. Utility programs are never in the pool.',
                returns: '`{ title, included }`',
                remote: false,
            },
        },
    },
    {
        title: 'Decks',
        commands: {
            setDeck: {
                does: 'Changes the controls of deck `deck`. Give only the fields you change. `speed` multiplies the playback speed. `density` is the render resolution of the deck in percent of the output; `auto` renders particle and simulation programs at 50% and other programs at 100%. `bandpass` and `oscillators` shape the next `rebind`: with `bandpass`, an EQ rebind uses only the audio bands that the program is tagged with; `oscillators` is how many of the rebound parameters get an `osc()` instead of `audio()` or `midi()`.',
                returns: '`{ deck, speed, density: { mode, value }, bandpass, oscillators }`',
            },
            rebind: {
                does: 'Reshuffles the audio (`eq`) or MIDI (`midi`) bindings of deck `deck`, like its rebind buttons. Two to four numeric parameters of the program get new `audio()` or `midi()` automations. The program text changes; `getProgram` returns it.',
                returns: '`{ deck, kind, applied }`, where `applied` is false when the program has no parameter to rebind',
            },
        },
    },
    {
        title: 'Crossfader and mixer',
        commands: {
            setCrossfader: {
                does: 'Moves the crossfader and sets its curve and fade time. Give only the fields you change. `position` 0 shows deck A and 1 shows deck B. Moving it stops a running fade and holds Auto-VJ back for a moment, like the slider. `fadeSeconds` is the duration of `autoFade` and of Auto-VJ transitions.',
                returns: '`{ position, curve, fadeSeconds, live }`',
            },
            crossfade: {
                does: '`cutA` and `cutB` jump the crossfader to one deck. `autoFade` fades to the deck that is not live over the fade time. The command returns when the fade starts.',
                returns: '`{ action, target, seconds }`',
            },
            getMixer: {
                does: 'Returns the mixer effect that blends deck A with deck B, the effects you can choose, and the parameters of the current effect. The crossfader drives the parameter named by `driver`; the others are in `params`.',
                returns: '`{ effect, driver, effects: [{ effect, label, driver }], params: [{ name, type, value, default, min?, max?, choices? }] }`',
            },
            setMixer: {
                does: 'Selects the mixer effect and sets its parameters, like the mixer picker and the controls under the output. A new `effect` starts from its defaults. `params` maps parameter names from `getMixer` to values: a number in range, or a choice name. An unknown name or a bad value fails the command and changes nothing.',
                returns: 'the same result as `getMixer`',
            },
        },
    },
    {
        title: 'Output effects',
        commands: {
            setFx: {
                does: 'Turns output effects on or off, like the FX buttons. Give only the effects you change. `strobe` flashes white on every beat and can trigger photosensitive epilepsy. `invert`, `bw` (black and white) and `zoom` are display effects on the output canvas. `freeze` holds the current output frame. `flash: true` fires one white flash.',
                returns: '`{ strobe, invert, bw, zoom, freeze }`',
            },
        },
    },
    {
        title: 'Automation',
        commands: {
            setAutoVj: {
                does: 'Turns Auto-VJ on or off and sets its cycle length in bars: 1, 2, 4, 8, 16 or 32. Every cycle, Auto-VJ loads a random pool program into the deck that is not live and fades to it. Turning Auto-VJ on turns Auto-Mix off. The cycle length is also the period of an Auto-Mix oscillator.',
                returns: '`{ enabled, bars }`',
            },
            setAutoMix: {
                does: 'Turns Auto-Mix on or off and sets its source. Auto-Mix moves the crossfader from one source: an oscillator with one period per cycle, an audio band level, or the last control change on a MIDI channel. Turning Auto-Mix on turns Auto-VJ off.',
                returns: '`{ enabled, source }`',
            },
        },
    },
    {
        title: 'Tempo, audio and output',
        commands: {
            setTempo: {
                does: 'Sets the tempo, like the tempo bar. Give only the fields you change. `bpm` is beats per minute. `divider` is the number of bars in one deck loop: 1, 2, 4, 8, 16 or 32. `tap: true` taps the tempo once; taps less than two seconds apart set the BPM from their spacing. `resetPhase: true` starts the bar now. With `followMidiClock`, an incoming MIDI clock sets the BPM.',
                returns: '`{ bpm, divider, followMidiClock }`',
            },
            setAudio: {
                does: 'Sets the audio sensitivity, the gain applied to the person\'s audio input before its levels drive `audio()` bindings and Auto-Mix. The browser stores it.',
                returns: '`{ enabled, sensitivity }`',
                remote: false,
            },
            setOutput: {
                does: 'Sets the output resolution of both decks, the mixer and the output canvas.',
                returns: '`{ width, height, backend }`',
            },
            setRenderer: {
                does: 'Stores whether this browser prefers WebGPU to WebGL2. It takes effect when the page reloads.',
                returns: '`{ preferWebGPU, backend }`, where `backend` is the renderer that runs now',
                remote: false,
            },
        },
    },
    {
        title: 'Scenes',
        commands: {
            listScenes: {
                does: 'Lists the saved scenes in slot order. Shift with the slot number recalls slots 1 to 9.',
                returns: '`{ total, max, scenes: [{ slot, name, bpm, fx, decks: { A, B } }] }`, with the program titles of the decks and the names of the active effects',
                remote: false,
            },
            scene: {
                does: '`save` stores the state of both decks, the crossfader, tempo, effects, mixer and automation as scene `name`, and replaces a scene with that name. `recall` restores scene `name`. `rename` gives scene `name` the name `newName`. `delete` removes scene `name` without a confirmation. Scenes are stored in this browser.',
                returns: '`{ action, name }`, plus `newName` for `rename`. A recall that could not restore everything lists the problems in `warnings`',
                remote: false,
            },
        },
    },
    {
        title: 'User effects',
        commands: {
            listUserEffects: {
                does: 'Lists the custom effects installed in this browser. Programs call them in the `user` namespace.',
                returns: '`{ total, effects: [{ effectId, name, installedAt }] }`',
                remote: false,
            },
        },
    },
    {
        title: 'Images',
        commands: {
            getThumbnail: {
                does: 'Returns an image of the output canvas, or with `source` of one deck canvas. The output image shows the mix, strobe and flash. It does not show `invert`, `bw` and `zoom`, which are display effects on the canvas element. Through a Seance session the image is added to the session as its own bytes, and `image` replaces `bytes`; while a deck shows live camera or video input, a session cannot take an image of that deck or of the output (`REMOTE_UNAVAILABLE`).',
                returns: '`{ bytes, mimeType, width, height, source }`, with `bytes` in base64. Through a session: `{ image: { id, mimeType, bytes }, mimeType, width, height, source }`, where `image.bytes` is the byte count',
            },
        },
    },
    {
        title: 'Inputs and recording',
        commands: {
            setAudioInput: {
                does: 'Turns audio input on with the default device, or off, like the audio button in the status bar. Turning it on asks the person for microphone permission.',
                returns: '`{ enabled }`, false when the person refused permission',
                remote: false,
            },
            setMidiInput: {
                does: 'Turns MIDI input on or off, like the MIDI button in the status bar. Turning it on asks the person for MIDI permission.',
                returns: '`{ enabled, inputs }`',
                remote: false,
            },
            record: {
                does: 'Starts or stops recording the output, like the record button. Stopping saves the recording as a browser download.',
                returns: '`{ recording }`',
                remote: false,
            },
        },
    },
]
