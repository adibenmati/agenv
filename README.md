
# Agenv

The agent development environment. Build, run, and monitor AI agents from a full web-based IDE with split terminals, integrated file editing, git management, and persistent session control.

Agenv gives you a complete workspace for agent development — not just a terminal, but an environment where you can run multiple agents simultaneously, inspect their output in split panes, edit code with syntax highlighting, track costs, and manage everything from any browser or the desktop app.

<div align="center">

https://github.com/user-attachments/assets/0c30496c-f0f2-4604-a764-bcd9b7a9fcef

</div>

## Install

```bash
npm install -g @adibenmatdev/agenv
```

Or run without installing:

```bash
npx @adibenmatdev/agenv
```

For the desktop app experience, also install Electron (optional):

```bash
npm install -g electron
```

## Quick start

```bash
# Launch the environment (desktop app if Electron is installed, web mode otherwise)
agenv

# Force web mode (opens in browser, accessible from any device)
agenv --web

# Web mode on a custom port
agenv --web --port 8080

# Launch directly into an agent
agenv run claude --model opus --dangerously-skip-permissions

# Run any command as a managed session
agenv run python3 train.py
agenv run ssh user@gpu-server
```

When Electron is installed, `agenv` opens a native desktop window — no open port, no token, just launch and go. Without Electron, it automatically falls back to web mode and prints your access URL.

## What you get

### Multi-agent workspace
Run multiple agents side by side in split terminal panes. Each agent gets its own persistent session that survives disconnects and browser refreshes. Switch between agents with `Alt+1-9` or the tab bar.

### Integrated file editor
Click any file in the explorer to open it as an editor tab — syntax highlighting for 30+ languages, inline editing, and `Ctrl+S` to save. Drag files from the explorer into terminal panes to insert their path, or onto the workspace to open them.

### Git integration
Stage, unstage, discard, and commit from the sidebar git panel. View file status at a glance. Click changed files to open them directly in the editor.

### Session management
Sessions persist across browser reconnects. Create, rename, group, archive, and restore sessions from the dashboard. Drag sessions from the panel into the workspace to open them.

### Agent cost tracking
Monitor token usage and cost per session in real time. See running/waiting/error status at a glance on each tab.

### Agents
An agent is a named, reusable Claude Code setup: a folder, a specialty, standing instructions and its own conversation. Open the Agents panel in the sidebar to create, run and manage them.

Agenv never connects to anything on your behalf. It only starts **your own `claude` CLI** inside the agent's folder, with your own authentication and your own MCP servers. There are no connectors and no tokens to hand over.

Create an agent in one of these ways:
- **Blank** - a folder and instructions, nothing else.
- **From a session** - adopt the Claude conversation of a running session.
- **From a conversation** - take any past conversation and either fork it (optionally compacted with `/compact`) or distill it into a briefing file or a skill, so the agent starts with what that conversation learned.
- **Duplicate** - copy an existing agent under a new name.

**Open terminal** starts the agent's conversation in a normal terminal session. Any session with a Claude conversation also has a **Fork conversation** action that branches it into a new one without touching the original.

Creating from a conversation uses real tokens. The UI shows an upper-bound estimate before you confirm. Forks and distills run read-only (`--permission-mode plan`), the source conversation is never altered, and a failed creation never creates an agent. A fork that succeeded before a later step (compact) failed may remain as a Claude conversation; the error then reports its id (`orphanConversationId`) so you can delete it. Over a read-only ngrok tunnel, agent writes and runs are blocked.

Maintainers can verify fork/compact against the real CLI with `AGENV_REAL_CLAUDE=1 AGENV_REAL_CAP=0.12 npm run check:agents-real` (build first). The per-call cap is $0.05 by default, but real calls from a normal environment cost about $0.10 because your MCP servers and plugins inflate the prompt, hence `AGENV_REAL_CAP=0.12`. A total ceiling of $0.30 (`AGENV_REAL_CEILING`) stops the run, so a full run can end INCONCLUSIVE.

On Windows, if Claude was installed with npm and agents cannot start it, set `AGENV_CLAUDE_BIN` to the `cli.js` of the package (for example `...\node_modules\@anthropic-ai\claude-code\cli.js`); agenv also tries to find it next to `claude.cmd` by itself. Terminal and headless runs differ: instructions, model, extra folders and MCP config apply to headless runs only, while the terminal resumes the conversation and adds the briefing file.

### Routines
A routine runs an agent on a schedule, unattended: "every weekday at 09:00, triage my inbox folder and write a summary". Open the Routines panel in the sidebar to create, run and manage them. Like agents, routines only start **your own `claude` CLI**, with your own login and MCP servers, and only while agenv is running.

- **Schedule** - a 5-field cron expression plus a timezone (defaults to the machine's). Presets: Hourly, Daily 09:00, Weekdays 09:00, Weekly Mon 09:00, or Custom.
- **Target** - an agent (its folder, instructions, MCP config and model are used) or a plain folder.
- **Conversation** (agent targets) - continue the agent's own conversation so its context accumulates, fork it for each run and leave the original untouched, or start a fresh conversation each run.
- **Permissions** - unattended means nobody can answer a prompt, so the mode is fixed up front: *Read-only* (plan, changes nothing), *Edit files* (the default), *Allowlist only* (just the tools you list) or *Skip all permissions*. The last one is never implicit: it needs an explicit checkbox acknowledging that the agent can run any command unattended.
- **Limits** - every run has a budget (default $2) and a timeout (default 20 minutes, max 120); a run that exceeds either is stopped. The per-run budget cap is passed to the CLI, which checks it after each turn, so a run can overshoot slightly. Optional caps: runs per day per routine and a global daily cost cap; both count from machine-local midnight. **Pause all automation** stops every scheduled, catch-up and manual run until you switch it back on.
- **Overlapping runs** - if a routine is still running when its next slot arrives: merge into the running one (default), skip, or queue another.
- **Missed runs** - routines fire only while agenv is running. A slot that comes up within about two minutes of its time still fires (for example after a quick restart). With *Skip runs missed while off* (the default), slots older than that grace window, say while agenv was closed or the machine slept, are **not** run: the routine just jumps to its next future slot and a visible skipped row records how many were missed. With *Run missed ones when back*, up to 25 missed slots are replayed, and never for schedules more frequent than hourly.
- **History** - the newest 500 runs are kept with status, duration, cost, the result summary and a live log. **Open interactively** continues a run's conversation in a normal terminal tab, and a run in progress can be cancelled. Routines are stored in `~/.agenv-routines.enc`, run history in `~/.agenv-runs.enc`, the global switches in `~/.agenv-automation.enc` and per-run logs in `~/.agenv-runs/`. Over a read-only ngrok tunnel, routine, run and automation writes are blocked.
- **One instance schedules** - only one agenv instance per machine runs the schedules (a lock file, `~/.agenv-automation.lock`). A second instance, for example the desktop app next to the CLI, still shows and edits routines but says so in the panel and does not run anything; the owner refreshes the lock every 30 s, so the other instance takes the lock over when the owner's process is gone, or when it has watched the same heartbeat stay unchanged for about 90 s on its own monotonic clock (the owner was killed, even if its process id has been reused), and then starts running the schedules. A system sleep or clock change never takes a live owner's schedules away. An instance that loses the lock cancels its queued runs ('ownership lost') and lets running ones finish.

Things to know: runs use real tokens (the per-run budget and the daily caps bound the cost). An unattended agent in *Edit files* mode can modify files in its folder, which is the point of the feature. A run is skipped, never stacked, when its conversation is currently open in a terminal, because two processes must not write one conversation.

### Messages between sessions
Sessions can talk to each other by name, whatever CLI runs inside them (Claude, Codex, Gemini, Aider, ...). Every session's shell gets `AGENV_URL`, `AGENV_SESSION_ID` and a private `AGENV_SESSION_TOKEN`, so an agent can run:

```
agenv sessions                    # who else is open (id, name, tool, idle/busy)
agenv send reviewer "please check the diff in src/api"
```

The text is typed into the target's terminal as if you had typed it, with a note of who sent it and how to answer (`agenv send <sender> "..."`), so the target replies the same way. If the target is busy printing, the message waits and goes in when it has been quiet for a moment (up to 5 minutes, then it fails). A closed session, or one with no agent CLI running (a plain shell would run the text as a command), is refused with a clear error. At most 30 messages per 10 minutes from one session to another (a loop breaker); the **Messages** panel (envelope button) shows the log and lets you message a session yourself. Session tokens only work on the messaging routes; messages are not stored on disk. Tell your agents about it in their `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`, or just say "use `agenv send`".

### Desktop app
When Electron is installed globally (`npm i -g electron`), `agenv` launches as a native desktop app with OS-level keyboard shortcuts and window management. The server runs internally on localhost — no exposed port.

### Web mode
Use `agenv --web` to start a web server accessible from any device on your network. Responsive layout works on desktop, tablet, and mobile. Optional ngrok integration for remote access (web mode only).

## Configuration

### Web mode flags

These flags apply when running in web mode (`agenv --web`):

```bash
# Custom port
agenv --web --port 8080

# Expose on LAN (default is localhost-only)
agenv --web --host 0.0.0.0

# Fixed token instead of random
agenv --web --token mysecrettoken

# Start with multiple sessions
agenv --web --sessions 4
```

### Authentication

#### Token auth (default in web mode)

Every launch generates a random 128-bit token. Pass it as `?token=<value>` in the URL.

#### Username / password auth

Set credentials once (stored in `~/.agenvrc.json`, password is hashed):

```bash
agenv set auth.username admin
agenv set auth.password s3cret
```

When credentials are configured, the server shows a login page. To check values:

```bash
agenv get auth.username
```

To switch back to token-only auth, delete `~/.agenvrc.json` or remove the `auth` key.

## Self-update

```bash
agenv update
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+1-9` | Switch to tab N |
| `Ctrl+P` | Quick file open |
| `Ctrl+B` | Toggle file explorer |
| `Ctrl+S` | Save active editor file |
| `Ctrl+T` | Search text in files |
| `Ctrl+Shift+D` | Split terminal right |
| `Ctrl+Shift+E` | Split terminal down |
| `Ctrl+Shift+W` | Close active pane |
| `Ctrl+K` | Open dashboard |
| `Alt+Arrow` | Navigate between panes |
| `?` | Show all shortcuts |

## Security

- Binds to `127.0.0.1` by default (localhost-only)
- Desktop mode: no exposed port — server runs internally
- 128-bit random token auth on every web session
- Scrypt-hashed passwords with timing-safe comparison
- WebSocket auth enforced on connection
- Input rate-limited (200 msg/sec) and size-capped (4 KB per message)
- CSP headers and frame protection
- Electron enforces localhost-only connections with sandbox enabled

## CLI reference

### Commands

| Command | Description |
|---------|-------------|
| `agenv` | Launch environment (desktop if Electron installed, web otherwise) |
| `agenv --web` | Force web server mode |
| `agenv run <command...>` | Start with a command running in a session |
| `agenv stop` | Stop running server |
| `agenv kill` | Force-kill running server |
| `agenv set <key> <value>` | Set a config value |
| `agenv get <key>` | Read a config value |
| `agenv sessions` | Inside a session: list the sessions you can message |
| `agenv send <name> <text...>` | Inside a session: message another session |
| `agenv update` | Update to latest version |
| `agenv help` | Show help |

### Web mode flags

| Flag | Default | Description |
|------|---------|-------------|
| `--web` | | Start in web server mode |
| `--port <number>` | `7681` | HTTP/WebSocket port |
| `--host <address>` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `--shell <command>` | `cmd.exe` / `$SHELL` | Default shell for new sessions |
| `--token <value>` | random hex | Override the session token |
| `--sessions <number>` | `1` | Initial number of sessions |
| `--no-qr` | | Suppress QR code on startup |

## Architecture

- **Server**: TypeScript (compiled to `dist/`) on Node.js + Express + WebSocket, manages PTY sessions via node-pty — see CONTRIBUTING.md for the layout
- **Frontend**: Vanilla JS modules, xterm.js terminals, highlight.js code rendering
- **Desktop**: Electron wrapper with sandboxed renderer (optional, install via `npm i -g electron`)
- **Persistence**: Encrypted session state, command history, and scrollback stored in `~/.agenv-*`

## License

Apache-2.0
