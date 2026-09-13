# UI structure

The desktop app has two levels. They share the same `AgentSession` projection and never maintain separate copies of session state.

## 1. Session overview

- Card grid for health, task, context pressure, change summary and queue depth.
- Filters for running, waiting, blocked, reviving and offline sessions.
- Team and task summaries are added here later.

## 1a. Session roster (left rail)

The left rail is a roster, not a stack of cards, and speaks the same language as the right-hand inspector: one frame, hairline-separated rows, sticky collapsible group labels (执行中 / 需关注 / 待命 / 离线), semantic colour only on the 7px state dot and the avatar ring.

- `session-rail-view.ts` decides grouping, state tone, title split (`角色名` + `CH-N`) and the header summary (`1 执行中 · 1 待命 · 排队 3`); `SessionRailCard` and `SessionSidebar` only lay things out, so the group a row sits in and the colour of its dot can never disagree.
- The signature element is the **context ring**: an arc around the avatar whose length is the Composer's context usage, tinted clear → afternoon → dusk. The exact percentage stays in the meta line; the ring is the at-a-glance version.
- The fourth line of a row is the **status line** — a replica of the subtitle Cursor prints under each session in its own agent list, same algorithm and same English wording (`Thinking`, `Reading foo.ts`, `Grepping x in src/`, first sentence of the reply, `3/7 To-Dos Completed`, `Awaiting approval · <question>`, `Planning next moves`, `Completed` / `Stopped`). It is persistent: a full-width pill along the bottom of the row (avatar left edge → card right edge, spinner at its left end, long text ellipsised inside), never unmounts, spins while the Cursor turn is alive, greys out when settled; tool hues reuse the process-stream palette. Facts come from hook v32 / runtime inspect (`liveStatusLine`), with the same rules applied to process blocks as the fallback. `sessionRailActivity` in `session-rail-view.ts` is the only rule table; the card only lays it out.
- Selection is the only place brand orange appears in the rail: a 2px bar on the left edge plus a tonal wash. Hover is a wash only.
- Interaction: click opens; ↑ / ↓ / Home / End rove between visible rows (roving `tabindex`, folded groups are `inert`); rows reorder by drag within their state group; group collapse persists. Empty and connecting states reuse `InspectorState`.
- Motion budget: hover 120ms, ring arc 400ms, group collapse 200ms, pulse only on working rows; all off under `prefers-reduced-motion`.
- Screenshot matrix: `node scripts/preview-shots.mjs --only sessions-rail-light,...` (see `--list`), backed by the `?sessions=many|none` preview scenes; the status line has its own `sessions-rail-activity-{light,dark,narrow-light,narrow-dark}` scenes (`?railactivity=1|long`) with a geometry / wording probe.

## 2. Session workspace

Opened by selecting a session row:

```text
session list | session header + warning rail
             | transcript / tool timeline / diff
             | delivery tray (messages not yet taken by check_messages)
             | message composer + handoff + unattended controls
```

The reference UI's commerce banner, refund actions and unrelated utilities are intentionally excluded. The useful patterns are persistent session navigation, explicit disconnection messaging, visible recovery, a stable composer and direct handoff.

The timeline shows only what the Agent has actually received. A message sent while the Agent is busy (or offline) is not a timeline row: it waits in the delivery tray docked above the composer — count, presence state, per-message withdraw / release — and moves into the timeline the moment `check_messages` takes it. Screenshot scenes: `session-queue-tray-{light,dark,collapsed}` (`?queued=1`).

Required data before the workspace is enabled:

- stable `composerId + generation` identity;
- transcript and tool event stream;
- model and context usage telemetry;
- session-attributed file changes;
- send, recover, stop and handoff commands with request IDs.
