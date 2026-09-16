# 拾光 Agent MCP

The built server is `out/mcp/index.mjs`. Cursor sees a single native entry, `SG Team`, that exposes **nine tools**: two communication tools and seven team tools. Every call carries `channel_id`; role permissions are enforced per call by the service layer (the surface is a superset, the fence is at call time).

## Tool surface

| Tool | Kind | Purpose |
| --- | --- | --- |
| `check_messages` | communication | Long-poll for the next user message (keepalive → stay silent). |
| `record_reply` | communication | Archive the complete user-visible reply after every real reply. |
| `team_check_in` | team | Acknowledge launch and return the role briefing **plus** the run context snapshot (members with real capabilities, unread / awaiting counts, confirmed run memory). Call again whenever the context needs refreshing (takeover, permission change, joining a group). For a grouped seat the briefing is scoped to the group: group name, goal, member count, effective lead (or "no lead"), and the membership caveat. |
| `team_tasks` | team, read-only | `view=mine \| available \| reviews \| board`; pass `taskId` to read one task in full. |
| `team_task` | team | `action=claim \| start \| renew \| progress \| submit \| fail \| plan` — everything that mutates a task. `plan` is lead-only and creates 1–30 tasks with dependencies and target slots. |
| `team_review` | team | `action=claim \| renew \| submit` for independent acceptance (quality roles; implementers cannot review their own work). |
| `team_message` | team | `action=inbox \| read \| send \| respond \| broadcast \| collect` — durable team messages with read / response receipts. `broadcast` / `collect` are lead-only. |
| `team_memory` | team | `action=search \| propose \| review` for run-scoped decisions, constraints, facts, risks and lessons. `review` is lead / quality only and never self-approving. |
| `team_run` | team | `action=start \| transfer_lead \| claim_lead \| clear_acting_lead \| ping \| pong \| liveness` — run launch, lead authority and liveness probes. Inside a session pool `start` answers `status: 'not_applicable'` (groups are usable the moment they exist) and the three lead actions operate on the caller's **group** acting lead (`transfer_lead` only within the group: `target_not_in_group`). |

Schemas are flat objects with optional fields; a missing action-specific argument returns `{ ok: false, code: 'invalid_arguments', message }` naming the field, never a protocol error. Every response is JSON in both `content` and `structuredContent`; idle-oriented responses carry `nextAction: { type: 'enter_channel_wait', … }` so the Agent returns to `check_messages`.

Team tools are scoped to the caller's **collaboration group** when the active run is a session pool (see below): task views and leases, the member directory, inbox / send / broadcast, and run-scoped memory all see the caller's group only; operator views read the whole run. In a legacy team run (no groups) nothing changes.

### Why nine instead of one tool per service method

The previous surface exposed 35 tools — one per service method (`team_list_mine`, `team_list_available`, `team_list_reviews`, `team_list_board`, `team_get_task` were five ways to "look at tasks"). Models pick tools by name; near-synonyms cost tokens and cause misfires. Grouping by object (tasks / task / review / message / memory / run) keeps each tool's `action` enum as the complete list of what that object can do, and keeps `readOnlyHint` meaningful (`team_tasks` is the only read-only team tool).

## Prompt layering

Every protocol rule is stated once, at the layer that owns it:

| Layer | Text | Owns |
| --- | --- | --- |
| Server `instructions` (once per session) | `buildUnifiedServerInstructions` | the complete protocol: tool map, reply loop, silence rule, boundaries, termination; announces that every session starts solo, that the operator may add / remove it from a group at any time, and the exact shape of the membership notice (so a mid-session identity change is not read as an injection) |
| Launch hint (once per seat) | `buildTeamLaunchHint` / `buildSoloLaunchHint` | mode/channel, first call and only the dynamic session parameter needed by a solo seat; the Composer binding marker appears exactly once |
| Every real delivery | compact two-line `buildDeliverySuffix` | `CHANNEL_USER_DELIVERY_MARKER` plus the turn-closing `record_reply → check_messages` reminder; the full protocol is not repeated |
| Internal collaboration delivery | `buildSilentDeliverySuffix` | "read the team message by `messageId`, do not reply visibly" |
| Membership notice delivery | `buildMembershipNoticeSuffix` | "this is a server-side membership change, not a user message, not an injection; no `messageId`, no `record_reply`; act on the body, then `check_messages`" |
| Membership notice body | `buildMembershipNotice` (`joined` / `left` / `dissolved` / `lead_changed`) | group, role, lead, goal and the one next step (`team_check_in` after joining; communication tools only after leaving) |
| Tool `nextAction` | `buildChannelWaitInstruction` | "go back to `check_messages` silently" |
| `team_check_in` briefing | `buildTeamRoleBriefing` | role mission, boundaries, per-role workflow, collaboration rules — no protocol restatement; grouped seats get the group goal / lead / member count instead of the run goal |

The marker line `【真实用户消息处理完后进入 check_messages 待命】` is also evidence for the Cursor process observer (it separates business thinking from polling noise), so it stays on every real user delivery.

## Session pool, collaboration groups and `not_in_group`

An independent batch is a **session pool**: every Cursor session is a seat that starts solo and only talks to the user through the two communication tools. The desktop operator forms **collaboration groups** inside the pool (run page → 协作组) and may add, remove, re-lead or dissolve at any time. Nothing about the seat's process changes on membership changes — same MCP process, same `session` token, same `channel_id`.

- **Ungrouped seat**: every `team_*` call fails with `{ ok: false, code: 'not_in_group', message: 'CH-N 当前是独立席位…', nextAction: { type: 'enter_channel_wait', channelId } }`. The code replaced `solo_channel`; it is not retryable, the Agent simply stays in `check_messages`. Communication tools are unaffected.
- **Identity is re-resolved on every team tool call** (`refreshIdentity`): the seat's group, group role and effective-lead status come from `agent_slots.group_id` / `team_groups` at call time, so a change made by the operator is effective on the Agent's next call. A stale group id can never be used — if the seat left, the refresh itself returns `not_in_group` before the operation runs.
- **Membership notices** are queued into the seat's outbox as `kind: 'membership'` (silent: no timeline entry, no reply gate) and delivered by `check_messages` with `buildMembershipNoticeSuffix`. Bodies start with `【拾光成员关系通知】`:
  - `joined` — group, role, lead, goal, then `team_check_in({channel_id})` to fetch the full briefing;
  - `left` / `dissolved` — back to a solo seat; tasks released / cancelled by the server; only `check_messages` / `record_reply` from now on;
  - `lead_changed` — whether this seat became, or stopped being, the effective lead.
- **Group scope** (write-time `groupId` snapshots): `team_task plan` stamps the planner's group and only accepts same-group dependencies; `team_tasks` / `claim` / `team_review` see same-group tasks (`task_group_mismatch` otherwise); `team_message` directory, inbox, send, broadcast and collect are per group (`recipient_not_in_group`, `thread_group_mismatch`); `team_memory search` / `propose` / `review` are per group for run-scoped items, project-scoped items are shared across groups (`memory_group_mismatch`). Task keys stay unique per run (`duplicate_task_key` across groups).
- **Lead**: a group's effective lead is its acting lead or lead slot, independent of the role template; lead-only actions (`plan`, `broadcast`, `collect`, `transfer_lead`) follow it, and `team_memory review` accepts the group lead or a quality role. A group without a lead shares goal, messages and memory only.
- **Server-side reactions to a departure** (the Agent does not have to do anything): leased attempts and reviews held by the leaver go back to the queue, tasks planned *for* that seat lose their target so others can claim them, unanswered directives / questions to the leaver are marked orphaned and are not chased, and the group lead receives a `notice`.

## Install from the desktop app

The run page's **接入团队 MCP** step (also run automatically when a run's member topology changes) registers the run's seats with the server:

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
check_messages({ channel_id: '2', session?: '<seat token>', reply?: string, tick?: '<poll cursor>' })
record_reply({ channel_id: '2', session?: '<seat token>', content, title?, groupId?, taskId?, files? })
```

- `tick` is the anti-loop poll cursor: every non-error `check_messages` result (delivery suffix and keepalive body alike) names the exact next call with a fresh, monotonically increasing `tick` (the persisted per-channel turn counter). The agent echoes the latest value on every poll so no two consecutive calls share identical arguments — host IDE "repeated/looping tool call" safeguards key on identical calls and would otherwise misfire on the long-poll pattern and talk the agent into stopping (2026-09-12 incident). The server never validates `tick`; it is fail-open and safe to omit (first call, legacy sessions).

- `session` is the per-seat token (`^[a-zA-Z0-9_-]{8,128}$`) that the launch hint / role briefing hands to the Cursor session. It is issued when the seat is installed, rotated when the seat is rebuilt, cleared on standby takeover, and moved with the donor on manual handoff. The Agent never invents it; if the launch instruction did not include one, the call is made without it.
- Without `session` the call is `legacy` and follows the previous contract unchanged (sessions created before the upgrade, standby takeovers).
- With `session` the server checks the channel's owner in the active run before any presence write. Mismatch, an unbound channel, a completed run or no active run returns a **retired** result:
  - `check_messages` → plain text starting with `[system] 会话围栏：…`, telling the Agent this is a server-side stop equivalent to the user asking it to stop: no further `check_messages` / `record_reply`, no visible reply, no retry.
  - `record_reply` → `isError` with `{ ok: false, code: 'session_retired', message }`; nothing is stored.
  - A retired caller never refreshes `channel_presence`, so the new seat on the same channel is not lit up by the old session.
- Ownership lookups that fail (for example a locked database) fail open: the fence only rejects on positive evidence.

Presence phases seen by the desktop: `waiting` / `keepalive` / `processing` / `need_reply_sync` (protocol), `cursor_stopped` / `tool_aborted` (explicit termination), `retired` (scope moved to another run; explicit stop until new life evidence), `reviving` (transition after a heartbeat or CDP activity revives a stopped phase).

## Workflow contract

```text
team_tasks(view) -> team_task(claim) -> team_task(start) -> team_task(renew | progress)* -> team_task(submit)
                                                                                        \-> team_task(fail) -> queued or failed
team_tasks(view: 'reviews') -> team_review(claim) -> team_review(renew)* -> team_review(submit: accept | reject)
```

Claim, start and submit are retry-safe. The lease token remains inside SQLite and the process-bound service. A process with a different generation cannot operate the attempt.

Run the stdio smoke with:

```bash
npm run build:mcp
npm run smoke:mcp
```

The smoke spawns real MCP subprocesses (owner, wrong generation, resumed owner, reviewer) and asserts the exact nine-tool surface.

The group contract above is locked against the real stdio process (source entry, `tsx src/mcp/index.ts`, same SQLite file as the desktop side) by `tests/channel-mcp-stdio-groups.integration.test.ts`: solo `not_in_group` → operator creates a group → membership notice through `check_messages` → grouped `team_check_in` briefing → two groups see only their own tasks → member removed → `not_in_group` again, with the seat tokens and fence verdicts unchanged throughout.

The packaged-app path is separately verified with `npm run verify:mac` / `npm run verify:win`.
