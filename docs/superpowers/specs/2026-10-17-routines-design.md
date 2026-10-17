# agenv: scheduled routines — design

Date: 2026-10-17 · Status: draft for review · Target release: 1.6.0 · Builds on the TypeScript backend (1.5.0, merged, unreleased)

## 1. Goal and intent

Let a user say "every weekday at 9, have this agent do X in this folder" and have agenv run it **unattended**, keep a
history of what happened and what it cost, and let the user jump into any run as a normal interactive terminal.

Said by the user (2026-10-16, decisions already made):
- Modelled on Paperclip's routines (cron + timezone, concurrency and missed-run policies, run history, run via the agent CLI).
- Unattended runs default to a **safe permission mode** chosen per routine; "skip all permissions" only as an explicit opt-in with a warning.
- A run executes **headless** (`claude -p --output-format stream-json`, resuming the linked conversation) with a live read-only log, plus an **"Open interactively"** button.
- Routines first, then agent-to-agent tasks (1.7.0) on the same run queue.

Success: a routine fires on time (in its timezone, across DST), never overlaps itself unless asked, can't run away
(per-run budget, daily caps, global pause), survives an agenv restart without double-firing or silently losing runs,
and every run is inspectable (status, cost, log) and resumable.

Out of scope for 1.6.0: webhook/API triggers, routine revision history/undo, agent-to-agent tasks and messaging
(1.7.0), non-Claude agents (the executor is a Strategy, so others can be added), multi-user separation.

## 2. Concepts

- **Routine** — a named schedule + prompt + folder + target + permission settings.
- **Run** — one execution of a routine (scheduled, manual, or catch-up). Has a status, cost, duration, log.
- **Executor** — how a run actually executes. 1.6.0 ships `HeadlessClaudeExecutor`.
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
| `cwd` | folder to run in (must exist when the run starts) |
| `target` | `{ kind: "session", sessionId }` → resume that agenv session's linked Claude conversation; or `{ kind: "new" }` |
| `freshEachRun` | `false` (default): later runs resume the same conversation, so a daily check accumulates context; `true`: start a new conversation every time |
| `conversationId` | the conversation this routine resumes (set from the target session's link, or from the first run's result) |
| `permission` | `{ mode: "plan" \| "acceptEdits" \| "dontAsk" \| "bypassPermissions", allowedTools: string[] }` — see §6 |
| `model` | optional `--model` |
| `maxBudgetUsd` | per-run cap passed as `--max-budget-usd` (default **2**) |
| `timeoutMin` | kill a run after this long (default 20, max 120) |
| `concurrency` | `coalesce_if_active` (default) \| `skip_if_active` \| `always_enqueue` |
| `catchUp` | `skip_missed` (default) \| `enqueue_missed_with_cap` (cap 25, never for schedules firing more often than hourly) |
| `maxRunsPerDay` | optional per-routine cap |
| `nextRunAt`, `lastRunAt` | persisted so a restart neither re-fires nor forgets |

`Run` (history in `~/.agenv-runs.enc`, newest 500; per-run log in `~/.agenv-runs/<runId>.log`, ≤ 5 MB, tail kept):
`id, routineId, trigger (schedule|manual|catch_up), status (queued|running|succeeded|failed|timed_out|cancelled|skipped|coalesced), reason, queuedAt, startedAt, finishedAt, durationMs, costUsd, numTurns, conversationId, exitCode, error, summary` (the final result text, ≤ 2 000 chars).

## 4. Architecture (new classes, `src/automation/`)

```
cron.ts               parse + next-fire calculation in an IANA zone (the tested lib/cron.js, ported to TypeScript)
Routine.ts            types + validation (cron, timezone, limits, enums)
RoutineStore.ts       CRUD over JsonStore<Routine[]>
RunStore.ts           run history (JsonStore) + log files
RunExecutor.ts        interface (Strategy): execute(run, routine, hooks) → { status, costUsd, ... }
HeadlessClaudeExecutor.ts   spawns `claude -p ...`, streams stream-json to the log, parses the final result
RunQueue.ts           FIFO with a global parallel limit (default 2) and per-routine "active" lookup
RoutineScheduler.ts   30 s tick; claims due routines; applies concurrency/catch-up policies and the guards
AutomationGuards.ts   global pause, daily run/cost caps, per-routine daily cap — checked before a run starts
```
They are wired in `runtime.ts` like every other service and publish `run:update` events on a small typed bus; the
existing `WsGateway.broadcastEvent("runs-updated")` tells open browsers to refetch (no new socket protocol).

HTTP (`src/http/routes/routines.ts`, authenticated; writes added to the tunnel read-only list):
`GET/POST /api/routines`, `PUT/DELETE /api/routines/:id`, `POST /api/routines/:id/run` (run now),
`GET /api/routines/:id/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/log?tail=`, `POST /api/runs/:id/cancel`,
`POST /api/runs/:id/open` (creates a normal session in the run's folder running `claude --resume <conversationId>`),
`GET/PUT /api/automation` (pause flag, global caps).

## 5. How a run works

1. **Fire.** Every 30 s the scheduler selects enabled routines with `nextRunAt <= now`, claims each by advancing
   `nextRunAt` to the next cron time *before* doing anything else (so a crash can't double-fire), then creates a Run.
2. **Policy.** If the routine already has a queued/running run: `coalesce_if_active` links the new firing to it
   (status `coalesced`, no new process), `skip_if_active` records `skipped`, `always_enqueue` queues another.
   If the target conversation is being used interactively right now (the session's `claudeRunning`), the run is
   `skipped` with that reason — two processes must not write one conversation.
3. **Guards.** Skipped (with reason) when automation is paused, the folder is missing, or a daily run/cost cap is reached.
4. **Execute.** The queue starts it when a slot is free:
   `claude -p --output-format stream-json --verbose [--resume <conversationId>] --permission-mode <mode>
   [--allowedTools …] [--model …] --max-budget-usd <n>`, prompt on stdin, `cwd` = the routine's folder.
   stdout lines go to the run's log and a few fields (turns, partial text) update the Run live.
5. **Finish.** The final `result` event gives cost, turns, conversation id and text. The Run becomes
   `succeeded`/`failed`; a timeout kills the whole process tree (`taskkill /T /F` on Windows) → `timed_out`;
   cancel does the same → `cancelled`. If the routine had no conversation, the new one is saved for next time (unless `freshEachRun`).
6. **Missed runs.** At startup, a routine whose `nextRunAt` is in the past follows its `catchUp` policy: `skip_missed`
   fires once and jumps ahead; `enqueue_missed_with_cap` replays up to 25 (never for sub-hourly schedules).
7. **Open interactively.** Creates an ordinary agenv session and types `claude --resume <conversationId>` in the run's
   folder — from there it is a normal terminal (and the existing Claude linking picks it up).

## 6. Safety (unattended means nobody can answer a prompt)

- **Permission modes** per routine, shown in plain words in the UI: *Read-only* (`plan`), *Edit files* (`acceptEdits`,
  **default**), *Allowlist* (`dontAsk` + `allowedTools`, e.g. `Bash(git status)`), *Skip all permissions*
  (`bypassPermissions`). Skip-all needs an explicit checkbox and a warning that the agent can run any command unattended;
  it is never the default and is never set implicitly.
- **Budgets:** per-run `--max-budget-usd` (default $2), optional per-routine runs/day, global daily cost cap
  (`automation.maxDailyCostUsd`, default none) — all checked *before* spawning.
- **Global pause** stops the scheduler and refuses manual runs until resumed; running runs are not killed unless asked.
- **Isolation:** the child gets the server's environment minus agenv's own token; logs are capped; the routines API sits
  behind the same auth, rate limit and tunnel read-only rule as everything else.
- An unattended agent can still change files in its folder in `acceptEdits` mode. That is the point of the feature and
  is stated in the UI where the mode is chosen.

## 7. UI (`public/modules/routines.js`, a new sidebar panel)

List of routines (name, schedule in words, next run, last result/cost, enable toggle, run-now); create/edit dialog
(name, schedule preset or custom cron + timezone, prompt, folder, target session or new conversation, permission mode,
budget); runs list per routine (status, started, duration, cost); a run view that tails the log while it runs;
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
  `coalesce_if_active`, `skip_missed`, continuity ON.
