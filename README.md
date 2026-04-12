# termlink

Shared web-based terminal — access your local PTY session from any browser. Both the local terminal and browser clients share the **same** PTY session in real time.

## Install

```bash
npm install -g termlink
```

Or run without installing:

```bash
npx termlink
```

## Usage

```bash
# Default: opens cmd.exe (Windows) or $SHELL (Linux/Mac) on port 7681
termlink

# Custom shell
termlink --shell bash

# Run Claude Code
termlink --shell "claude --dangerously-skip-permissions"

# Custom port
termlink --port 8080

# Expose on the local network (default is localhost-only)
termlink --host 0.0.0.0

# Set a fixed token instead of a random one
termlink --token mysecrettoken

# Start with multiple terminal sessions (tabs in browser)
termlink --sessions 3
```

On startup the server prints your access URL including the session token:

```
[termlink] Access URL: http://127.0.0.1:7681/?token=3f8a2c...
```

Open that URL in your browser.

## Authentication

### Token auth (default)

Every launch generates a random 128-bit token. Pass it as `?token=<value>` in the URL.

### Username / password auth

Set credentials once (stored in `~/.termlinkrc.json`, password is hashed):

```bash
termlink set auth.username admin
termlink set auth.password s3cret
```

When credentials are configured the server shows a login page instead of requiring a token URL. To check the current value:

```bash
termlink get auth.username
```

To switch back to token-only auth, delete `~/.termlinkrc.json` or remove the `auth` key.

## Self-update

```bash
termlink update
```

Runs `npm install -g termlink@latest` and reports the result.

## Multiple sessions

```bash
termlink --sessions 4
```

Each session is an independent PTY. The browser shows a tab bar to switch between them. The local terminal is always connected to Session 1.

## Access from your phone (ngrok)

1. Install ngrok: https://ngrok.com/download
2. Start termlink (default localhost binding is fine):
   ```bash
   termlink
   ```
3. In a second terminal, tunnel it:
   ```bash
   ngrok http 7681
   ```
4. Open the ngrok URL on your phone and append `?token=<the token printed above>` (or log in if credentials are set).

## Security

- The server binds to `127.0.0.1` by default (localhost-only).
- Every session generates a random 128-bit token. Requests without a valid `?token=` are rejected with `401`.
- When username/password auth is enabled, passwords are hashed with scrypt and verified with timing-safe comparison.
- WebSocket connections without valid auth are closed immediately.
- Input is rate-limited (200 messages/sec per client) and capped at 4 KB per message.
- WebSocket frames are capped at 64 KB.

## CLI reference

### Server flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port <number>` | `7681` | HTTP/WebSocket port |
| `--host <address>` | `127.0.0.1` | Interface to bind (use `0.0.0.0` for LAN access) |
| `--shell <command>` | `cmd.exe` / `$SHELL` | Shell or command to run in the PTY |
| `--token <value>` | random hex | Override the session token |
| `--sessions <number>` | `1` | Number of independent PTY sessions |

### Commands

| Command | Description |
|---------|-------------|
| `termlink set <key> <value>` | Set a config value (e.g. `auth.username`, `auth.password`) |
| `termlink get <key>` | Read a config value |
| `termlink update` | Self-update to the latest version |

## How it works

- A PTY process is spawned running your chosen shell/command (one per session).
- PTY output is mirrored to **both** your local terminal and all connected browser clients via WebSocket.
- Input from the local terminal **or** any browser client is forwarded to the same PTY.
- New browser connections receive the last ~100 KB of output as scrollback.
- Terminal resize is supported from both the local terminal and browser.

## Exit

Press **Ctrl+C twice** quickly in the local terminal to shut down.
