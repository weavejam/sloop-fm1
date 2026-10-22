# SLOOP for tuttidaw (`web/plugin/`)

weavejam's plugin build of [SLOOP](https://github.com/isod89/sloop-fm1) by isod89 for
[tuttidaw](https://tuttidaw.com) (protocol `tutti-plugin/0`, an "L0 offline plugin"): the whole SLOOP firmware in
WebAssembly as a device in the page, SLOOP's own web editor (`web/editor.html`) driving it as it drives an FM-1, and a
headless renderer that renders SLOOP's song (the arranger), a section, the working pattern, or MIDI from tuttidaw,
offline into a mix and four stems, at tuttidaw's tempo. GPL-3.0-only like the rest of SLOOP. **Not affiliated with or
endorsed by M-VAVE or Hügelton Instruments.** The design (protocol code, renderer, Worker, resampler, state, site,
CI) is ported from weavejam's FM-1 plugin built from Felucca ([weavejam/Felucca](https://github.com/weavejam/Felucca)
`web/plugin/`).

## Build, run, test

```
python3 tools/build.py --gen-only   # build/gen (fonts, icons, tables, samples); no JieLi toolchain or SDK needed
web/plugin/build.sh                 # -> build/plugin-wasm/sloop.wasm, build/plugin-site-preview/ (needs emcc, node)
PLUGIN_CHANNEL=production web/plugin/build.sh   # -> build/plugin-site/ (the one to deploy)
node web/plugin/plugin_test.mjs [build/plugin-wasm/sloop.wasm]
node web/plugin/dev/serve.mjs       # the preview site on http://127.0.0.1:8791/, a stand-in host on http://localhost:8792/
```

`tools/build.py --gen-only` needs Pillow with Raqm (FriBiDi), as `./build.sh` does. Emscripten 6.0.11 (the version the
workflow pins). `tests/run_preview_tests.sh` runs `plugin_test.mjs` too when the plugin's wasm is built. The site is
static (Cloudflare Pages: `_headers` sets the manifest's CORS and `no-cache`, the CSPs, the wasm's type).

**Channels.** `PLUGIN_CHANNEL` (`production`, `preview`, or both separated by a space; default `preview`) decides which
pages may embed the build, and `site.mjs` writes that one list into both the page's `plugin/build-info.js`
(`EMBEDDERS`, the handshake's check) and `_headers`' `frame-ancestors`:

| Channel | Embedders | Out |
| --- | --- | --- |
| `production` | exactly `https://tuttidaw.com`, `https://www.tuttidaw.com` | `build/plugin-site/` |
| `preview` | those and `http://localhost:<any port>` (tuttidaw's dev server, `dev/`) | `build/plugin-site-preview/` |

Deployed (Cloudflare Pages): production at `https://sloop.plugins.tooljams.com`, preview at
`https://sloop-preview.plugins.tooljams.com` (the manifest: `/tutti-plugin.json` on each).

`.github/workflows/plugin-site.yml` builds both from one wasm, runs the tests, and keeps the production site as an
artifact on a push to main (the only event a deployment may come from), the preview site on a pull request.

**Source links.** The manifest's `source`, the credits page and the page's bar link the exact commit built
(`<repo>/tree/<sha>`). With no commit, or a tree with changes not in it, the build fails; `PLUGIN_ALLOW_DIRTY=1` lets a
preview through, its version marked `.dirty` (never a production build).

**The page's CSP** (`/plugin/*`): `default-src 'none'; script-src 'self' 'sha256-<the editor's inline script>'
'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;
img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'none'; form-action 'none'; object-src 'none';
base-uri 'self'; frame-ancestors ...`. `site.mjs` hashes the editor's one inline script as built (and fails if there is
another inline script or an inline handler).

| File | What |
| --- | --- |
| `sloop_plugin.c` | the firmware (`src/felucca.c`'s sources) against a simulated FM-1, built with `SLOOP_TUTTI`: the device (clock from the audio, the main loop, the editor's SysEx in and out, a RAM NOR flash), the host's tempo, the headless render, use B's MIDI, the stems, the state snapshot, the preview's seek |
| `renderer.js` | a render: the time map's geometry, the request checked, a fresh instance per render, mix and stems, 48 kHz |
| `resample.js` | 44.1 kHz to 48 kHz (Felucca's, as is) |
| `state.js` | the state blob (the flash's storage sectors, the plugin's meta) |
| `protocol.js` | the session: handshake, messages, state machine, credited chunks (Felucca's, as is) |
| `engine.js` | state revisions, renders of a revision, the live SLOOP |
| `tutti-host.js` | the editor's MIDI port to the page's SLOOP (a classic script, before the editor's) |
| `tutti.js`, `worklet-tutti.js`, `render-worker.js` | the page: the editor on the page's SLOOP with the protocol, the device in an AudioWorklet, renders in a Worker |
| `site.mjs`, `build.sh` | the static site, the manifest |
| `dev/` | a stand-in host and a server for development |
| `plugin_test.mjs` | the tests (Node) |

## The page

The plugin's page is **SLOOP's own web editor** (`web/editor.html`: sound, sequencer, tracks, song, library, samples,
drum kit, drum synth, song & sections, settings, theme, LIVE), not a new UI. It talks the editor protocol
(`web/EDITOR_PROTOCOL.md`, SysEx) to a port named "SLOOP (this page)": `tutti-host.js` gives it a Web MIDI access with
that one port pair (`window.sloopHost`; four small hooks in `editor.html` use it when it is there, nothing changes
without it), and behind the port runs the firmware's own `editor.c` in the page's SLOOP. So everything the editor
does with an FM-1 it does here, with the firmware's answers. The bar at the top adds: what a render plays, **render to
tuttidaw** (`commit`, the mix or with the stems), the volume (MASTER), credits and the source.

**Any frame size** (`tutti.js layout`). tuttidaw opens the plugin's window wide on a desktop (about
min(1280, viewport) x the viewport's height) and lets the user drag it to any size from 480 x 360; on a phone it is a
tall sheet. The page fills the frame and never scrolls as a whole: the editor is scaled to the frame with CSS `zoom`
(layout units: crisp, and the hit targets are where they are drawn), and each of its columns scrolls on its own,
without scrollbars.

- **Wide** (aspect >= 1.3 and >= 900 px wide): the side bar, the selected page, and **beside it a second page of the
  editor's**: the step sequencer by default (the pattern of the selected track next to its sound), or the mixer
  (TRACKS: the four tracks' levels, pans, mutes) or the song order, chosen in the bar ("beside"; kept in this
  browser). The layout's natural size is 1440 x 820, scaled to fit (0.6 .. 1.5). The editor's `beside` hook
  (`HOST.attach`) shows that page's panel too; `tutti.js` places it in the second column.
- **Otherwise** the editor as it is (its desktop layout, or under 860 px its phone layout with the side bar on top),
  scaled down to fit a small frame (not under 0.7); a frame under ~640 px high (at that zoom) keeps only the pages' row
  of the top bar.
- `resize` is sent once connected with the wide layout's size (1440 x 820), as the size this page prefers; the page
  fits whatever size the host gives it. The same layout runs when the page is opened by itself.
- Screenshots (`screenshots/`, Chromium, the page by itself): 1280 x 820, 1600 x 900 (wide; the mixer beside at
  1280 x 820 too), 900 x 700, 480 x 360, 390 x 780.

- In tuttidaw's frame: the handshake (accepted from the build's channel's embedders, from the parent window only),
  then `init`. Edit mode: SLOOP starts with the state (on its own where the browser lets the frame play sound, else
  with "start SLOOP"), the editor connects to it. It saves nothing in this browser; tuttidaw's transport drives its
  preview (listen-only: it starts at `atEpochMs` less the output latency, a drift of over 20 ms re-seeks; a seek runs
  the sequencer, the song's sections with it, up to the position at most 1024 blocks per audio quantum, silent
  meanwhile). Renders run in a Worker, so SLOOP and the editor stay live. `mode: "render"` is headless: no SLOOP in the
  page, no audio, only renders.
- **Render to tuttidaw** asks for one pass of what plays: the song's bars (`fromBeat` 0, `toBeat` 4 x the bars of the
  song order), or the working pattern's (or a section's) longest track.
- **Tempo while hosted.** The host's tempo is a runtime value: SLOOP's own BPM (in the state, the editor's BPM, TAP)
  stays as it was, so tuttidaw's tempo never changes the state or starts a new revision; it has no audible effect in
  tuttidaw.
- **Sessions.** As Felucca's: a request keeps the session it came in with; what it sends after that session has ended
  goes nowhere; a render still running in the Worker when the next session renders is stopped with its Worker.
- Opened by itself (or not connected within 4 s): SLOOP and the editor on their own, the state kept in this browser
  (`localStorage`), a note; a `connect` after that is refused (reload the frame to connect).
- Not here: the device's screen and panel (the editor is the UI; the screen's icon atlas, a Felucca Asset that is not
  under the GPL, is not built in: `FELUCCA_ICONS=0`), the editor's "record the set" (it records the FM-1's USB audio
  through the microphone permission, which the frame does not have), the installer and firmware updates, files saved
  from tuttidaw's frame (a sandboxed frame has no downloads; opened by itself they work).
- `/credits.html`: who made what, the licences (GPL-3.0-only; CC0 samples, Terminus OFL, Fukiai MIT, msfa Apache-2.0,
  DaisySP / Rings MIT), the source of the build, the non-affiliation notice.

## What the firmware does differently (`SLOOP_TUTTI`)

Only builds that define `SLOOP_TUTTI=1` (this plugin's) change; the hardware build (`src/felucca.c`), the host tests
(`tests/hostsim.c`, `tests/regress.c`'s golden renders) and the browser preview (`firmware/host/preview.c`, its wasm
byte for byte) preprocess to the same code as without it.

- **Fractional tempo.** SLOOP's transport clock counts units of a sample at 1 BPM (core.h `BEAT_U`), so at a whole BPM
  it has no drift; but `G_BPM` is an integer (40 .. 240), and every block advances it by `n x G_BPM`. Hosted, the
  host's tempo is a BPM in Q32 (`tutti_bpm_q32`) and a block advances the clock by `n x BPM` with the fraction of a
  unit carried to the next block (`tutti_units`), so after any number of samples the clock is within one unit (1 / BPM
  of a sample) of the exact position: the steps of every track, the arp, the rolls, the DUCK, and the arranger's bars
  (`arr_elapse`, it counts the same units) with it. The SLICER's own step clock carries its fraction the same way;
  what is timed in samples from the tempo (the delay's TIME, LFO and ENV SYNC, TEXTURE's bar, the punch-in loops)
  converts units to samples at the exact tempo (`TEMPO_SAMPLES`). `plugin_test.mjs`: 64 bars at 123.45 BPM, every bar
  line on the clock within 0.01 samples of `bar x 4 x 60 / bpm x 44100`.
- **Per-unit sums.** Each render unit (the three synth parts, the drum track) is mixed into a `mixacc_t` of its own
  (its dry L / R and its chorus, delay and reverb sends) and then added into the mix's (`fx.c tutti_unit`). The sums
  are integers, so the mix is bit for bit the same. The DAC limiter's gain per sample is kept as well (`tutti_lim`).

## Stems and the mix

- `mix` is SLOOP's master output exactly as the instrument makes it (the buses, TEXTURE, DUST, the punch-in FX (none
  in a render), the master filter, MASTER, the DC blocker, LOW CUT, the look-ahead limiter, the output knee), with
  MASTER at its top (the page's volume is the live SLOOP's only). The metronome's click is never in a render.
- `t1`, `t2`, `t3` and `drums` are each render unit's dry signal (after its DIST, INSERT, SLICER, FILTER, level, pan,
  mute and the DUCK) plus **its own share of the buses**: an instance of the firmware of its own runs the chorus,
  delay and reverb on that unit's sends only, then the master filter, MASTER, the DC blocker and LOW CUT (each with
  its own state), the limiter's block of look-ahead, then **the mix's limiter gain** at that sample (so a stem is as
  loud as the unit is in the limited mix; Felucca's `tutti_stem_render` / `tutti_mx` design).
- `stemsSumToMix: false`: not in the stems are TEXTURE (a bed of the whole song), DUST (a whole-mix effect, with its
  own noise), the punch-in FX and the output knee; and the buses are not linear (the reverb's and the delay's
  saturation). With the test groove (`plugin_test.mjs`) the stems add up to the mix within about -62 dB of the mix. A
  unit with nothing playing gives a silent stem.

## Timing

- **Blocks.** The firmware takes its events (sequencer steps, MIDI) once per block of 32 frames (`CTL`). A step sounds
  at the first block boundary at or after its exact time (0 to 31 frames late, as on the FM-1); a MIDI note of use B
  goes in with the nearest block (within 16 frames of its time).
- **Latency.** The master limiter looks one block ahead (SLOOP 2.6): the device's output is the mix 32 frames late.
  The renderer drops those 32 frames (`tutti_latency`), the stems' alike, so a render's frame 0 is the sound at
  `fromBeat` (`plugin_test.mjs`: a use B note at beat 1 sounds at frame 22050 at 120 BPM).
- **Every render plays from the song's start.** A render of `[fromBeat, toBeat)` renders from beat 0 (transport
  started at frame 0) and drops the frames before `fromBeat`, so notes held over `fromBeat`, delay and reverb tails,
  LFOs, the song's sections are as when the song plays through; a render of a later range is bit for bit the same audio
  as that part of a render from 0. A fresh instance per render (the firmware's random generators, the voices' seeds,
  TEXTURE's noise would carry over otherwise): two renders are the same bytes.
- **Tempo maps.** `tempoMap: "constant"`, as Felucca's: frame positions follow the host's map (section 5, linear ramps
  integrated); SLOOP plays the range at the tempo in effect at `fromBeat`. A tempo change inside the range is refused
  (`unsupported`) unless the request says `approximation: "start-tempo"`.
- **Tempo range.** 40 .. 240 BPM (SLOOP's own range, fractional within it); outside it `unsupported`.
- **No seek.** `capabilities.seek` is `false`: every render runs from beat 0, `render-progress` over the pre-roll and
  the range together.

## Use A: what plays

The state's `play` (the bar's "render" selector) says what a render (use A, `input: null`) plays from beat 0, and what
PLAY plays with tuttidaw's transport:

| `play` | A render plays |
| --- | --- |
| `auto` (default) | the song when SONG's order is valid (every section it names is stored), else the working pattern |
| `song` | the song: the arranger (`arranger.h`, the song order of the sections A..D, 1..16 entries of 1..64 bars, the editor's Song page), from its first entry; it stops at its end (or loops, as set) |
| `pattern` | the working pattern (the four tracks as they are), looped |
| `A` .. `D` | that section, looped |

The arranger (`FELUCCA_ARRANGER`) is in this build (it was not in the preview's wasm). The transport stops at `toBeat`
(the nearest block): the notes are released there and the tail only rings out.

The page's preview with tuttidaw's transport plays the same (`sloop_plugin.c tutti_live_mode`, the worklet's `mode`
message, the full `play`): the song, the working pattern, or a section. A section plays over the tracks while the
transport plays, the working pattern put aside meanwhile and back when it stops (whatever stops it), as SLOOP's song
mode keeps it; the state (`tutti_sig`, `tutti_snapshot`) is the pattern put aside all the while, so previewing a
section is never a new revision (an edit made while a section plays is to the section's copy and goes with it, as in
song mode). A change of the selector while playing starts again where the transport is.

## Use B: the host's MIDI

With `input` the sequencer and the arranger never run (protocol 7b: only the host's MIDI plays; the state gives the
sounds and settings; no realtime messages are taken, so the MIDI cannot start them). Each MIDI channel plays one part
straight (as `firmware/host/preview.c preview_note`, which now takes a velocity too), not through SLOOP's MIDI IN
routing (GLO > MIDI), so the manifest's `midiChannels` is always right:

| MIDI channel (0-based) | Plays |
| --- | --- |
| 0, 1, 2 | synth track 1, 2, 3: notes as the keys play them (`input_on` / `input_off`: velocity, the arp, CHORD as the track has them; KBD HOLD and ARP HOLD off, see Latches), CC 64 the pedal, the SLOOP CC map (seq.c `midi_cc`: 5 GLIDE, 7 LEVEL, 10 PAN, 11 EXPRESSION, 71 .. 75, 74 FILTER, 91 / 93 / 94 the sends), pitch bend |
| 3 | the drum track: a note-on plays the lane its GM note maps to (as SLOOP's MIDI IN maps it, `drums.c lane_of_note`), through `trk_note_on` and `drums.c drum_on` at the note's velocity (MIDI IN would take four levels); the CC map as above; note-offs and bend ignored |
| 4 .. 15 | nothing |

**The drum note map** (channel 3): the 16 lanes are 36 KICK, 35 KICK 2, 38 SNARE, 39 CLAP, 42 HAT, 46 OPEN HAT,
44 PEDAL, 37 RIM, 40 SNARE 2, 43 LOW TOM, 48 HI TOM, 49 CRASH, 51 RIDE, 70 SHAKER, 63 CONGA, 56 COWBELL (drums.c
`LANE_NOTE`); every other GM note from 35 to 81 plays the lane of its kind (drums.c `LANE_OF_GM`: 41, 45 the low
tom, 47, 50 the high tom, 52, 55, 57 the crash, 53, 59 the ride, ...), below 35 the kick, above 81 the shaker. The kit is
the drum track's (any of the factory kits, the SYN kits, the user kits), with the track's level, pan, mutes, FX.

Notes are released at `min(end, toBeat)`; a note's off comes at least a block (32 frames) after its on, so a note of
length 0 (or less) still sounds and is let go, never off before on; moved that way, it still comes before the next
note of the same pitch on the same channel.

**Latches.** A use B render honours the host's note lifetimes over SLOOP's latches (`tutti_use_b`, a runtime override
like SYNC off: the state keeps its setting, the hardware build is unchanged): KBD HOLD and ARP HOLD (ARP 2 > HOLD) are
off on the synth tracks for the render (set again by a learned CC: off again), so a host note-off lets its note go and
the arp plays only the notes the host holds; at `toBeat` every note still held, the pedal and the arp are let go (note
offs only: the releases and the FX tails ring out). `plugin_test.mjs`: a state saved with KBD HOLD and ARP HOLD renders
the same as without them, only a decaying tail after each note's end.

## Sample rates

The firmware runs at 44.1 kHz only. `48000` is made from it by `resample.js` (Felucca's): a polyphase windowed sinc at
the exact ratio 160/147, 192 taps, centred on each output frame (no delay). A 1 kHz sine comes out within -120 dB.

## State

The state is SLOOP's flash storage, the sectors `storage.c` writes (`state.js STORE_AREAS`): the settings (with the
song order, the SYN drum kits, the MIDI settings and learn map, the theme and favourites), the sections A..D, the
working project (the autosave, written just before by `tutti_snapshot`, with the sections and the settings still in
RAM and SYN kit edits not stored yet), the two user preset banks, the FM6 patch bank, the four user sample slots
(ADPCM) -- every object of the editor's backup (`EDITOR_PROTOCOL.md` v6: 0, 1, 2-5, 6-7, 8, 9, 10, 11, 32-35), in the
firmware's own formats (`FUN6` projects, read back to `FUN1`), plus the plugin's meta (`play`). Format (`stateVersion`
1): `"SLPT"`, u32 version, u32 meta length, the meta (JSON), u32 count, then count x (u32 offset, 4096 bytes),
little-endian. An empty SLOOP is about 8 KiB; the storage areas are 392 KiB in all (a SLOOP with four full sample
slots), far under the host's 8 MiB.

`plugin_test.mjs` checks the round trip the strong way: a SLOOP with sections, a song, a user preset, a user sample, an
FM6 patch, an edited SYN kit and settings, its state into a fresh SLOOP, then every backup object read from both over
the editor protocol: all the same; and the same render.

A hardware backup file (the editor's `.json` backup) is not a state, but the plugin's editor restores it as it does
on an FM-1 (its Projects page), into the page's SLOOP; the state then has it.

Revisions: 1 is the state `init` gave (or the factory state). A change on the live SLOOP (anything the state holds:
`sloop_plugin.c tutti_sig` hashes the working project, the sections, the settings and counts the flash writes of the
rest) or of the render selector starts the next revision; `state-changed` follows once it has been still for 600 ms (at
most every 2 s while it keeps changing). Renders take the state of the revision they ask for (the last 8 are kept).

## Not done (yet)

- `tempoMap: "full"` (tempo changes inside a render): the clock would need the tempo per block.
- Sub-block timing (steps and MIDI to the sample): the firmware's control rate is a block of 32 frames.
- The device's screen in the page (the editor is the UI).
- Web MIDI in tuttidaw's frame (the manifest asks no `midi` permission); the editor's keys and LIVE page play the
  page's SLOOP.
