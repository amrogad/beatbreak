# Design

## Visual Theme

Dark neon arcade. Deep navy background with cyan, violet, magenta, and amber accents. Rounded panels, soft glow, monospace for numbers and timing.

## Colors

- Background: `#05060e`
- Panel: `rgba(15, 19, 38, 0.86)`
- Text: `#e8eeff`
- Muted: `#98a2c8`
- Accents: cyan `#22e0ff`, violet `#a06bff`, magenta `#ff3ea5`, amber `#ffc73a`, green `#5ce69a`, red `#ff4d6d`

## Typography

- UI: system sans-serif stack
- Numbers/timing: monospace stack
- Body line length should stay readable; headings use bold weights with modest letter spacing.

## Components

- Panels: rounded 16px, translucent navy, subtle border and shadow
- Buttons: rounded 10px, cyan primary, ghost/danger variants
- Difficulty cards: colored accent per difficulty, selected state with glow
- Reduced motion and keyboard focus states should remain visible

## Layout

- Max content width 1180px, centered
- Responsive grids collapse on small screens
- Playfield prioritizes vertical space and clear lane separation
