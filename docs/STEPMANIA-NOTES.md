# StepMania reference notes

PULSEGRID borrows the *mechanics* of four-lane dance games, not StepMania's code or content. This
note records what was checked in the StepMania source and where this project intentionally differs.
It is a design reference, not a claim of full compatibility.

Source files consulted (StepMania, MIT):

- [`NotesLoaderSM.cpp`](https://github.com/stepmania/stepmania/blob/master/src/NotesLoaderSM.cpp)
- [`NoteDataUtil.cpp`](https://github.com/stepmania/stepmania/blob/master/src/NoteDataUtil.cpp)
- [`Player.cpp`](https://github.com/stepmania/stepmania/blob/master/src/Player.cpp)
- [`.sm` format documentation](https://github.com/stepmania/stepmania/wiki/sm)

## What we matched

### Lanes and note rows

- Four columns in the order Left, Down, Up, Right, the same mapping used by the app.
- Notes are quantized to a beat grid. `.sm` stores one character per column per row, with `1` for a
  tap, `2` for a hold head, `3` for a hold tail, `4` for a roll head, `M` for a mine, `L` for a
  lift, and `F` for a fake. PULSEGRID only generates taps and holds.
- Simultaneous notes in different columns are jumps (two) or hands (three or more). StepMania
  authors use these deliberately; PULSEGRID allows them only when several frequency bands really
  attack together. Hard never asks for more than two arrows. Expert earns rare three-arrow hands on
  downbeats and very rare four-arrow hands on eight-beat accents, with long recovery gaps.
- A hold occupies its own lane. Taps in *other* lanes can occur on the same row as a hold head,
  and other lanes remain playable while a hold is being held. A single lane cannot contain a tap
  and a hold at the same instant.
- Holds are judged at the head using the tap windows. The tail is a sustained action, and releasing
  early starts StepMania's hold grace window (`TW_Hold` in `Player.cpp`, 250 ms) during which the
  lane can be pressed again to recover the hold. PULSEGRID uses the same 250 ms release window and
  the same head-then-sustain model.

### Timing windows

The default `stepmania` preset is the set StepMania ships for dance mode:

| Judgment | Window |
| --- | --- |
| Marvelous / W1 | +/-22.5 ms |
| Perfect / W2 | +/-45 ms |
| Great / W3 | +/-90 ms |
| Good / W4 | +/-135 ms |

PULSEGRID scales these slightly by chart difficulty (Hard is the unchanged reference, Expert is
about 8% tighter, Easy/Normal slightly wider). Unlike StepMania, there is no manual audio-offset
setting; input event timestamps and estimated output latency are used instead.

## Where we differ

### Charts are generated, not authored

StepMania charts are authored by a human. The `#NOTES` block stores a difficulty label and a
numeric meter chosen by the charter; StepMania itself does not calculate a chart's difficulty from
its notes. PULSEGRID generates charts from audio analysis and computes a recommendation from the
full-density chart's stats. The four labels are product names, not StepMania's exact
Easy/Medium/Hard/Challenge taxonomy.

Generation rules that have no direct StepMania equivalent:

- Onsets are detected per frequency band, quantized to the chart grid, and thinned per difficulty.
- Lane choice is band-aware (bass left, hats right) with flow, balance and jack penalties, rather
  than authored patterns.
- Chords are gated to strong grid positions, genuinely simultaneous multi-band hits, a high strength
  floor, and a long recovery gap. Hard uses symmetric pairs. Expert adds rare three- and
  four-arrow hands only on downbeats or eight-beat accents.
- Holds come from measured sustain, start only on a beat or eighth, are capped at 0.5 s (Easy) through
  0.5 s (Expert), and may cover at most 10% of the chart. They never start on a chord step, which is
  stricter than StepMania.
- Expert is the 1:1 tier: it keeps nearly every detected onset rather than using a hand-authored
  pattern.

### Playback editing

StepMania has no automatic edge-trim feature. PULSEGRID's Trim silence option is a playback
convenience: it skips only waveform-verified near-silence at the edges, keeps a 150 ms run-up and a
1.2 s musical tail, and otherwise plays the whole song. It never selects a random section, and it
falls back to the whole song when no trustworthy edge silence exists. Charts are generated for the
selected window, and the analysis is stored so the choice survives a reload.

The `.sm` export uses the chart's timing window, writes hold heads but not hold bodies (holds become
taps), assumes 4/4 measures and a single BPM/offset, and rounds micro-timing to the export grid.

### Content and systems

PULSEGRID does **not** implement mines, rolls, lifts, fakes, attacks, keysounds, speed changes,
stops, warps, time signatures, courses, characters, or online scoring. It has one audio track, one
timing map and four fixed lanes. Its scoring, grades and fail rules are its own; they are inspired
by the genre but are not StepMania's scoring engine.

The default fail rule here is **No fail** so a new player can reach the results screen. StepMania's
fail behavior is a profile setting; PULSEGRID exposes No fail, an accuracy-collapse rule, and fail
after 1/3/5/10 misses.

## Why this matters for generated charts

A StepMania charter can hear the song and choose a pattern with intention. An automatic chart has
to infer that intention from onsets and sustains. The choices above are deliberately conservative:

- triples and quads only on Expert and only when the music clearly supports them;
- no hold starts on a chord, because "hold and tap simultaneously" is hard to read when it is not
  hand-authored;
- short hold caps, because long generated tails obscure the playfield;
- a minimum gap between chord steps, because double/triple/double bursts are the classic failure
  mode of naive auto-charting;
- stable seeds and explicit variation, because a chart that changes on reload is not a chart.

Those are product decisions, not StepMania rules. They are documented here so future changes can be
judged against the actual reference instead of a half-remembered one.
