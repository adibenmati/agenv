import * as fs from "fs";

/**
 * Returns a "is this an existing directory" check that remembers positive answers, so a flapping prompt doesn't
 * hit the disk on every detection round. The memory is bounded (cleared past 500 entries).
 */
export function createRealDirChecker(): (p: string) => boolean {
  const known = new Set<string>();
  return (p: string): boolean => {
    if (known.has(p)) return true;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        if (known.size > 500) known.clear();
        known.add(p);
        return true;
      }
    } catch {}
    return false;
  };
}
