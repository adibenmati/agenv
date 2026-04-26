# Contributing to Agenv

Thanks for your interest in contributing to Agenv. This document covers the basics to get started.

## Development setup

```bash
git clone https://github.com/user/agenv.git
cd agenv
npm install
npm start
```

The server starts on `http://127.0.0.1:7681`. Open it in your browser.

For auto-reload during development:

```bash
npm run watch
```

## Project structure

```
server.js              Express + WebSocket server, PTY management, all API endpoints
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
  api.test.js          API endpoint tests
  helpers.js           Test server bootstrap utilities
scripts/
  manage.js            Process management (stop/destroy/status)
Makefile               Development shortcuts
```

## Running tests

```bash
npm test
```

Tests use Node.js built-in test runner (`node:test`). They spawn a real server instance on a random port and test API endpoints over HTTP.

To add tests, add them to `test/api.test.js` or create new `test/*.test.js` files.

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
