# Follow-ups found while porting server.js to TypeScript

Behavior is ported as-is during the migration. Anything questionable found on the way is recorded here instead of
being silently changed. Each entry: where it is in the baseline (`git show pre-ts:server.js`), what it does, why it matters.

1. **Encryption key is silently regenerated** (`getEncryptionKey`, L48–58 → `src/core/Crypto.ts`). If `~/.agenv.key` is
   missing, unreadable or not 64 hex chars, a new random key is written over it. Every existing `.enc` file then fails to
   decrypt and is treated as empty — a transient read error can turn into permanent loss of history, state and archive.
   Suggested: only create a key when the file does not exist; refuse to overwrite a malformed one.
2. **`agenv help` documents the wrong default** for `--max-sessions` ("default: 10"; the code default is 20)
   (`src/cli/commands.ts` HELP text, baseline L289).
3. **The shell executable kept its quotes** (L521–523): `agenv --shell '"C:\Program Files\...\pwsh.exe" -NoLogo'` passed
   `"C:\Program Files\...\pwsh.exe"` (quotes included) as the file to node-pty, while the arguments were unquoted. The port
   (`src/sessions/shell.ts`) strips quotes from the executable too, which is what node-pty expects. Behavior changed only for
   quoted executable paths (previously likely broken). Verify with a real quoted shell path on Windows.
4. **A failed shell spawn leaves a sleeping session record** (`createSession` then `startSession`, L844/880): if
   `pty.spawn` throws (shell not found), `POST /api/sessions` answers 500 but the session stays in the list as a tab that can
   never start. Ported as-is in `SessionManager.create`. Suggested: remove the record when the first spawn fails.
5. **Access token is compared with `===`** (`isAuthenticated`, L448–455 → `AuthService.isAuthenticated`). Not constant-time;
   low practical risk for a 32-hex token on localhost, but `crypto.timingSafeEqual` is the standard choice if the server is
   exposed through a tunnel. (Hardened in the port: a malformed `Cookie` header or URL no longer throws — see ledger.)
6. **A WebSocket message of `null` crashed the server** (L3324+ `ws.on("message")`: `JSON.parse("null")` → `msg.type` throws
   inside the handler → uncaught exception). Hardened in `WsGateway`; noted here because the baseline is vulnerable — any
   authenticated client (or a tunnel user with the token) could take the server down with one frame.
7. **Git panel: commit (and any git value with a space) was broken** — FIXED in the port, recorded because it is a bug in the
   shipped 1.4.2. Every git route ran `spawnSync("git", [...args], { shell: true })` (cmd.exe on Windows). Node does not quote
   arguments in that mode, so the shell split them: committing "fix the login bug" ran `git commit -m fix the login bug` and
   failed with `error: pathspec 'the' did not match any file(s) known to git` (reproduced on the baseline); file names with
   spaces could not be staged; and a commit message such as `"; echo x > f; "` was executed as shell syntax. `GitService`
   runs git directly (no shell), so arguments reach git verbatim. Also hardened: `--` before user-supplied paths, and
   option-looking branch/remote names (`--mirror`, `--orphan`, …) are rejected with 400.
8. **The file API has no path restriction** (`GET/PUT /api/file`, `GET /api/files`, search, L1801–1976): any authenticated
   client can read or overwrite any file the server's user can. The baseline comment on `PUT /api/file` says "don't write
   outside of known directories" but no check exists. Ported as-is (`FileService`). For an IDE with a built-in terminal the
   practical exposure matches what a terminal already allows, but over an ngrok tunnel in read-only mode the write block
   (`/api/file` is on the read-only list) is the only guard — consider confining file routes to session folders.
9. **Session 0 clips are saved in the upload folder, not its `.clips`** (`POST /api/clip`: `if (sessionId)` is false for 0).
   Ported as-is.
10. **`/api/ai/ask` runs the `agent` and `model` values through a shell** (`AiService`, baseline L2662–2731: `spawn(cmd, args,
    { shell: true })` with `cmd = agent` and `--model <model>` unquoted). A shell is needed on Windows because agent CLIs
    installed with npm are `.cmd` shims, so it is ported as-is; the consequence is that a client can run any command
    through this route (it can through a terminal too, but not through a read-only tunnel — `/api/ai` is not on the
    read-only write list). Suggested: allow-list the agent names and validate the model against `^[\w.:\[\]/-]+$`.
11. **The CPU figure in the status bar is the average since boot**, not current load (`getSystemStats`, L654–670 sums
    `os.cpus()[].times`, which are cumulative). Ported as-is (`SystemStats`); a real reading needs two samples a moment apart.
12. **`ngrok` is spawned without a shell**, so an npm-installed `ngrok.cmd` shim cannot be started on Windows (ENOENT, "Is ngrok
    installed?"). Ported as-is.
13. **The advertised per-route body limits never applied** (L2324 `/api/ai/ask` 2 MB, `/api/claudemd/write` 1 MB, `/api/prompts` default
    100 KB): the global `express.json({ limit: "50mb" })` runs first and consumes the body, so the later route-level parsers are
    no-ops. Ported without them (same effective behavior: 50 MB everywhere). Decide whether those routes should really be
    capped lower.
14. **`buildPage` embedded session data unsafely** — FIXED in the port: the baseline used `template.replace(marker, string)`, so a
    session name or path containing `$&`, `$1` or `` $` `` was rewritten, and `JSON.stringify` output containing `</script>`
    (e.g. a session named `</script><script>…`) ended the script tag early. The port uses a replacer function and escapes `<`
    as `<`; the parsed data is identical.
15. **Ctrl+C in the launching terminal can never quit the server** (baseline L1068–1072 + L3446–3470). `agenv` puts a TTY stdin in raw
    mode (so Ctrl+C arrives as data, not SIGINT) and the Windows handler that was meant to catch it tests `data[0] === 3`
    — but `setEncoding("utf8")` makes `data` a string, so that comparison is never true (same for the `q` shortcut). The banner's
    "Press Ctrl+C twice to exit" therefore only works when stdin is not a TTY. The dead handler is omitted from the port (identical
    behavior); `agenv stop` and POST /api/shutdown are the working ways out. Suggested: handle "\x03" via `charCodeAt`.
16. **A second `agenv` on a taken port used to crash with a stack trace, delete the first one's PID file and rewrite its state** —
    FIXED in the port: it now prints "Port N is already in use", exits 1, removes only a PID file that is its own, and
    saves nothing until it is actually listening (`StateStore.hold/release`). Also fixed: `ws` re-emitted the server's
    listen error on the WebSocketServer, which had no listener (`WsGateway`).
17. **The startup banner's right border was one column short** (`pad` made content lines `w+1` wide inside a `w+2` frame) — fixed.
