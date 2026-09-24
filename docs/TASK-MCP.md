# 拾光 Agent MCP

The built server is `out/mcp/index.mjs`. Cursor sees a single native entry, `SG Team`, with **nine tools**: two communication tools that are always listed and seven team tools that are listed only while the workspace has an active collaboration group (see "Tool surface follows the workspace"). Every call carries `channel_id`; role permissions are enforced per call by the service layer (the surface is a superset, the fence is at call time).

## Tool surface

| Tool | Kind | Purpose |
| --- | --- | --- |
| `check_messages` | communication | Long-poll for the next delivery: a user message, a membership notice, or a batch of the seat's unread team messages (keepalive → stay silent). |
| `record_reply` | communication | Archive the complete user-visible reply after every real reply. |
| `team_check_in` | team | Check in on duty (first check-in stamps `acknowledged_at`; readiness turns `active`) and return the role briefing **plus** the group context snapshot (members with real capabilities, unread / awaiting counts, confirmed run memory). Call again whenever the context needs refreshing (takeover, permission change, joining a group). The briefing exists only for grouped seats and is scoped to the group: group name, goal, member count, effective lead (or "no lead"), and the membership caveat. |
| `team_tasks` | team, read-only | `view=mine \| available \| reviews \| board`; pass `taskId` to read one task in full. |
| `team_task` | team | `action=claim \| start \| progress \| submit \| fail \| plan` — everything that mutates a task. `plan` creates 1–30 tasks with dependencies and target slots; it is open to the effective lead, and — in a lead-less group whose `planPolicy` is `any_member` — to every member (see "Who plans" below). Leases renew themselves while the holder is online; there is no `renew`. |
| `team_review` | team | `action=claim \| submit` for independent acceptance (quality roles; implementers cannot review their own work). |
| `team_message` | team | `action=respond \| send \| broadcast \| collect \| inbox \| read`. Messages addressed to the seat arrive **inline through `check_messages`** and are marked read on delivery (see "Team messages ride `check_messages`"); `respond` answers a member-sent directive / question, `send` / `broadcast` / `collect` create and track messages (`broadcast` / `collect` are lead-only), `inbox` lists recent summaries and `read` re-reads one body by `messageId` (only needed for a truncated inline body). |
| `team_memory` | team | `action=search \| propose \| review` for run-scoped decisions, constraints, facts, risks and lessons. `review` is lead / quality only and never self-approving. |
| `team_run` | team | `action=transfer_lead \| claim_lead \| clear_acting_lead` — lead authority inside the caller's **group** (`transfer_lead` only within the group: `target_not_in_group`), requires a `running` run. `claim_lead` decides on the lead's presence alone: an in-flight execution → `lead_busy`, a confirmed Cursor stop (or no binding) → takeover, online → `lead_still_active`, silent without a stop → `lead_liveness_unproven`. There are no probe actions (`ping` / `pong` / `liveness`) and no `start`. |

Schemas are flat objects with optional fields; a missing action-specific argument returns `{ ok: false, code: 'invalid_arguments', message }` naming the field, never a protocol error. They are deliberately **not** discriminated unions: zod renders those as a top-level `oneOf` / `anyOf`, which Anthropic's API rejects for tool input schemas, and one rejected tool fails the whole model request. `tests/mcp-tool-surface.test.ts` locks the flat shape, the exact parameter sets, the action enums and a total definition-size budget. Every response is JSON in both `content` and `structuredContent`; idle-oriented responses carry `nextAction: { type: 'enter_channel_wait', … }` so the Agent returns to `check_messages`.

### Tool surface follows the workspace (phase 4 · 4A)

One MCP process serves one Cursor window, and `tools/list` carries no channel, so visibility is decided **per workspace**, not per seat: while the active run is `running` and has at least one active group (`SqliteTeamControlRepository.hasActiveGroup`), all nine tools are listed; otherwise only `check_messages` and `record_reply` are. The server flips the seven team tools' `enabled` flag together and sends one `notifications/tools/list_changed`; Cursor re-fetches the list. The probe runs once when the server instance is created (so the first `tools/list` is already right) and once before every `check_messages` return — the operator's group change and the members' membership notices are written in the same moment, so a waiting member's poll returns immediately and the `list_changed` precedes the notice body on the same stream. There is no timer. An ungrouped seat in a window that does have a group still sees the team tools and gets `not_in_group` when it calls one; a seat in a window without any group cannot call them at all (the SDK answers "Tool … disabled"). The `joined` membership notice carries the fallback for a host that does not act on `list_changed`: ask the user to reload the `SG Team` entry. Measured with `npm run measure:mcp`: an ungrouped workspace pays ≈ 1 240 fixed tokens per turn (2 tools ≈ 420 + instructions ≈ 820) instead of ≈ 3 860.

### Team messages ride `check_messages` (phase 4 · 4C)

`check_messages` polls the outbox first (user messages, membership notices). When it is empty it queries the seat's unread team messages inside its current group (`listUnreadForRecipient`: `recipient = seat`, `group_id = current group`, `read_at IS NULL`, orphaned receipts excluded, insertion order, at most 10 per delivery) and returns them as one text block headed `【拾光团队消息】CH-N · k 条`: each message with its kind, sender label (`拾光系统` or `角色名 · CH-N`), `需回应` when a response is required, `messageId`, thread subject and the full body (bodies over 4 000 characters are truncated with a pointer to `team_message read`). Delivery marks the receipts `notified` + `read` in one transaction (`markDelivered`, event `message.read` / `delivered_by_check_messages`) and does not open the reply gate — the seat acts on the batch and polls again without `record_reply`. Only **member-sent** `directive` / `question` messages need `team_message respond`; system (operator) dispatches are answered by acting on them (`team_task claim`, `team_review claim`, `team_memory review`), which produce their own receipts. There is no desktop-side dispatcher and no outbox envelope any more: the MCP process reads the collaboration store directly, so team messages arrive even while the desktop app is closed. Envelope rows left in `channel_outbox` by older builds (`kind = 'internal'`) are retired on sight rather than delivered. A user message and team messages that arrive together are not merged into one result: the user message is delivered first and the team batch follows on the poll after `record_reply`, so one result always carries one protocol.

Team tools are scoped to the caller's **collaboration group** when the active run is a session pool (see below): task views and leases, the member directory, inbox / send / broadcast, and run-scoped memory all see the caller's group only; operator views read the whole run. Legacy team runs are archived history (phase 2 · 2B): the v9 migration revokes their agent registrations, so a session still holding one is fenced with `run_completed` instead of being scoped.

### Why nine instead of one tool per service method

The previous surface exposed 35 tools — one per service method (`team_list_mine`, `team_list_available`, `team_list_reviews`, `team_list_board`, `team_get_task` were five ways to "look at tasks"). Models pick tools by name; near-synonyms cost tokens and cause misfires. Grouping by object (tasks / task / review / message / memory / run) keeps each tool's `action` enum as the complete list of what that object can do, and keeps `readOnlyHint` meaningful (`team_tasks` is the only read-only team tool).

## Prompt layering

Every protocol rule is stated once, at the layer that owns it:

| Layer | Text | Owns |
| --- | --- | --- |
| Server `instructions` (once per session) | `buildUnifiedServerInstructions` | the complete protocol: tool map (team tools appear only while the workspace has a group), reply loop, silence rule, boundaries, termination; announces that every session starts solo, that the operator may add / remove it from a group at any time, the exact shape of the membership notice (so a mid-session identity change is not read as an injection) and that `【拾光团队消息】` deliveries are not user messages |
| Launch hint (once per seat) | `buildSoloLaunchHint` (the only kind since phase 2 · 2B: every seat starts solo) | mode/channel, first call and only the dynamic session parameter needed by a solo seat; the Composer binding marker appears exactly once |
| Every real delivery | compact two-line `buildDeliverySuffix` | `CHANNEL_USER_DELIVERY_MARKER` plus the turn-closing `record_reply → check_messages` reminder; the full protocol is not repeated |
| Team message delivery | `buildTeamMessagesDelivery` | the inlined bodies, `需回应` on member directives / questions, and one closing line: "not a user message, no visible reply, no `record_reply`; `respond` what is marked, act on the rest, then `check_messages`" |
| Membership notice delivery | `buildMembershipNoticeSuffix` | "this is a server-side membership change, not a user message, not an injection; no `messageId`, no `record_reply`; act on the body, then `check_messages`" |
| Membership notice body | `buildMembershipNotice` (`joined` / `left` / `dissolved` / `lead_changed`) | group, role, lead, goal and the one next step (`team_check_in` after joining — plus the reload fallback if the team tools have not appeared; communication tools only after leaving) |
| Tool `nextAction` | `buildChannelWaitInstruction` | "go back to `check_messages` silently" |
| `team_check_in` briefing | `buildTeamRoleBriefing` | role mission, boundaries, per-role workflow, collaboration rules — no protocol restatement; the briefing exists only for grouped seats and carries the group goal / lead / member count (run-level goals are gone with the launch step) |

The marker line `【真实用户消息处理完后进入 check_messages 待命】` is also evidence for the Cursor process observer (it separates business thinking from polling noise), so it stays on every real user delivery.

## Session pool, collaboration groups and `not_in_group`

An independent batch is a **session pool**, and since phase 2 · 2B-1 it is the only kind of run the desktop can start (one-shot team runs are archived history; their sessions get `run_completed` from the fence). Every Cursor session is a seat that starts solo — its launch prompt is always the compact `check_messages` instruction, never a team briefing — and only talks to the user through the two communication tools. The desktop operator forms **collaboration groups** inside the pool (run page → 协作组) and may add, remove, re-lead or dissolve at any time. Nothing about the seat's process changes on membership changes — same MCP process, same `session` token, same `channel_id`.

- **Ungrouped seat**: in a window without any group the team tools are not listed at all (phase 4 · 4A); in a window that has a group, every `team_*` call from an ungrouped seat fails with `{ ok: false, code: 'not_in_group', message: 'CH-N 当前是独立席位…', nextAction: { type: 'enter_channel_wait', channelId } }`. The code replaced `solo_channel`; it is not retryable, the Agent simply stays in `check_messages`. Communication tools are unaffected.
- **Identity is re-resolved on every team tool call** (`refreshIdentity`): the seat's group, group role and effective-lead status come from `agent_slots.group_id` / `team_groups` at call time, so a change made by the operator is effective on the Agent's next call. A stale group id can never be used — if the seat left, the refresh itself returns `not_in_group` before the operation runs.
- **Membership notices** are queued into the seat's outbox as `kind: 'membership'` (silent: no timeline entry, no reply gate) and delivered by `check_messages` with `buildMembershipNoticeSuffix`. Bodies start with `【拾光成员关系通知】`:
  - `joined` — group, role, lead, goal, then `team_check_in({channel_id})` to fetch the full briefing;
  - `left` / `dissolved` — back to a solo seat; tasks released / cancelled by the server; only `check_messages` / `record_reply` from now on;
  - `lead_changed` — whether this seat became, or stopped being, the effective lead.
- **Group scope** (write-time `groupId` snapshots): `team_task plan` stamps the planner's group and only accepts same-group dependencies; `team_tasks` / `claim` / `team_review` see same-group tasks (`task_group_mismatch` otherwise); `team_message` directory, inbox, send, broadcast and collect are per group (`recipient_not_in_group`, `thread_group_mismatch`); `team_memory search` / `propose` / `review` are per group for run-scoped items, project-scoped items are shared across groups (`memory_group_mismatch`). Task keys stay unique per run (`duplicate_task_key` across groups).
- **Lead**: a group's effective lead is its acting lead or lead slot, independent of the role template; lead-only actions (`broadcast`, `collect`, `transfer_lead`, and `plan` while a lead exists) follow it, and `team_memory review` accepts the group lead or a quality role.
- **Who plans** (`team_groups.plan_policy`, phase 2 · 2A, decision D2): the user can always create tasks for any group from the desktop (`planTeamGroupTasks`, same aggregate path and checks as `team_task plan`). For Agents: with an effective lead only the lead may `plan`, whatever the policy says; without a lead, `any_member` opens `plan` (and the board view) to every member — their identity carries `coordination` / `planning` for as long as the group has no lead — while `lead_only` means nobody in the group plans and the group only shares goal, messages and memory. A group created without a lead defaults to `any_member`, one created with a lead to `lead_only`; the operator can change it later (`setGroupPlanPolicy`), and members are briefed by a `notice` only when their own planning right actually changed.
- **The desktop is the only scheduler** (phase 2 · 2A, decision D1): dispatching execution and review, chasing stale tasks and re-dispatching after a rejection are done by the orchestrator. The lead receives exactly three kinds of system `notice`: a task reached `done` (with the delivery summary), a task reached `failed` after its last attempt (with the reason and the choice to re-plan), and a group member's Cursor session was confirmed stopped (`attention`). It no longer gets "please look into this" copies of stale-task or unanswered-directive reminders; those go to the assignee / sender only. Members' claim / start / progress / submit / fail / review actions produce the `status` reports to the lead automatically — the briefing tells them not to hand-write a second one.
- **Server-side reactions to a departure** (the Agent does not have to do anything): leased attempts and reviews held by the leaver go back to the queue, tasks planned *for* that seat lose their target so others can claim them, unanswered directives / questions to the leaver are marked orphaned and are not chased, and the group lead receives a `notice`.

## Install from the desktop app

Creating a session pool from the 运行 page (`TeamControlService.createSessionPool`, the only run-creating entry point since phase 2 · 2B-1) registers the pool's seats with the server in the same repository transaction that writes the run:

- registers a fresh agent generation in SQLite and revokes the previous generation;
- does not write the workspace `.cursor/mcp.json` at all — the only MCP entry is the global one below;
- never requires a Cursor reload: the global entry is watched natively, so there is no "restart required" state anywhere in the app;
- reports failures as IPC errors; nothing is written to disk besides SQLite, so there is nothing to roll back.

The single native `SG Team` entry in the global `~/.cursor/mcp.json` is registered at app startup; the production bundle lives outside `app.asar` so Cursor can execute it with `ELECTRON_RUN_AS_NODE=1`.

## Process-bound identity

The model never supplies its identity or a lease token. One unified server process serves every channel; the process is bound to the task database by environment, and each tool call carries `channel_id`:

```json
{
  "mcpServers": {
    "SG Team": {
      "command": "/Applications/拾光.app/Contents/MacOS/拾光",
      "args": ["/Applications/拾光.app/Contents/Resources/mcp/index.mjs"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "SG_TEAM_DB": "/absolute/path/to/task-pool.sqlite3",
        "SG_TEAM_SERVER_ROLE": "unified",
        "SG_TEAM_APP_VERSION": "0.3.2"
      }
    }
  }
}
```

On Windows `command` is the installed `ShiGuang.exe` (ASCII executable name via `build.win.executableName`; the product/shortcut name stays 拾光) and `args` points at `resources/mcp/index.mjs`. `SG_TEAM_APP_VERSION` is not read by the server: it is the desktop's version stamp, so the first start after an in-place upgrade changes the entry and Cursor reloads the server with the new bundle (an unchanged entry is never rewritten, and an unchanged path alone would leave the old server process running until Cursor restarts).

The Agent identity is `workspace hash + channel + install generation`. It is intentionally not treated as a permanent conversation identity. Every MCP tool call checks the active SQLite registration; reinstalling revokes older generations, so a stale Cursor MCP process cannot claim or mutate tasks.

## Communication tools and the session fence

`check_messages` and `record_reply` are the only user-facing communication tools. Both take `channel_id` and an optional `session`:

```text
check_messages({ channel_id: '2', session?: '<seat token>', tick?: '<poll cursor>' })
record_reply({ channel_id: '2', session?: '<seat token>', content, title? })
```

(Phase 4 · 4B removed `check_messages.reply` — a second way to say `record_reply` — and `record_reply.groupId / taskId / files`, which nothing read.)

- `tick` is the anti-loop poll cursor: every non-error `check_messages` result (delivery suffix and keepalive body alike) names the exact next call with a fresh, monotonically increasing `tick` (the persisted per-channel turn counter). The agent echoes the latest value on every poll so no two consecutive calls share identical arguments — host IDE "repeated/looping tool call" safeguards key on identical calls and would otherwise misfire on the long-poll pattern and talk the agent into stopping (2026-09-12 incident). The server never validates `tick`; it is fail-open and safe to omit (first call, legacy sessions).

- `session` is the per-seat token (`^[a-zA-Z0-9_-]{8,128}$`) that the launch hint / role briefing hands to the Cursor session. It is issued when the seat is installed and rotated only when the seat is rebuilt (`prepareComposerRelaunch`); nothing else touches it — a membership transfer (phase 2 · 2C) moves the seat's *group identity* to another seat and leaves both seats' tokens, bindings and Composers alone (standby auto-takeover and the binding-moving manual handoff are gone since 2B-2 / 2C). The Agent never invents it; if the launch instruction did not include one, the call is made without it.
- Without `session` the call is `legacy` and follows the previous contract unchanged (sessions created before the upgrade).
- With `session` the server checks the channel's owner in the active run before any presence write. Mismatch, an unbound channel, a completed run or no active run returns a **retired** result:
  - `check_messages` → plain text starting with `[system] 会话围栏：…`, telling the Agent this is a server-side stop equivalent to the user asking it to stop: no further `check_messages` / `record_reply`, no visible reply, no retry.
  - `record_reply` → `isError` with `{ ok: false, code: 'session_retired', message }`; nothing is stored.
  - A retired caller never refreshes `channel_presence`, so the new seat on the same channel is not lit up by the old session.
- Ownership lookups that fail (for example a locked database) fail open: the fence only rejects on positive evidence.

Presence phases seen by the desktop: `waiting` / `keepalive` / `processing` / `need_reply_sync` (protocol), `cursor_stopped` / `tool_aborted` (explicit termination), `retired` (scope moved to another run; explicit stop until new life evidence), `reviving` (transition after a heartbeat or CDP activity revives a stopped phase).

## Workflow contract

```text
team_tasks(view) -> team_task(claim) -> team_task(start) -> team_task(progress)* -> team_task(submit)
                                                                                \-> team_task(fail) -> queued or failed
team_tasks(view: 'reviews') -> team_review(claim) -> team_review(submit: accept | reject)
```

Claim, start and submit are retry-safe. The lease token remains inside SQLite and the process-bound service. A process with a different generation cannot operate the attempt.

**Leases renew themselves** (phase 2 · 2F, decision D3=a). A lease is reclaimed only when it has run out *and* its holder's channel is offline by the presence rule (`isPresenceOnline`: MCP heartbeats and CDP runtime evidence, whichever is newer, with the 5-minute processing grace). While the holder is online the server extends the lease, so a long build or a long turn — which by protocol touches no MCP tool — no longer loses the task. There is no `renew` action (phase 4 · 4D removed it from `team_task` / `team_review` together with `ttlSeconds`).

Run the stdio smokes and the surface measurement with:

```bash
npm run build:mcp
npm run smoke:mcp        # grouped workspace: owner, wrong generation, resumed owner, reviewer; exact nine-tool surface
npm run smoke:channel    # ungrouped → two tools; group → nine via list_changed; not_in_group; inline team message
npm run measure:mcp      # tokens per turn for the ungrouped and grouped workspace, plus the three briefings
```

The group contract above is locked against the real stdio process (source entry, `tsx src/mcp/index.ts`, same SQLite file as the desktop side) by `tests/channel-mcp-stdio-groups.integration.test.ts`: two tools while ungrouped → operator creates a group → membership notice through `check_messages` with the team tools appearing via `list_changed` → grouped `team_check_in` briefing → two groups see only their own tasks → member removed → `not_in_group` → both groups dissolved → two tools again, with the seat tokens and fence verdicts unchanged throughout. The inline team-message flow (plan → dispatch → claim → review → memory review with zero envelope rows and zero `team_message` calls) is locked by `tests/team-three-channel.e2e.test.ts`.

The packaged-app path is separately verified with `npm run verify:mac` / `npm run verify:win`.
