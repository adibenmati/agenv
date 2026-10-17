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
