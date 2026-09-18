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

- **Accent** (default 拾光橙 `#ff6b35`, user-selectable — see below): brand marks, primary buttons, selection states (the roster's light-blade selected row, spectrum segment, filter chip, nav), single-series bars. In the roster the accent means exactly one thing — "you are here".
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

- One base variable, `--anthropic-orange`, feeds every brand use through `color-mix()` derivatives (`--accent-soft/wash/border*`, focus ring, brand shadow); `--accent-deep` / `--accent-bright` are the only hand-tuned anchors and travel with the preset.
- Presets are curated (`ACCENT_PRESETS` in `appearance-preferences.ts`), not a free picker: hues stay clear of the status hues, and every preset's deep-on-wash contrast is checked in both colour modes. Choosing the default removes the overrides so the stylesheets remain the source of truth.
- Background presets (`BACKGROUND_PRESETS`: 折光 / 极光 / 流体 / 棱镜) are wallpapers behind the translucent cards; they carry no meaning and never change any token.

## Component rules

- Borders are preferred over heavy shadows.
- Radius stays between 9 and 17 pixels.
- Main text remains charcoal, never pure black.
- Disabled future features are visibly labeled and never pretend to work.
- Every status shown in color also has text and an accessible label.
- Motion is budgeted per surface (hover 120 ms, selection 220 ms, group fold 200 ms, ring arc 400 ms) and fully off under `prefers-reduced-motion`.
