import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import { decodeClaudeProjectPath } from "./paths";
import { CLAUDEMD_TEMPLATES } from "./templates";
import type { TranscriptScanner } from "./TranscriptScanner";

interface Project { dir: string; path: string; name: string }

export interface ProjectInfo extends Project {
  hasClaude: boolean;
  size: number;
  hasLocalSettings: boolean;
  memoryFiles: string[];
}

/** The CLAUDE.md manager: finds every project Claude Code has worked in, and reads/writes each one's CLAUDE.md and memory notes. */
export class ClaudeMdService {
  private projectCache: Project[] | null = null;
  private cachedAt = 0;

  constructor(private readonly o: { projects: string; scanner: TranscriptScanner }) {}

  /** The real folder a Claude project directory belongs to, taken from the first transcript line's cwd. */
  private resolveProjectPath(projDir: string): string {
    try {
      const dp = path.join(this.o.projects, projDir);
      const files = fs.readdirSync(dp).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const e = JSON.parse(this.o.scanner.firstLine(path.join(dp, f)));
        if (e.cwd) return String(e.cwd).replace(/\//g, path.sep);
      }
    } catch {}
    return decodeClaudeProjectPath(projDir);
  }

  /** Cached for a minute — resolving each project reads a transcript. */
  private projectPaths(): Project[] {
    if (this.projectCache && Date.now() - this.cachedAt < 60000) return this.projectCache;
    const result: Project[] = [];
    try {
      for (const d of fs.readdirSync(this.o.projects)) {
        try {
          if (!fs.statSync(path.join(this.o.projects, d)).isDirectory()) continue;
          const resolved = this.resolveProjectPath(d);
          result.push({ dir: d, path: resolved, name: path.basename(resolved) });
        } catch {}
      }
    } catch {}
    this.projectCache = result;
    this.cachedAt = Date.now();
    return result;
  }

  /** The `memory/` folder of a project — directly under it, or nested in a session subfolder. */
  private findMemoryDir(projDir: string): string | null {
    const base = path.join(this.o.projects, projDir);
    const direct = path.join(base, "memory");
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
    for (const sd of fs.readdirSync(base)) {
      try {
        if (!fs.statSync(path.join(base, sd)).isDirectory()) continue;
        const candidate = path.join(base, sd, "memory");
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
    return null;
  }

  list(): ProjectInfo[] {
    const result: ProjectInfo[] = [];
    for (const p of this.projectPaths()) {
      const claudemdPath = path.join(p.path, "CLAUDE.md");
      const localSettingsPath = path.join(p.path, ".claude", "settings.local.json");
      let memoryFiles: string[] = [];
      try {
        const memDir = this.findMemoryDir(p.dir);
        if (memDir) memoryFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
      } catch {}

      let hasClaude = false, size = 0;
      try { const st = fs.statSync(claudemdPath); hasClaude = true; size = st.size; } catch {}

      result.push({ dir: p.dir, path: p.path, name: p.name, hasClaude, size, hasLocalSettings: fs.existsSync(localSettingsPath), memoryFiles });
    }
    // Sort: projects with CLAUDE.md first, then alphabetical
    result.sort((a, b) => (b.hasClaude ? 1 : 0) - (a.hasClaude ? 1 : 0) || a.name.localeCompare(b.name));
    return result;
  }

  read(projectPath: unknown): { content: string; path: string; exists?: false } {
    if (!projectPath || typeof projectPath !== "string") throw new HttpError(400, "path required");
    const claudemdPath = path.join(projectPath, "CLAUDE.md");
    try {
      return { content: fs.readFileSync(claudemdPath, "utf8"), path: claudemdPath };
    } catch {
      return { content: "", path: claudemdPath, exists: false };
    }
  }

  write(projectPath: unknown, content: unknown): { ok: true; path: string } {
    if (!projectPath || typeof projectPath !== "string" || content == null) throw new HttpError(400, "path and content required");
    const claudemdPath = path.join(projectPath, "CLAUDE.md");
    try {
      fs.writeFileSync(claudemdPath, String(content), "utf8");
      return { ok: true, path: claudemdPath };
    } catch (e: any) {
      throw new HttpError(500, e.message);
    }
  }

  templates(): Array<{ id: string; name: string; content: string }> {
    return Object.entries(CLAUDEMD_TEMPLATES).map(([id, content]) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), content }));
  }

  memory(projDir: unknown): { memories: Array<{ file: string; content: string }>; path: string | null } {
    if (!projDir || typeof projDir !== "string") throw new HttpError(400, "dir required");
    try {
      const memDir = this.findMemoryDir(projDir);
      if (memDir) {
        const files = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
        return { memories: files.map((file) => ({ file, content: fs.readFileSync(path.join(memDir, file), "utf8") })), path: memDir };
      }
      return { memories: [], path: null };
    } catch { return { memories: [], path: null }; }
  }
}
