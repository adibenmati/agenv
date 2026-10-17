/**
 * Splits a shell command line ("pwsh -NoLogo", '"C:\\Program Files\\x\\sh.exe" -l') into the executable and its
 * arguments. Quoted segments stay whole and their outer quotes are removed — including on the executable, which
 * the pre-TypeScript server left quoted (see docs/superpowers/follow-ups.md).
 */
export function parseShell(shell: string): { file: string; args: string[] } {
  const parts = shell.match(/(?:[^\s"]+|"[^"]*")+/g) || [shell];
  const unquote = (s: string): string => s.replace(/^"|"$/g, "");
  return { file: unquote(parts[0]), args: parts.slice(1).map(unquote) };
}
