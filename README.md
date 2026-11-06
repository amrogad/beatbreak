# Beatbreak

A local browser rhythm game that turns **your own audio files** into four-lane charts. Add a song,
pick a difficulty, play. Nothing is uploaded, there is no account, and no music is bundled.

Built with React, TypeScript and Vite. Analysis runs in a Web Worker, playback uses the Web Audio
API, and the library is stored in IndexedDB.

```
Home -> Add song -> Choose a difficulty -> Play -> Results
```

## Quick start

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

| Command | What it does |
| --- | --- |
| `npm run build` | Type-check and build the static app into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Full Vitest suite |
| `npm run typecheck` | Strict TypeScript check |
| `npm run smoke` | Synthetic song: analysis -> four charts -> pipeline checks |
| `npm run check:dist` | Verify the built PWA assets and service worker |
| `npm run icons` | Regenerate the PWA icons |

Bring an audio file you own. The browser decides which formats it can decode; MP3, WAV, OGG, M4A
and FLAC are the common cases.

## Hosting

The production build is a static bundle. There is no server, database or API. `dist/` can be
served from a domain root or a subpath because Vite uses a relative base and the service worker
precaches scope-relative URLs.

**GitHub Pages:** the included workflow at `.github/workflows/deploy.yml` runs typecheck, tests,
build and publish on every push to `main`. Set **Settings -> Pages -> Source** to **GitHub Actions**
once.

**Any static host** (Netlify, Vercel, Cloudflare Pages, S3, nginx, `python -m http.server`):

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node | 20 or newer |
| SPA fallback | not required; the app uses one entry point and no path routing |

Upload the **contents** of `dist/`, not the folder itself. Serve over HTTPS for the service worker
and installable PWA (`localhost` is exempt).

Recommended cache policy:

- `assets/*` is content-hashed and can be cached immutably.
- `index.html` and `sw.js` should not be cached, so updates are picked up.
- No redirects are needed. There is no runtime analytics or third-party request.

## How a song becomes a game

1. **Decode and analyse in a worker.** The file is decoded, downmixed and analysed for tempo, beat
   phase, per-band onsets, sustained sounds, sections and near-silent edges.
2. **Trim conservatively on first import.** Only verified digital silence at the edges is skipped,
   plus a short musical tail so the ending is not cut off. There are no automatic repeat cuts and no
   arbitrary section removal. The full analysis is saved with the song, so this choice still works
   after a reload.
3. **Generate four charts from one analysis.** Expert follows nearly every detected onset (the 1:1
   tier); Hard, Normal and Easy keep progressively fewer, stronger notes. Difficulty changes the
   real arrow count, not just a label.
4. **Play.** Arrows rise into four targets. Judgment uses input-event timestamps against the audio
   clock, not the render clock.

Charts are deterministic. Reloading, reopening or replaying a song does not change its arrows.
The only ways to get different arrows are **New arrows** in song options (a new seeded variation)
or editing the chart.

### Difficulty profiles

| Chart | Grid | Onset budget | Target density | Chords | Holds |
| --- | --- | --- | --- | --- | --- |
| Easy | 1 step/beat | 18% | ~1.4 notes/s | none | up to 0.5 s |
| Normal | 2 steps/beat | 32% | ~2.3 notes/s | none | up to 0.42 s |
| Hard | 4 steps/beat | 55% | ~3.3 notes/s | pairs only | up to 0.44 s |
| Expert | 4 steps/beat | all candidates | uncapped, physical limits only | rare triples/quads | up to 0.5 s |

Additional rules:

- Chords are not random: Hard uses symmetric pairs only, and Expert adds rare three- and four-arrow
  accents on strong downbeats or eight-beat accents. They require genuinely simultaneous multi-band
  hits, high strength, and long recovery gaps.
- Lane assignment is band-aware: bass tends left, hats tend right, with flow and hand-balance
  scoring. Patterns are not random lane shuffles.
- Holds come from sustained audio, start only on a beat or eighth, are capped at the values above, and
  may cover at most 10% of a chart. A hold never starts on a chord step, which avoids awkward
  "hold and tap at once" pairs.
- Each song gets a recommendation based on the full-density chart's rating. The app auto-selects it
  only until you pick a difficulty yourself; after that, your choice is remembered.

## Playing

- Four lanes: **Left, Down, Up, Right**.
- Default keys: **W A S D** and the **arrow keys**. On touch screens, tap the lanes.
- `Esc` pause, `R` restart, `F` fullscreen.
- Each run starts with a three-second countdown at negative song time. The field starts empty and
  the first arrows rise into view; nothing is parked on a receptor before the music begins.
- Holds are judged once at the head. Release early and you have 250 ms to press the lane again
  (StepMania's hold window); after that the hold is dropped, breaks combo and counts as a miss.
- The default fail rule is **No fail**, so a first run always reaches the results screen. Failure
  rules are no longer exposed in Settings; the game keeps this one fair ruleset.
- The music fades out at the end of a run instead of stopping abruptly.
- There are no hit sounds and no manual audio offset. The song is the feedback; device output
  latency is estimated from the browser and input timestamps are used for judgment.

### Scoring

Each arrow is worth 100 points before judgment, and a long combo adds up to 50% on top. Combo breaks
on misses and dropped holds. Accuracy is a weighted judgment tally (Marvelous 1.0, Perfect 0.9,
Great 0.72, Good 0.45, Miss 0). Grades run from F to SSS. Auto-play runs are shown but are not saved
as scores.

## Song options

**Song range** has two choices:

- **Trim silence** - skip only waveform-verified near-silent lead-in and lead-out, with a short
  musical tail. If no trustworthy edge silence is found, the whole song plays.
- **Whole song** - play the file from start to finish.

Changing the range regenerates the arrows for that window. **New arrows** creates a new variation
for the same song and difficulty. Title and artist are editable under More options. The chart editor
and audio re-attach live behind explicit links, not in the main play path.

If the audio file is not cached, the setup screen asks for the same file again; the charts and
analysis are already saved. Remembering audio is on by default and can be turned off in Settings.

## Settings

Settings are organised by what a player touches: Audio, Playfield, Controls, Advanced and Storage.
Useful options are volume, remember audio, scroll speed and direction, beat lines, reduced motion,
an arrow-style picker (arrow, chevron, diamond, orb, star, hex or bar), key bindings, fullscreen and
diagnostics. The old note-size, receptor-size, timing-window, fail-rule and auto-play controls were
removed; one fair ruleset now applies to every run.

Lane keys are rebindable. Clicking a key cap **replaces** that key; use **+ key** to add an
alternate binding. The map is repaired if a new binding would leave another lane empty, and it is
saved immediately, so it survives a reload.

Settings storage uses `localStorage`; songs, charts, scores, cached audio and the full analysis use
IndexedDB. Deleting a song removes all of its records.

## Editor and exports

The chart editor is an advanced tool behind **Edit arrows** on the setup screen. It shows a
four-lane grid over the audio, supports add/drag/delete, snapping, BPM/offset correction and preview.

- **Chart JSON** is the round-trippable Beatbreak format (also available from Results).
- **`.sm`** is a StepMania export from the editor. It assumes 4/4 measures, one BPM/offset and a
  single grid resolution; holds are exported as taps. The editor validates the result and refuses
  to silently write an invalid file. Trim is a playback feature, so exports use the untrimmed song.

## StepMania comparison

StepMania is the main reference for lanes, timing windows, jump/hand concepts and hold behaviour.
The full comparison, including the `.sm` note types and the places where this project deliberately
differs, is in [`docs/STEPMANIA-NOTES.md`](docs/STEPMANIA-NOTES.md).

## Honest limitations

- Charts are generated, not hand-authored. The analysis is heuristic; tempo detection can choose a
  half/double-time reading, and section/energy estimates are approximations.
- No mines, rolls, lifts, fakes, attacks, BPM changes, stops, warps or time-signature changes.
- No hands/triples by design; no manual audio-offset calibration, no hit sounds, no online scores.
- Bluetooth audio latency can still be noticeable. Wired output is the most predictable.
- The `.sm` exporter cannot represent hold bodies or trims, as noted above.
- No commercial music is included. Use files you are allowed to use.

## Verification

`npm test` covers tempo/grid recovery, deterministic charts and variation salts, difficulty
profiles, chord/hold constraints, StepMania hold semantics, judgment boundaries, scoring, failure
accounting, trim behavior, playback-plan clock jumps and chart serialization. `npm run smoke` runs
the real pipeline on a synthetic song. The production build is checked by `npm run check:dist`.

Performance is treated as a feature: analysis is off the main thread, the renderer caches lane
layouts and glyph paths, adapts quality when frames drop (never affecting judgment), and the
gameplay HUD does not re-render React every frame.

## Credits

- Terminal typography and synthetic UI sounds are original, inspired by
  [KeyboardWarrior](https://github.com/nathanhoad/keyboardwarrior) (CC0). No assets are copied.
- Behaviour and parameter choices were informed by reading the
  [StepMania](https://github.com/stepmania/stepmania) source (MIT). No code was copied.

## Browser support

Recent Chrome, Edge, Firefox and Safari. Requires Web Audio, IndexedDB and Web Workers. The
installable/offline PWA needs service-worker support and a secure context.
