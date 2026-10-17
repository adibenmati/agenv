# Follow-ups found while porting server.js to TypeScript

Behavior is ported as-is during the migration. Anything questionable found on the way is recorded here instead of
being silently changed. Each entry: where it is in the baseline (`git show pre-ts:server.js`), what it does, why it matters.

1. **Encryption key is silently regenerated** (`getEncryptionKey`, L48–58 → `src/core/Crypto.ts`). If `~/.agenv.key` is
   missing, unreadable or not 64 hex chars, a new random key is written over it. Every existing `.enc` file then fails to
   decrypt and is treated as empty — a transient read error can turn into permanent loss of history, state and archive.
   Suggested: only create a key when the file does not exist; refuse to overwrite a malformed one.
2. **`agenv help` documents the wrong default** for `--max-sessions` ("default: 10"; the code default is 20)
   (`src/cli/commands.ts` HELP text, baseline L289).
