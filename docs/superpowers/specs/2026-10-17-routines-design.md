# agenv: scheduled routines — design

Date: 2026-10-17 · Status: **implemented in the 1.7.0 branch (`feat/routines-impl`); not yet merged or published** · Target release: 1.7.0 · Builds on the TypeScript backend (1.5.0, merged, unreleased) and on **agents** (`2026-10-17-agents-design.md`, 1.6.0)

## 1. Goal and intent

Let a user say "every weekday at 9, have **this agent** do X" and have agenv run it **unattended**, keep a history of
what happened and what it cost, and let the user jump into any run as a normal interactive terminal. "This agent" is an
**agent** from the agents spec: a named specialist with its own folder, conversation, skills and sources — the routine
runs the CLI from the agent's folder, so the agent's `CLAUDE.md`, `.claude/skills`, `.mcp.json` and the developer's own
authentication and MCP servers all apply (no connectors, no stored credentials).

Said by the user (2026-10-16, decisions already made):
- Modelled on Paperclip's routines (cron + timezone, concurrency and missed-run policies, run history, run via the agent CLI).
- Unattended runs default to a **safe permission mode** chosen per routine; "skip all permissions" only as an explicit opt-in with a warning.
- A run executes **headless** (`claude -p --output-format stream-json`, resuming the linked conversation) with a live read-only log, plus an **"Open interactively"** button.
- Routines are assigned to agents (added 2026-10-17); agents are built first (1.6.0), then routines (1.7.0), then agent-to-agent tasks and messaging (1.8.0) on the same run queue.

Success: a routine fires on time (in its timezone, across DST), never overlaps itself unless asked, can't run away
(per-run budget, daily caps, global pause), survives an agenv restart without double-firing or silently losing runs,
and every run is inspectable (status, cost, log) and resumable.

Out of scope for 1.7.0: webhook/API triggers, routine revision history/undo, agent-to-agent tasks and messaging
(1.8.0), non-Claude agents (the runner is a Strategy, so others can be added), multi-user separation.
Creating, forking and compacting agents/conversations belongs to the agents spec, not here.

## 2. Concepts

- **Routine** — a named schedule + prompt + folder + target + permission settings.
- **Run** — one execution of a routine (scheduled, manual, or catch-up). Has a status, cost, duration, log.
- **Executor** — how a run actually executes. 1.7.0 ships `AgentRunExecutor`, a thin layer over `AgentService` and the agents' shared runner.
- **Automation switch** — a global "Pause all automation" flag plus global caps, checked before any run starts.

## 3. Data model

`Routine` (stored in `~/.agenv-routines.enc`, same encrypted-file Repository as the other stores):

| field | meaning |
|---|---|
| `id` | short random id |
| `name` | display name (≤ 64) |
| `enabled` | scheduler ignores disabled routines |
| `cron`, `timezone` | 5-field cron (presets: hourly, daily 09:00, weekdays 09:00, weekly Mon 09:00) + IANA timezone (default: the machine's) |
| `prompt` | what the agent is asked to do (≤ 20 000 chars) |
| `target` | `{ kind: "agent", agentId }` (**the normal case**: folder, conversation, instructions, extra sources, MCP config and model come from the agent); or `{ kind: "folder", cwd }` for a one-off routine without an agent (new conversation); `cwd` must be an absolute path and is stored normalised |
| `conversation` | for agent targets: `"agent"` (default) — resume the agent's own conversation, so its context accumulates (runs for one conversation are serialised); `"fork"` — run in a throw-away fork of the agent's conversation each time, leaving the agent's conversation untouched; `"fresh"` — a new conversation each run |
| `permission` | `{ mode: "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions", allowedTools: string[] }` — see §6; defaults to `acceptEdits` when the routine does not set one. The agent's own permission is **not** inherited |
| `model` | optional `--model` override of the agent's |
| `maxBudgetUsd` | per-run cap passed as `--max-budget-usd` (default **2**). The CLI checks it after each turn, so a run can overshoot slightly |
| `timeoutMin` | kill a run after this long (default 20, max 120) |
| `concurrency` | `coalesce_if_active` (default) \| `skip_if_active` \| `always_enqueue` |
| `catchUp` | `skip_missed` (default) \| `enqueue_missed_with_cap` (cap 25, never for schedules firing more often than hourly) |
| `maxRunsPerDay` | optional per-routine cap; "a day" runs from machine-local midnight (as does the global daily cost cap) |
| `nextRunAt`, `lastRunAt` | persisted so a restart neither re-fires nor forgets |

`Run` (history in `~/.agenv-runs.enc`, newest 500; per-run log in `~/.agenv-runs/<runId>.log`, ≤ 5 MB, tail kept):
`id, routineId, trigger (schedule|manual|catch_up), status (queued|running|succeeded|failed|timed_out|cancelled|skipped|coalesced), reason, queuedAt, startedAt, finishedAt, durationMs, costUsd, numTurns, conversationId, exitCode, error, summary` (the final result text, ≤ 2 000 chars).

## 4. Architecture (new classes, `src/automation/`)

```
cron.ts               parse + next-fire calculation in an IANA zone (the tested lib/cron.js, ported to TypeScript)
Routine.ts            types + validation (cron, timezone, limits, enums)
RoutineStore.ts       CRUD over JsonStore<Routine[]>
RunStore.ts           run history (JsonStore) + log files
RunExecutor.ts        interface (Strategy): execute(run, routine, hooks) → { status, costUsd, ... }; AgentRunExecutor resolves the routine's agent (or folder) and delegates to `AgentService`, which uses the agents' shared `ClaudeRunner`
                      (`src/agents/ClaudeRunner.ts`: arguments, spawn, stream-json log, tree-kill, timeout, budget) — no second copy
RunQueue.ts           FIFO with a global parallel limit (default 2); a run whose agent/folder already has a started run stays queued (keyOf) and later runs with other keys start first, so a busy agent never holds a slot
RoutineScheduler.ts   30 s tick; claims due routines; applies concurrency/catch-up policies and the guards
AutomationGuards.ts   global pause, daily run/cost caps, per-routine daily cap — checked before a run starts
AutomationOwnership.ts  ~/.agenv-automation.lock: only one agenv instance on a machine runs the schedules
```
They are wired in `runtime.ts` like every other service. There is no `run:update` bus: every routine, run or settings change
calls one `onChange`, which a `ChangeBatcher` turns into a single `WsGateway.broadcastEvent("runs-updated")` per burst,
and open browsers refetch (no new socket protocol).

HTTP (`src/http/routes/routines.ts`, authenticated; writes added to the tunnel read-only list):
`GET/POST /api/routines`, `PUT/DELETE /api/routines/:id`, `POST /api/routines/:id/run` (run now),
`GET /api/routines/:id/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/log?tail=`, `POST /api/runs/:id/cancel`,
`POST /api/runs/:id/open` (creates a normal session in the run's folder running `claude --resume <conversationId>`),
`GET/PUT /api/automation` (pause flag, global caps; GET also says whether this instance owns the schedules: `owner`, `ownerPort`).
`GET /api/routines` carries each routine's newest run (`lastRun`) and its `activeRuns` count, so the panel needs no per-routine call.

## 5. How a run works

1. **Fire.** Every 30 s the scheduler selects enabled routines with `nextRunAt <= now`, claims each by advancing
   `nextRunAt` to the next cron time *before* doing anything else (so a crash can't double-fire), then creates a Run.
2. **Policy.** Runs are serialised **per conversation**, so two routines of one agent (or a routine and a message in 1.8.0)
   queue behind each other instead of writing the same conversation. If the routine already has a queued/running run: `coalesce_if_active` links the new firing to it
   (status `coalesced`, no new process), `skip_if_active` records `skipped`, `always_enqueue` queues another.
   If the target conversation is being used interactively right now (the session's `claudeRunning`), the run is
   `skipped` with that reason — two processes must not write one conversation.
3. **Guards.** Skipped (with reason) when automation is paused, the folder is missing, or a daily run/cost cap is reached.
4. **Execute.** The queue starts it when a slot is free:
   `claude -p --output-format stream-json --verbose --resume <conversationId> --permission-mode <mode> [--allowedTools …]
   [--model …] [--append-system-prompt …] [--append-system-prompt-file …] [--add-dir …] [--mcp-config …]
   --max-budget-usd <n> -- <prompt>`, the prompt is passed as an argument after `--` (not on stdin), `cwd` = the **agent's folder** (agents spec §5). With `conversation: "fork"` the
   resume adds `--fork-session`; with `"fresh"` there is no `--resume`.
   The executor does not spawn anything itself: it delegates to `AgentService` (`run` / `runInFolder`), which uses the shared `ClaudeRunner`.
   stdout lines go to the run's log, which the panel tails. The Run record itself (turns, cost, summary) is written once, when the run finishes: turns and partial text are not updated live.
5. **Finish.** The final `result` event gives cost, turns, conversation id and text. The Run becomes
   `succeeded`/`failed`; a timeout kills the whole process tree (`taskkill /T /F` on Windows) → `timed_out`;
   cancel does the same → `cancelled`. If the agent had no conversation yet, the new one is saved on the agent. (Verified result
   fields: `result`, `session_id`, `total_cost_usd`, `num_turns`, `duration_ms`, `is_error`.)
6. **Missed runs.** At startup, a routine whose `nextRunAt` is in the past follows its `catchUp` policy: `skip_missed`:
   slots older than the grace window (max(2 min, 4 x tick interval)) are not run; the schedule jumps to the next future slot; a visible skipped
   row records how many were missed. A slot within the grace fires normally (so a quick restart still fires it, once). `enqueue_missed_with_cap`
   replays up to 25 of the missed slots (never for sub-hourly schedules).
7. **Open interactively.** The agent's "Open terminal": an ordinary agenv session running `claude --resume <conversationId>`
   in the agent's folder — from there it is a normal terminal (the Claude linking picks it up). For `"fork"` runs it opens the run's fork.

## 6. Safety (unattended means nobody can answer a prompt)

- **Permission modes** per routine, shown in plain words in the UI: *Read-only* (`plan`), *Edit files* (`acceptEdits`,
  **default**), *Allowlist* (`dontAsk` + `allowedTools`, e.g. `Bash(git status)`), *Skip all permissions*
  (`bypassPermissions`). Skip-all needs an explicit checkbox and a warning that the agent can run any command unattended;
  it is never the default and is never set implicitly.
- **Budgets:** per-run `--max-budget-usd` (default $2; the CLI checks it after each turn, so a run can overshoot slightly),
  optional per-routine runs/day, global daily cost cap (`automation.maxDailyCostUsd`, default none) — all checked *before*
  spawning, against machine-local midnight.
- **Global pause** stops the scheduler and refuses manual runs until resumed; running runs are not killed unless asked.
- **Isolation:** the child gets the server's environment minus agenv's own token; logs are capped; the routines API sits
  behind the same auth, rate limit and tunnel read-only rule as everything else.
- An unattended agent can still change files in its folder in `acceptEdits` mode. That is the point of the feature and
  is stated in the UI where the mode is chosen.

## 7. UI (`public/modules/routines.js`, a new sidebar panel)

List of routines (name, schedule in words, next run, last result/cost, enable toggle, run-now); create/edit dialog
(name, schedule preset or custom cron + timezone, prompt, folder, target session or new conversation, permission mode,
budget); an **agent picker** (agents are created in the Agents section); runs list per routine (status, started, duration, cost); a run view that tails the log while it runs;
"Open interactively" and "Cancel"; a global **Pause all automation** control in the panel header; failures raise the
existing toast. In-app dialog (`askText`) pattern, no `prompt()`.

## 8. Testing

- Unit (fake clock, fake executor): cron next-fire incl. DST and invalid input; store validation; scheduler claim-before-run,
  all concurrency and catch-up policies, restart with a past `nextRunAt`, guards; queue limits; guards' caps.
- Executor against a **fake `claude`** (a node script) emitting stream-json: success, failure, timeout kill, cancel,
  budget exhaustion, malformed lines, `--resume` argument construction. `AGENV_CLAUDE_BIN` selects the binary (default `claude`).
- API tests through `buildRuntime` with the fake executor; golden master unchanged (new routes are additive).
- One browser flow: create a routine, run it now against the fake claude, watch the log, open interactively.
- No test spends real money or calls the real Claude.

## 9. Risks and open points

- stream-json event shapes are Claude Code's, not agenv's: parse defensively (unknown lines are logged, never fatal);
  an implementation spike confirms the `result` event fields (`total_cost_usd`, `num_turns`, `session_id`) on the installed version.
- Windows process-tree kill on timeout/cancel (the executor kills the tree, not just the shell).
- A routine resuming a conversation that was deleted or is corrupt: the run fails with Claude's message and the routine
  keeps its schedule (it does not silently start a new conversation).
- Defaults proposed for review (change freely): permission `acceptEdits`, budget $2/run, 20 min timeout, 2 parallel runs,
  `coalesce_if_active`, `skip_missed`, `conversation: "agent"`.
