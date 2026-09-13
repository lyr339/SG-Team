# 拾光 design system

The default product language is a light, calm desktop workspace. Dark dashboard styling is not part of the current direction.

## Layout

```text
top product bar
  └─ feature rail | persistent session pane | overview or session workspace
```

- The session pane never disappears on desktop.
- Overview cards summarize; they do not replace the detailed workspace.
- Connection configuration stays in a small popover instead of occupying the main page.
- Commerce, refund and promotional controls from reference products are not part of 拾光.

## Color semantics

- Accent (default 拾光橙 `#ff6b35`, user-selectable — see below): brand, waiting, healthy connection.
- Blue `#5867e8`: actively running.
- Amber `#e58a3b`: blocked, review attention, recovery.
- Red `#df5f66`: errors and destructive warnings only.
- Gray: offline and unavailable.

Surfaces use white, warm gray and pale mint. Status colors must not be used as decoration.

## Accent (theme colour)

- One base variable, `--anthropic-orange`, feeds every brand use through `color-mix()` derivatives (`--accent-soft/wash/border*`, focus ring, brand shadow); `--accent-deep` / `--accent-bright` are the only hand-tuned anchors and travel with the preset.
- Presets are curated (`ACCENT_PRESETS` in `appearance-preferences.ts`), not a free picker: hues stay clear of the status hues, and every preset's deep-on-wash contrast is checked in both colour modes. Choosing the default removes the overrides so the stylesheets remain the source of truth.
- Never follows the accent: status colours, and **data category palettes** — the four token buckets (`--usage-output` is pinned orange) and the stats seat palette. Selection states and single-series bars do follow it.

## Component rules

- Borders are preferred over heavy shadows.
- Radius stays between 9 and 17 pixels.
- Main text remains charcoal, never pure black.
- Disabled future features are visibly labeled and never pretend to work.
- Every status shown in color also has text and an accessible label.
