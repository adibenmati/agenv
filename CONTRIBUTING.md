# Contributing to Agenv

Thanks for your interest in contributing to Agenv. This document covers the basics to get started.

## Development setup

```bash
git clone https://github.com/user/agenv.git
cd agenv
npm install
npm run build
npm start
```

The server is TypeScript (`src/` compiles to `dist/`), so build before starting from a checkout. It starts on `http://127.0.0.1:7681`. Open it in your browser.

For auto-reload during development, run the compiler and the server side by side:

```bash
npm run build:watch   # in one terminal: recompiles src/ on every change
npm run watch         # in another: restarts the server when dist/ or public/ changes
```

## Project structure

```
server.js              Three-line loader for dist/index.js (cli.js, electron.js and npm start launch this file)
src/                   The server, in TypeScript (compiled to dist/ with `npm run build`)
  index.ts             Process lifecycle only: restore sessions, banner, listen, signals, graceful shutdown
  runtime.ts           Composition root: the one place that creates every object and wires them together
  core/                Config, Crypto, JsonStore (encrypted-file repository), TypedEmitter, HttpError
  cli/                 Subcommands: help, version, set, get, update, stop, kill
  security/            AuthService: token, session cookies, rate limit, ngrok IP/read-only rules
  persistence/         State, history, archive, favorites and scrollback stores
  sessions/            Session, SessionManager, Scrollback, OutputAnalyzer, GroupRegistry, WorkspaceLayout
  claude/              ClaudeLinker, TranscriptScanner, UsageService, SessionIndex, ClaudeMdService
  features/            GitService, FileService, SearchService, AiService, PromptLibrary, NgrokTunnel, SystemStats
  http/                createApp, one router per area (routes/), WsGateway, page builder, error rendering
electron.js            Electron desktop app wrapper
preload.js             Electron preload script (sandboxed)
public/
  index.html           Single-page app HTML + CSS
  app.js               Main frontend orchestration
  modules/
    tabs.js            Workspace/tab management, editor workspaces
    terminal.js        xterm.js terminal creation and WebSocket handling
    sidebar.js         File explorer, git panel, agent launcher
    sessions.js        Session dashboard and management
    layout.js          Split-pane layout engine
    fileviewer.js      File viewer overlay (code/diff/edit)
    extensions.js      Cost monitor, ngrok integration
    notifications.js   Toast notifications
    palette.js         Command palette (Ctrl+P)
    util.js            Shared utilities
test/
  api.test.js, session.test.js, ...  Black-box tests: they start a real server and talk to it over HTTP/WebSocket
  unit/                Unit tests of the compiled classes (fake pty, temporary home folders)
  e2e/                 Browser flows (Chromium via playwright-core), run with `npm run test:e2e`
  helpers.js           Test server bootstrap utilities
scripts/
  manage.js            Process management (stop/destroy/status) — shipped
  run-tests.js, golden-master.js, compat-check.js, extract-routes.js   Development tooling — not shipped
Makefile               Development shortcuts
```

## Architecture

Every job has one class, and objects get what they need through their constructor — there is no global state.

- **`runtime.ts` is the only place that calls `new` on services.** To add a feature: write the service (plain class, no Express), add a router in `src/http/routes/`, add both to `AppDeps`/`buildRuntime`.
- **Dependencies point one way:** routes → services → core. Services never import Express; nothing imports `index.ts`.
- **A `Session` knows nothing about WebSockets.** Things that happen to a session (`output`, `status`, `cwd`, `command`, `changed`, `deleted`) are published on a typed event bus; the WebSocket gateway, output analyzer, Claude linker and state store subscribe. A listener that throws is logged and cannot break the others.
- **Persistence is a repository per file** (`JsonStore`). File names and formats under `~/.agenv-*` are a compatibility contract: an older install must keep loading.
- **Behavior is guarded by tests, not by reading.** HTTP and WebSocket behavior is tested black-box; classes are unit-tested with a fake pty.

Questionable behavior found while migrating from the old single-file server is recorded in `docs/superpowers/follow-ups.md`.

## Running tests

```bash
npm test            # builds, then runs every test file one at a time
npm run test:e2e    # browser flows; needs a Chromium (AGENV_E2E_CHROME, or `npx playwright-core install chromium`)
```

Tests use Node.js's built-in runner (`node:test`). The black-box tests spawn a real server on a random port with a temporary home folder; set `AGENV_ENTRY` to point them at another entry file. Unit tests import the compiled classes from `dist/`, so `npm test` builds first.

To add tests, create new `test/*.test.js` (black-box) or `test/unit/*.test.js` (classes) files — the runner picks them up.

**Checking that a change did not alter behavior:** `node scripts/golden-master.js <entryA> <entryB>` starts two server entries on identical temporary homes, replays a scripted sequence of API calls and diffs the normalized responses (every route is either covered or listed with a reason). `node scripts/compat-check.js <entry>` starts an entry on a copy of your real `~/.agenv-*` data and prints what it restored.

## Making changes

1. Create a branch from `main`
2. Make your changes
3. Run `npm test` and make sure all tests pass
4. Submit a pull request

### Code style

- No build step. Plain JavaScript, no transpilation.
- Frontend uses ES modules (`import`/`export`). Server uses CommonJS (`require`).
- Keep dependencies minimal. The core has only 4 runtime dependencies.
- Prefer editing existing files over creating new ones.
- No TypeScript, no JSX, no bundlers. This is intentional.

### Areas where help is welcome

- **Agent integrations**: Better support for specific AI CLIs (Claude, Vertex, Ollama, etc.)
- **Terminal features**: tmux-style pane management, scrollback search
- **File editor**: Monaco integration, language server support
- **Testing**: More endpoint coverage, WebSocket tests, frontend tests
- **Platform support**: Linux/macOS testing, ARM compatibility
- **Accessibility**: Screen reader support, keyboard navigation

## Reporting issues

Use GitHub Issues. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Node.js version (`node --version`)
- OS and browser

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
