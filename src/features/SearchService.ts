import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";

function fuzzyMatch(query: string, text: string): boolean {
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".cache", "coverage"]);
const TEXT_EXTS = new Set(["js", "ts", "jsx", "tsx", "py", "go", "rs", "rb", "java", "c", "h", "cpp", "cc", "cxx", "hpp", "cs", "swift", "kt", "php", "sh", "bash", "zsh", "ps1", "json", "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less", "sql", "md", "txt", "dockerfile", "makefile", "r", "lua", "perl", "pl", "zig", "dart", "env", "ini", "cfg", "conf", "gitignore", "lock", "csv", "svg", "mjs", "cjs", "psm1"]);

/** `?limit=` — a positive number up to `cap`; anything else (missing, "abc", 0, negative) means 100. */
function parseLimit(limit: unknown, cap: number): number {
  const n = parseInt(String(limit || "100"), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, cap) : 100;
}

const skipEntry = (name: string): boolean => (name.startsWith(".") && name !== ".env" && name !== ".gitignore") || SKIP_DIRS.has(name);

export interface FileHit { path: string; relative: string; name: string }
export interface TextHit { file: string; fullPath: string; line: number; text: string }

/**
 * File-name and text search under a folder. The walk is asynchronous (and in the same order as before, so which
 * results fit under the limit is unchanged); a large repository no longer freezes every terminal while it runs.
 */
export class SearchService {
  async files(o: { dir?: unknown; q?: unknown; limit?: unknown }): Promise<{ results: FileHit[]; dir: string }> {
    const resolved = path.resolve(typeof o.dir === "string" && o.dir ? o.dir : process.cwd());
    const query = String(o.q || "").trim();
    const max = parseLimit(o.limit, 500);
    const ql = query.toLowerCase();
    const results: FileHit[] = [];

    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > 10 || results.length >= max) return;
      try {
        for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
          if (results.length >= max) return;
          if (skipEntry(e.name)) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            await walk(full, depth + 1);
          } else {
            const rel = path.relative(resolved, full).replace(/\\/g, "/");
            if (!query || rel.toLowerCase().includes(ql) || fuzzyMatch(query, rel)) results.push({ path: full, relative: rel, name: e.name });
          }
        }
      } catch {}
    };
    await walk(resolved, 0);

    // Sort: name matches first, then path matches, then shorter paths
    if (query) {
      results.sort((a, b) => {
        const aName = a.name.toLowerCase().includes(ql) ? 0 : 1;
        const bName = b.name.toLowerCase().includes(ql) ? 0 : 1;
        if (aName !== bName) return aName - bName;
        const aRel = a.relative.toLowerCase().includes(ql) ? 0 : 1;
        const bRel = b.relative.toLowerCase().includes(ql) ? 0 : 1;
        if (aRel !== bRel) return aRel - bRel;
        return a.relative.length - b.relative.length;
      });
    }
    return { results: results.slice(0, max), dir: resolved };
  }

  async text(o: { dir?: unknown; q?: unknown; limit?: unknown }): Promise<{ results: TextHit[]; dir: string }> {
    if (!o.q || typeof o.q !== "string") throw new HttpError(400, "Missing query");
    const resolved = path.resolve(typeof o.dir === "string" && o.dir ? o.dir : process.cwd());
    const max = parseLimit(o.limit, 200);
    const ql = o.q.toLowerCase();
    const results: TextHit[] = [];

    const walk = async (d: string, depth: number): Promise<void> => {
      if (depth > 8 || results.length >= max) return;
      try {
        for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
          if (results.length >= max) return;
          if (skipEntry(e.name)) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) { await walk(full, depth + 1); continue; }
          const ext = (e.name.split(".").pop() as string).toLowerCase();
          if (!TEXT_EXTS.has(ext) && !e.name.toLowerCase().match(/^(dockerfile|makefile|readme|license|changelog)$/)) continue;
          try {
            const stat = await fs.promises.stat(full);
            if (stat.size > 512 * 1024 || stat.size === 0) continue;
          } catch { continue; }
          try {
            const lines = (await fs.promises.readFile(full, "utf8")).split("\n");
            for (let i = 0; i < lines.length && results.length < max; i++) {
              if (lines[i].toLowerCase().includes(ql)) {
                results.push({ file: path.relative(resolved, full).replace(/\\/g, "/"), fullPath: full, line: i + 1, text: lines[i].substring(0, 200) });
              }
            }
          } catch {}
        }
      } catch {}
    };
    await walk(resolved, 0);
    return { results, dir: resolved };
  }
}
