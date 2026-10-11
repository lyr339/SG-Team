# 拾光 design system

The product language is a light, calm desktop workspace; a dark mode exists and is derived from the same tokens through `light-dark()` (appearance popover: light / dark / system, card opacity, background preset, accent preset). Dashboard-style dark chrome is not the direction — dark mode is the same calm surface with inverted lightness.

## Layout

```text
top product bar
  └─ session roster (left rail) | session workspace or overview | inspector (right pane)
```

- The session roster never disappears on desktop; since phase 3 it is partitioned by collaboration group (see `UI-STRUCTURE.md` §1a).
- Overview cards summarize; they do not replace the detailed workspace.
- Account and Cursor maintenance live behind the top-right account entry (settings page), not in the main navigation.
- Commerce, refund and promotional controls from reference products are not part of 拾光.

## Color semantics

Two families that never mix: the **accent** (brand / selection) and the **status colours**.

- **Accent** (default 拾光橙 `#a64c2c`, user-selectable — see below): brand marks, primary buttons, selection states (the roster's light-blade selected row, spectrum segment, filter chip, nav), single-series bars. In the roster the accent means exactly one thing — "you are here".
- **Status colours** (rail state dot, bookmark spine, state word; never decoration):
  - **green** (`--color-text-success`) = waiting — on duty, parked in the `check_messages` long poll;
  - **amber** (`--signal-busy`, a saturated hue ≈35° that is deliberately not the theme orange and does not follow the accent) = active — took a message, working; the only pulsing dot;
  - **blue** (`--color-text-info`) = attention — awaiting the user's answer / decision / review;
  - **red** (`--color-text-danger`, hollow ring) = offline;
  - **grey** = unavailable / settled / unknown.
  - Amber (`--color-text-warning`) also carries "needs a decision" pills (成员离线, risk pills) and red carries errors and destructive confirmations only.
- **Data category palettes** never follow the accent either: the four usage token buckets (`--usage-output` is pinned orange), the stats seat palette, the file-type identity colours (`--filetype-*`), the provider logos.

Surfaces use white, warm gray and pale tints of the accent (`--accent-wash` / `--accent-soft`); status colours must not be used as decoration, and every status shown in colour also has text and an accessible label.

## Accent (theme colour)

- `theme-palette.ts` owns six complete role palettes; `theme-palette.generated.css` is regenerated with `npm run theme:generate` and checked against its source in tests.
- `foundation.css` owns typography, neutral surfaces and fixed semantic colours. Components consume `--accent-*` and `--action-primary-*` roles rather than deriving independent colours.
- Choosing a theme applies `data-accent`; stable preset IDs and the existing preference storage key are preserved. Earlier three-variable inline overrides are removed during migration.
- Body surfaces retain a readability floor even at low opacity; the UI explains this rather than promising fully transparent text surfaces.
- Background presets (折光 / 极光 / 流体 / 棱镜) are independent wallpapers. They carry no status meaning.
- See [THEME-SYSTEM.md](THEME-SYSTEM.md) for palette roles and verification requirements.

## Component rules

- Borders are preferred over heavy shadows.
- Radius stays between 9 and 17 pixels.
- Main text remains charcoal, never pure black.
- Disabled future features are visibly labeled and never pretend to work.
- Every status shown in color also has text and an accessible label.
- Motion is budgeted per surface (hover 120 ms, selection 220 ms, group fold 200 ms, ring arc 400 ms, "happening now" pulses 1.4–1.6 s ease-in-out) and fully off under `prefers-reduced-motion`.
- Spinners are for *loading* (a fetch, a probe), not for *being worked on*. Todo indicators use a static open ring for the current item and a dotted ring for pending (`TodoIndicator`); the plan panel uses the same quiet gray icons without colored row markers.
