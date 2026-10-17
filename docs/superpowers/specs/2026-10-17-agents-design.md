# agenv: agents (named, specialised CLI agents) — design

Date: 2026-10-17 · Status: draft for review · Target release: 1.6.0 (routines become 1.7.0 and target agents; messaging 1.8.0)

## 1. Goal and intent

An **agent** is a named, long-lived specialist: a folder it works in, a conversation it carries, optional extra
instructions and sources. Routines (next spec) and, later, messaging ("ask crawlerdata-manager what the next step is",
"marketing group: get a new customer") address agents by name.

The principle that decides the design (user, 2026-10-17): agenv's difference from Paperclip is that agents are **CLI
agents on the developer's own machine**. The developer moves between agents in their own terminals, and every agent runs
with the developer's own CLI authentication, MCP servers and git credentials. **agenv adds no connectors and no
hosted GitHub/OAuth layer** — it only starts the CLI in the right folder with the right conversation.

Said by the user: assign a routine to an agent so it uses *its own sources, skills and codebase, running from the
agent's folder*; **create an agent from a conversation or duplicate a conversation** (use Claude's own option if it has
one; otherwise compact the conversation to a file or skill, or run it).

Success: a developer can turn a good working conversation into a reusable agent in one action, duplicate a
conversation or an agent safely (the original is never altered), open any agent as a normal terminal, and know what
creating one will cost before it happens.

Out of scope: routines (separate spec), messaging/tasks, org charts and reporting lines, non-Claude CLIs (the executor
is already a Strategy), hosted/remote agents.

## 2. What Claude Code already provides (verified 2026-10-17, claude 2.1.301)

| Need | Native support | Verified |
|---|---|---|
| Duplicate a conversation | `claude --resume <id> --fork-session` (interactive) or with `-p` (headless) | Yes: new transcript in the same project folder, new session id inside it, full history carried (the fork answered a question about the original), **original untouched** (checked line counts and content) |
| Compact a conversation | `/compact`, also headless: `claude -p --resume <id> --fork-session "/compact"` | Yes: new conversation whose transcript has `compact_boundary` + `CompactSummary`; result text empty, 0 turns |
| Result data of a headless run | JSON / stream-json final event | `result`, `session_id`, `total_cost_usd`, `num_turns`, `duration_ms`, `is_error`, `subtype` |
| Extra sources, tools | `--add-dir`, `--mcp-config`, `--setting-sources`, `--plugin-dir`, `--append-system-prompt[-file]`, `--agents`/`--agent` | flags present |
| Specialty from the folder | Claude loads the working folder's `CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.mcp.json` and the user's own auth/MCP config automatically | by design of the CLI |

So the specialty needs no agenv machinery: **running the CLI in the agent's folder is the specialisation**; agenv
stores which folder and which conversation. Duplication is native, so it is the default; compaction is native too.

## 3. Data model

`Agent` in `~/.agenv-agents.enc` (same encrypted Repository as the other stores):

| field | meaning |
|---|---|
| `id` | short random id |
| `name` | unique, 1–48 chars, letters/digits/`-`/`_` (it becomes the address in 1.8.0: `crawlerdata-manager`) |
| `specialty` | one line describing what it is for (shown in lists; used in the adoption prompt) |
| `cwd` | the agent's folder — runs always start here |
| `conversationId` | the conversation it resumes; empty until the first run or terminal session creates one |
| `instructions` | optional text appended to Claude's system prompt on every run (`--append-system-prompt`) |
| `briefingFile` | optional path of a distilled briefing passed with `--append-system-prompt-file` |
| `addDirs` | optional extra folders the agent may use (`--add-dir`) |
| `mcpConfig` | optional path to an MCP config file (`--mcp-config`); default none — the folder's `.mcp.json` and the user's MCP servers already apply |
| `model` | optional `--model` |
| `permission` | default permission settings for runs (`mode`, `allowedTools`) — same shape and meaning as routines' |
| `origin` | `{ kind: "blank" }`, `{ kind: "fork", sourceConversationId, compacted }`, `{ kind: "distilled", sourceConversationId, artifact: "briefing" \| "skill" }`, `{ kind: "duplicate", sourceAgentId }` |
| `created`, `updated`, `lastRunAt` | |

## 4. Creating an agent

1. **Blank** — name, folder, specialty (+ optional instructions). The conversation is created lazily by the first run,
   or by opening the agent's terminal.
2. **From a running or closed session** — "make this session an agent": binds that session's linked conversation
   (`claudeSessionId`) as the agent's conversation, folder = the session's folder. No Claude call, no cost, and the
   session keeps working in that conversation (use Fork below if it should not).
3. **From a conversation** (picked from the Claude conversation search, an open session, or Recently Closed). Source
   is never altered. Modes:
   - **Fork** *(default)*: `claude -p --resume <src> --fork-session` with a short adoption prompt ("From now on you
     are the `<name>` agent: `<specialty>`. Reply only OK.") → the new `session_id` becomes `conversationId`.
   - **Fork + compact**: the fork above, then `/compact` on it. Recommended when the source is large (the UI shows the
     transcript size and an estimated cost; ≥ 400 KB ≈ 100k tokens suggests compacting).
   - **Distill to a briefing**: run a read-only (`--permission-mode plan`) fork of the source with a prompt asking for a
     self-contained briefing (role, conventions, decisions, commands, pitfalls). agenv saves the answer as
     `<cwd>/.claude/agenv-briefings/<name>.md` and sets `briefingFile`; the agent starts a **fresh** conversation.
     Cheapest at run time, since the old context is not re-read.
   - **Distill to a skill**: same distillation, saved as `<cwd>/.claude/skills/<name>/SKILL.md` (front-matter `name`,
     `description`) so Claude loads it in that folder for any session. It writes into the developer's repo folder, so
     the UI confirms the path first.
   Creation runs have a budget (`--max-budget-usd`, default 1) and a timeout; failures leave nothing half-created.
4. **Duplicate an agent** — copies the profile (name `<name>-copy`, made unique) and forks its conversation (optionally compacted).

Separately, **"Fork conversation"** (no agent): from the Claude search results, an open session or Recently Closed, opens
a normal terminal session running `claude --resume <id> --fork-session` in the conversation's folder. This is the
developer-facing "duplicate a conversation".

## 5. Running as an agent

`runAgent(agent, prompt, overrides)` builds the one command both routines and (later) messaging use:
`claude -p --output-format stream-json --verbose --resume <conversationId> --permission-mode <mode> [--allowedTools …]
[--model …] [--append-system-prompt …] [--append-system-prompt-file <briefing>] [--add-dir …] [--mcp-config …]
--max-budget-usd <n>`, started with `cwd = agent.cwd`. The final `session_id` is stored as `conversationId` (first run).
- **One writer per conversation.** Runs for the same conversation are serialised (a per-conversation queue). If the
  conversation is open in an interactive terminal right now (`claudeRunning` on its linked session), the run is deferred
  or skipped with that reason — two processes must never write one conversation.
- **Open terminal** — creates an ordinary agenv session in `agent.cwd` running `claude --resume <conversationId>`; the
  existing Claude linking attaches it, so the developer can step into the agent at any time and step out again.

## 6. Architecture (`src/agents/`)

```
Agent.ts            types + validation (name rules, limits)
AgentStore.ts       CRUD + unique names over JsonStore<Agent[]>
ClaudeRunner.ts     the shared headless runner: buildArgs(), spawn, stream-json parsing, tree-kill, timeout, budget
                    (also the base of routines' executor; binary chosen by AGENV_CLAUDE_BIN, default "claude")
ConversationForker.ts   fork / fork+compact / distill → { conversationId | artifactPath, costUsd }
AgentService.ts     create (blank | from session | from conversation), duplicate, open terminal, run
```
`routes/agents.ts` (authenticated; writes added to the tunnel read-only list): `GET/POST /api/agents`,
`PUT/DELETE /api/agents/:id`, `POST /api/agents/from-conversation` (`{ name, specialty, sourceConversationId, mode, cwd }`),
`POST /api/agents/from-session` , `POST /api/agents/:id/duplicate`, `POST /api/agents/:id/open`,
`POST /api/claude/conversations/:id/fork` (interactive fork session), `GET /api/claude/conversations/:id/estimate`
(size → rough token and cost estimate for the creation dialog).

## 7. UI

An **Agents** section in the sidebar: list (name, specialty, folder, conversation, last run); create dialog with the four
choices (Blank / From session / From conversation with the mode picker and cost estimate / Duplicate); per-agent
Open terminal, Edit, Duplicate, Delete. "Fork conversation" and "Make agent from this" added to the Claude search
results and to Recently Closed. In-app dialogs (`askText`), no `prompt()`.

## 8. Safety

- agenv never touches the source conversation; every create mode works on a fork (verified non-destructive).
- Distillation runs read-only; agenv, not the model, writes the file, and only inside the agent's folder after confirmation.
- Creation costs real tokens: budget flag per call, estimate shown first, nothing runs without the user's click.
- No credentials are stored or proxied by agenv: runs inherit the developer's environment, exactly as their own terminal would.
- Folder must exist and be a directory; names are validated; the agents API is behind the usual auth/rate limit/tunnel rules.

## 9. Testing

Unit tests with a **fake `claude`** (a node script selected by `AGENV_CLAUDE_BIN`) that implements `--resume`,
`--fork-session` (returns a new id and copies a fixture transcript), `/compact`, stream-json final events, failures and
budget exhaustion; store/validation tests; fork-mode tests asserting the source is untouched; distill tests asserting
the file lands only under the agent's folder; API tests through `buildRuntime`; one browser flow (create from a
conversation, open terminal). A manual, opt-in check against the real CLI (haiku, 5-cent cap) mirrors the spike. No
automated test spends money.

## 10. Risks and open points

- Conversation files are Claude Code's format; agenv only passes ids to the CLI and reads transcripts it already reads
  (index/usage). A future Claude Code change to `--fork-session` or `/compact` headless behaviour breaks creation, not
  existing agents — the fake-claude tests pin our assumptions and the manual check re-verifies them.
- A fork of a huge conversation costs a context read each run when resumed; compaction/distillation exist for that.
- Names are the future messaging address — they are validated and unique now so 1.8.0 does not need a migration.
- Defaults proposed for review: creation mode Fork, creation budget $1, distill output = briefing file, permission
  `acceptEdits` (same default as routines).
