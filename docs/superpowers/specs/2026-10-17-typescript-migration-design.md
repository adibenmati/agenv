# agenv: TypeScript / OOP backend migration — design

Date: 2026-10-17 · Status: draft for review · Target release: 1.5.0 (no user-visible changes)

## 1. Goal and intent

`server.js` is a single 3,514-line file with 72 routes, a WebSocket server, PTY
management, persistence, Claude Code integration, git/file/search services and
a tunnel manager, all sharing top-level globals. New work (scheduled routines,
agent-to-agent tasks) would make it worse. The goal is a **TypeScript,
object-oriented backend with a small number of well-chosen design patterns**,
where each job has one class, so the automation features can be added as new
classes instead of more code in one file.

Said by the user: migrate to TypeScript with OOP and design patterns, "don't
overkill"; big-bang rewrite (not incremental).

Success criteria:
- Every existing behavior is preserved: HTTP API, WebSocket protocol, on-disk
  file formats, CLI flags, frontend untouched.
- The existing 69 tests pass unchanged (two switch from slicing `server.js`
  source to importing compiled classes), plus the verification in section 7.
- The published package still installs with no new runtime dependencies.
- Routines and agent tasks (section 9) can be added without editing session code.

Out of scope: frontend TypeScript, new features, behavior changes (apart from
the one called out in section 6), fixing questionable existing code (those
findings are listed as follow-ups, not silently changed).

## 2. Approach

Classes wired by a **composition root** (`src/index.ts`) using manual
constructor injection. Rejected: NestJS/Inversify (heavy dependencies and build,
the overkill the user warned against) and class-free modules (not what was
asked, and shared state drifts back into module globals).

Patterns, each where it earns its place:

| Pattern | Where |
|---|---|
| Constructor injection / composition root | `index.ts` is the only place that calls `new` on services |
| Repository | `JsonStore<T>` over an encrypted JSON file; one instance per file |
| Observer | typed events on `Session` / `SessionManager`; the WebSocket gateway, output analyzer, Claude linker, state store and (later) automation subscribe |
| Strategy | introduced with routines (run executors, permission modes), not before |

Not used: DI containers, decorators, abstract factories, an interface for every class.

## 3. Layout

```
src/
  index.ts          composition root; startup, signals, PID file, banner, shutdown
  cli/              flag and subcommand parsing (stop, kill, set, get, update, run, ...)
  core/             Config, Crypto, JsonStore, events.ts, HttpError
  security/         AuthService (token, cookies, apiAuth, rate limit, tunnel policy)
  sessions/         Session, SessionManager, Scrollback, OutputAnalyzer, GroupRegistry
  claude/           ClaudeLinker, TranscriptScanner, UsageService, SessionIndex, ClaudeMdService
  features/         GitService, FileService, SearchService, AiService,
                    PromptLibrary, NgrokTunnel, SystemStats
  http/             createApp(), routes/* (one router per area), WsGateway
  automation/       (later) cron, RoutineScheduler, RunQueue, TaskService
server.js           loader: requires dist/index.js (cli.js, electron.js, tests keep spawning server.js)
```

Dependency rules:
- routes → services → core; services never import Express; nothing imports `index.ts`.
- `Session` knows nothing about WebSocket; it emits events.
- Only `index.ts` constructs services; tests build any service with fakes.

## 4. Sessions, events, persistence

**Session** owns its record (name, folder, group, note, linked Claude
conversation id, status, analytics), its `Scrollback`, and its pty lifecycle
(start, restart, write, resize, kill). Restored tabs remain sleeping records
until first attached (as today).

**SessionManager** owns the session map, create/delete, the max-sessions limit,
restore from saved state, and orderly shutdown; it re-emits session events with
the session attached.

Events: `output`, `status`, `cwd`, `exit`, `command`, `changed`.

Subscribers:
- `OutputAnalyzer` (per session): the 250 ms status / folder / cost detection; emits `status` and `cwd`.
- `WsGateway`: per-session output batching (16 ms / 64 KB), dropping clients that stop reading, ping/pong, the 200 msg/s limit, scrollback replay with the `replay` flag, read-only mode for tunnel clients.
- `ClaudeLinker`: reacts to `command`; 15 s registry pass; conversation rename; conversation folder lookup.
- `StateStore`: reacts to `changed`; debounced save (write now, coalesce 1 s).
- Archive: one subscriber on `exit` / `deleted`.
- Mirroring session 0 to stdout (`--mirror`): a subscriber added in `index.ts`.

**Persistence.** `JsonStore<T>` loads, saves and migrates the legacy plain-JSON
files. Instances: state, history, archive, favorites, scrollback. **File names,
locations and formats are unchanged** (`~/.agenv-*.enc`, `~/.agenvrc.json`, the
key file) so an existing install upgrades without migration and can roll back.

**Shutdown.** `index.ts` handles signals, PID file, banner, QR and auto-open; on
exit it asks `SessionManager` to save state and scrollback and kill shells, then
closes the server (3 s forced-exit guard kept).

## 5. HTTP / WebSocket edge

`createApp(deps)` keeps today's middleware order: JSON body (50 MB), security
headers and CSP, `/api` rate limit, `/public` static, then one router per area:
sessions (with groups, layout, archive, history, favorites, quick-launch,
recent folders, analytics), git, files (explorer, read/write, upload, clip),
search, system (stats, shutdown, token rotation), claude (usage, index,
conversations, CLAUDE.md, memory), ai, prompts, ngrok, auth pages.

Handlers stay thin (validate, call service, respond). Services throw
`HttpError(status, message)`; one error middleware renders the existing
`{ error }` shape, so status codes and bodies match today's. `AuthService` is
shared by REST and the WebSocket upgrade (today two copies of the same checks).
`WsGateway` is the only class touching `ws`.

## 6. Services

`TranscriptScanner` (chunked JSONL reading, per-file cache, first-line helper)
is shared by `UsageService` (pricing as data), `SessionIndex` (per-file index,
disk cache, shared in-flight build) and `ClaudeLinker`. Other services are
straight ports; caches become private fields instead of module globals.

One deliberate behavior-preserving change: **git operations move from blocking
`spawnSync` to async `execFile`/`spawn`.** Same results, but a git request no
longer freezes the whole server for up to 10 s. Everything else is ported as-is;
questionable code found while porting (e.g. `shell: true` git calls) is recorded
as follow-ups, not changed inside the rewrite.

## 7. Build, packaging, verification

Build: `tsconfig` strict, target ES2020, CommonJS, `src/` → `dist/` (already
gitignored). Dev dependencies only: `typescript`, `@types/node`,
`@types/express`, `@types/ws`. `npm run build` = `tsc`; `prepublishOnly` builds
and runs tests. `package.json` `files` and the electron-builder file list gain
`dist/`. CI gets a build step in place of the syntax check. `server.js` prints
"run `npm run build`" if `dist/` is missing.

Verification (this is what makes a big-bang rewrite safe):
1. Tag the current code as the baseline (`pre-ts`); every check compares to it.
2. **Route inventory** of all 72 routes extracted from the old file into a
   checked-in list; a test asserts the new server serves each one.
3. **Golden-master diff:** old and new servers on identical temp homes, same
   scripted API calls, normalized responses diffed.
4. Existing 69 tests unchanged (two re-pointed at compiled classes).
5. New unit tests with fakes: `Scrollback`, `OutputAnalyzer`, `JsonStore`,
   `GroupRegistry`, `ClaudeLinker`, cron.
6. **Existing-data check:** start the new server on a copy of real `~/.agenv-*.enc`
   files; tabs, groups and notes must restore.
7. Browser flows (hibernate, groups, Claude link) move to `test/e2e/` as a manual
   `npm run test:e2e` (adds `playwright-core` as a dev dependency; not in CI).

## 8. Order of work

One branch, one commit per cluster: scaffolding + build + CI; core + security;
persistence; sessions + events; WsGateway; Claude integration; other services;
routers; `index.ts` + loader swap. All verification green before the old file is
removed. Release 1.5.0 only on explicit approval.

Risks: size of the port (mitigated by the inventory and golden-master diff);
typing `@lydell/node-pty`; Electron packaging must include `dist/`; work spans
several sessions, so the implementation plan carries resumable checkpoints.

## 9. Roadmap after the migration (decisions already made)

Each gets its own spec, plan and release.

**1.6.0 Routines.** Cron schedule with presets and IANA timezone, prompt, folder
and target session (or new conversation); fire → job → shared run queue →
headless `claude -p --output-format stream-json --resume <linked id>`, shown in a
read-only log pane with "Open interactively" (`claude --resume <id>` in a PTY).
Concurrency policy (`coalesce_if_active` | `skip_if_active` | `always_enqueue`);
missed runs (`skip_missed` default | `enqueue_missed_with_cap`, cap ~25, never
for sub-hourly); persisted `nextRunAt`; run history with status, cost, log.
Permissions per routine: default `--permission-mode acceptEdits` with a shell
allowlist; "skip all permissions" is an explicit opt-in with a warning. Strategy
pattern for run executors. `lib/cron.js` (already written and tested) moves to
`src/automation/cron.ts`.

**1.7.0 Agent tasks and messaging** (modelled on Paperclip, MIT, ideas only).
Per-session task inbox; local API plus a bundled skill/MCP with `create_task`,
`comment`, `block_on`, `inbox`; env `AGENV_API_URL`, per-run token,
`AGENV_RUN_ID`. Assignment or a comment on an assigned task wakes the recipient
with a headless run; @mentions never wake. UX: "ask crawlerdata-manager what the
next step is", and a goal for a whole group ("marketing: get a new customer").
Guards: ≤20 cross-task writes per run, escalating no-progress cooldown (2 → 30
min), per-agent daily run and cost caps checked before spawn, global "Pause all
automation".
