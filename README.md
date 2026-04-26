
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

- **Server**: Node.js + Express + WebSocket, manages PTY sessions via node-pty
- **Frontend**: Vanilla JS modules, xterm.js terminals, highlight.js code rendering
- **Desktop**: Electron wrapper with sandboxed renderer (optional, install via `npm i -g electron`)
- **Persistence**: Encrypted session state, command history, and scrollback stored in `~/.agenv-*`

## License

Apache-2.0
