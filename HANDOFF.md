# PULSEGRID — Handoff Notes

Date: Tue Oct 27, 2026

## Project
- Local browser rhythm game: upload → auto-chart → play. Root: `C:\Users\amrel\WebstormProjects\pulsegrid`
- Git repo, branch `main`, pushed to the private GitHub repo amrogad/pulsegrid.
- Stack: React 18, TypeScript, Vite. Web Worker analysis, Web Audio playback, IndexedDB storage.

## Current state
The dumb-friendly disco polish pass is complete. The app now defaults to the disco skin and the
terminal theme is gone from the UI. The main play path is: Home → Add a song → Choose a difficulty →
Play → Results, with Help always available in the top right.

### What changed in this pass
- Disco is the default theme (hot magenta / violet / electric cyan / gold on deep aubergine).
  `terminal` was removed from `ThemeName`, the renderer palette, and the CSS import; saved terminal
  values migrate to disco. `src/styles/theme-terminal.css` still exists but is unused.
- Settings were cut back to Audio, Playfield, Controls, Advanced and Storage. Removed from the UI:
  note size, target size, interface sounds, timing windows, fail-rule picker and auto-play. Schema v7
  resets the hidden values and keeps the shared defaults.
- Arrow style moved into a collapsed picker with coloured glyph/labels. Reset-arrow-keys and
  reset-other-keys buttons sit on the right edge of their groups.
- In-game notes, receptors and hold tails now use the homepage preview's actual Unicode `← ↓ ↑ →`
  glyphs and mono font. Holds are a thin glowing shaft with the preview glyph at both ends.
- Home cleanup: removed the MP3-format line, duplicate songs stat, preview labels, "How to play"
  button and repeated privacy/storage copy. The hero paragraph uses the available width.
  Each song now shows one highest score with difficulty, grade and accuracy.
- Topbar Library button removed. Back labels are now "Back" / "← Back". Help stays top right.
- Badges/labels use consistent sentence case. "Works offline", "New personal best", "Full combo",
  "Playable — no errors" and similar.
- Storage panel: "Refresh figures" is a normal button next to the destructive actions; privacy copy
  is not repeated.
- All actionable buttons have a visible resting style (ghost buttons included). The editor's tab
  controls were given the same treatment.
- Scoring dropped from 1,000 to 100 points per arrow, still with a combo bonus of up to +50%. A long
  chart now lands in the tens of thousands instead of the hundreds of thousands. IndexedDB schema v4
  divides old saved scores by ten once so old personal bests stay comparable.
- The results score hint names the chart maximum (e.g. "93.3% of the 15,008 maximum").
- Game canvas has an accessible name (`role="img"`).
- README settings and scoring sections were refreshed to match the simplified UI.

## Verification (run after the final edits)
- `npx tsc --noEmit` — clean
- `npx vitest run --reporter=basic` — 155 tests pass
- `npm run smoke` — all checks pass
- `npm run build` — succeeds; `dist/` emitted
- `npm run check:dist` — all deploy checks pass
- Browser smoke: Home, Settings, open arrow-style picker, a live run with tap notes, hold notes, and
  the populated Home high-score row were checked visually.

## Important product notes
### The PULSEGRID name is not safely available
Research found multiple existing apps using the name, a UK company, and two US trademark
applications — including one covering software for processing digital music files. Launching under
this name risks a trademark conflict. Renaming before launch is strongly advised.

### Monetization recommendation
Keep the core free and local-first. Sell a one-time Pro unlock (extra cosmetics, chart export,
editor conveniences), optional cosmetic packs, and a tip jar. Avoid ads and subscriptions: they fit
a local, offline-capable tool poorly and would undercut the privacy promise.

## Environment notes
- Windows + PowerShell. **`&&` does NOT work in this shell** — run commands separately.
- Dev server: `npm run dev` → http://127.0.0.1:5173
- Project scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `smoke`, `check:dist`, `icons`.
- Node via npx/vite-node.

## Where to look
- Settings screen: `src/app/screens/SettingsScreen.tsx`
- Renderer / glyph notes / holds: `src/render/renderer.ts`
- Home and high-score row: `src/app/screens/HomeScreen.tsx`
- Settings schema/migration: `src/store/settings.ts`
- Scoring: `src/game/score.ts`
- Score history migration: `src/store/db.ts`
- Layout/theme: `src/styles/app.css`, `src/styles/theme-disco.css`
- Routing/topbar: `src/app/App.tsx`

## Remaining ideas (not required for this pass)
- Add a focused browser test for the hold-note rendering and the score migration.
- Delete or archive the unused `theme-terminal.css`.
- Decide whether the name changes before any public launch.
- Consider adding a small "How scoring works" line to Help if players ask again.
