# UI structure

The desktop app has two levels. They share the same `AgentSession` projection and never maintain separate copies of session state.

## 1. Session overview

- Card grid for health, task, context pressure, change summary and queue depth.
- Filters for running, waiting, blocked, reviving and offline sessions.
- Team and task summaries are added here later.

## 1a. Session roster (left rail)

The left rail is a roster, not a stack of cards, and speaks the same language as the right-hand inspector: one frame, hairline-separated rows, sticky collapsible group labels (执行中 / 需关注 / 待命 / 离线), semantic colour only on the 7px state dot and the avatar ring.

- `session-rail-view.ts` decides grouping, state tone, title split (`角色名` + `CH-N`) and the header summary (`1 执行中 · 1 待命 · 排队 3`); `SessionRailCard` and `SessionSidebar` only lay things out, so the group a row sits in and the colour of its dot can never disagree.
- The row's state word is the **protocol phase**, not Cursor's turn state, and every label is **three characters** so the right column aligns: **干活中** = `running` (presence `processing`), **待命中** = `waiting` (parked in `check_messages` / keepalive), **待拍板** / **待验收** / **待回答** / **已离线** / **启动中** / **恢复中** / **已停止** / **未待命**. In the session pool every live seat's Cursor turn is perpetually `generating` and its transcript is only flushed when the turn ends, so `isGenerating` and transcript growth are liveness evidence only — `verifyAgentRuntime` may lift a seat back online on them, never flip waiting → running.
- The 7px state dot and the group bookmark's 3px spine share one four-colour map: **green** = waiting (on duty in the long poll), **amber** (`--signal-busy`, independent of theme orange) = active (processing, the only pulsing dot — a breathing halo 2→4px, not a blinking core), **blue** = attention (blocked / review / awaiting user), **red hollow ring** = offline. Orange in the rail remains reserved for selection (the light blade).
- The signature element is the **context ring**: an arc around the avatar whose length is the Composer's context usage, tinted clear → afternoon → dusk. The exact percentage stays in the meta line; the ring is the at-a-glance version.
- The fourth line of a row is the **status line** — a replica of the subtitle Cursor prints under each session in its own agent list, same algorithm and same English wording (`Thinking`, `Reading foo.ts`, `Grepping x in src/`, first sentence of the reply, `3/7 To-Dos Completed`, `Awaiting approval · <question>`, `Planning next moves`, `Completed` / `Stopped`). It is persistent: a full-width pill along the bottom of the row (avatar left edge → card right edge, spinner at its left end, long text ellipsised inside), never unmounts, spins while the Cursor turn is alive, greys out when settled; tool hues reuse the process-stream palette. Facts come from hook v32 / runtime inspect (`liveStatusLine`), with the same rules applied to process blocks as the fallback. `sessionRailActivity` in `session-rail-view.ts` is the only rule table; the card only lays it out.
- Selection is the only place brand orange appears in the rail, and it is a **light blade**: a 3px spine on the left edge (`--accent-bright → --accent-deep` top-to-bottom, rounded right side, a 7px `--accent-glow` afterglow — 32% in light, 20% in dark) plus an accent wash that fades from 7% at the left edge to nothing at the right edge (it must run the full width: a gradient that hits zero mid-row leaves a visible Mach band). The blade grows from its midpoint once when selection changes (220ms, the group-collapse curve) and is otherwise still. Hover is the neutral `surface-soft` and never shares the selected row's colour, so the two states differ in kind, not only in a 3px line.
- Group bars are **bookmarks**: a 32px band (sticky, solid) from whose left edge a 22px flat flag protrudes — a 3px spine in the group's state tone, label, tabular count, a 45° point — followed by a hairline that runs to the right edge with the chevron riding on its end (visible on hover or when folded). The band's geometry is identical in both states; folding animates the list alone (`0fr → 1fr`), and folding a group that would be clamped or whose bar is pinned eases `scrollTop` to the end state on the same 200ms curve (`session-group-collapse.ts`), so the bar the user clicked never jumps. Folded rows stay mounted (`inert` + clipped). Groups are separated by 6px of air, never by a second line.
- Interaction: click opens; ↑ / ↓ / Home / End rove between visible rows (roving `tabindex`, folded groups are `inert`); rows reorder by drag within their state group; group collapse persists. Empty and connecting states reuse `InspectorState`.
- Motion budget: hover 120ms, selection blade 220ms (opacity 160ms), ring arc 400ms, group collapse 200ms (list height + anchored scroll, chevron 160ms), pulse only on working rows; all off under `prefers-reduced-motion`.
- Screenshot matrix: `node scripts/preview-shots.mjs --only sessions-rail-light,...` (see `--list`), backed by the `?sessions=many|none` preview scenes; the status line has its own `sessions-rail-activity-{light,dark,narrow-light,narrow-dark}` scenes (`?railactivity=1|long`) with a geometry / wording probe.

## 2. Session workspace

Opened by selecting a session row:

```text
session list | session header + warning rail
             | transcript / tool timeline / diff
             | dock: delivery tray (messages not yet taken by check_messages)
             |       turn files bar (files the Agent changed in this turn, +/− per file)
             | message composer + handoff + unattended controls
```

The reference UI's commerce banner, refund actions and unrelated utilities are intentionally excluded. The useful patterns are persistent session navigation, explicit disconnection messaging, visible recovery, a stable composer and direct handoff.

The timeline shows only what the Agent has actually received. A message sent while the Agent is busy (or offline) is not a timeline row: it waits in the delivery tray docked above the composer — count, presence state, per-message withdraw / release — and moves into the timeline the moment `check_messages` takes it. Screenshot scenes: `session-queue-tray-{light,dark,collapsed}` (`?queued=1`).

Directly above the composer (below the tray) sits the **turn files bar** — the counterpart of Cursor's own "N Files" strip: one row per file the Agent edited or wrote in the current turn (everything after the latest delivered user message, persisted process blocks and the live stream alike), with a file-type icon (on the same vertical axis as the head chevron), the basename (stem truncates, extension never does), the directory only when another listed file shares the name (truncated from the left) and the line counts with only the non-zero side (`+28`, `−30`, `+18 −20`); the list shows five whole rows and scrolls beyond that. Counts come from the Git working-tree summary the review panel already holds (so the numbers match what "审查" opens), falling back to the summed edit hints — marked `≈` and dimmed — until Git has seen the file. A spinner marks a turn still in progress; the bar disappears when the set is empty. When the next message is taken and the new turn has not edited anything yet, the bar keeps the previous turn's files under an 上一轮 label (dimmed; 审查 opens the 未提交 scope, since 本轮 is empty at that moment) until the first edit of the new turn replaces them — the queue delivers automatically, so the bar must not vanish on its own. The header collapses (persisted), the list stays mounted and `inert`. "审查" and every row raise a `review-focus` request that opens the right pane, switches to 变更 → 本轮 and expands + highlights the file. There is deliberately no Stop: aborting a Cursor turn is not a capability 拾光 has. Screenshot scenes: `session-turn-files-{light,dark,collapsed,with-tray-narrow,narrow-pane,review,previous}` (`?turnfiles=1|previous`, `&deep=1` for a deep path, `&queued=1` to stack with the tray).

Tray and bar share one **dock** (`.session-dock`, one grid row of the workspace). When both are present they share a single solid frame with a dashed hairline between them (the line between "not yet in the conversation" and "already happened"), and the bar yields: head only (count, totals, 审查, no spinner — the tray head already says the Agent is busy), expandable by hand for this occurrence, back to the stored preference once the tray leaves. The tray's collapse is persisted the same way. The timeline row has a floor — `min(240px, 55vh − 230px)`: 240 at the default 900 px window, 144 at the 680 px minimum, which is exactly what still fits with the composer dragged to its cap — and the dock is what shrinks when the budget runs out (each section keeps its 36 px head, the lists scroll). Screenshot scene: `session-dock-min-height` (1440×680, tray + bar, probe: floor kept, tray fully visible, composer inside the window; after a manual expand both lists scroll with heads visible).

Required data before the workspace is enabled:

- stable `composerId + generation` identity;
- transcript and tool event stream;
- model and context usage telemetry;
- session-attributed file changes;
- send, recover, stop and handoff commands with request IDs.
