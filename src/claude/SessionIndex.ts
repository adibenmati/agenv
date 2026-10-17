import * as fs from "fs";
import * as path from "path";
import { decodeClaudeProjectPath } from "./paths";
import type { TranscriptScanner } from "./TranscriptScanner";

const STOP_WORDS = new Set("the a an is are was were be been being have has had do does did will would could should may might can shall it its i me my we our you your he she they them their this that these those what which who whom where when why how all each every both few more most other some such no not only own same so than too very just because but and or if then else for of to from in on at by with about against between into through during before after above below up down out off over under again further once here there also need want like make use used using get got let please now still well dont file code add change update fix look check think know see new way work thing something anything".split(" "));

export interface IndexedSession {
  id: string;
  project: string;
  projectPath: string;
  slug: string;
  model: string;
  branch: string;
  cwd: string;
  entrypoint: string;
  firstMessage: string | null;
  lastMessage: string | null;
  messageCount: number;
  userMessageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  keywords: string[];
  filesEdited: string[];
  commands: string[];
  summary: string;
}

interface FileEntry { size: number; mtimeMs: number; session: IndexedSession | null }
/** Bump when the shape of an indexed session changes, so old caches are rebuilt. */
const INDEX_VERSION = 2;

function extractKeywords(text: string, bag: Map<string, number>): void {
  const words = text.toLowerCase().replace(/[^a-z0-9\-_.]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && w.length < 30 && !STOP_WORDS.has(w));
  for (const w of words) bag.set(w, (bag.get(w) || 0) + 1);
  // Bigrams
  const parts = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  for (let i = 0; i < parts.length - 1; i++) {
    const bg = parts[i] + " " + parts[i + 1];
    if (bg.length > 5 && bg.length < 40) bag.set(bg, (bag.get(bg) || 0) + 1);
  }
}

/**
 * Searchable summary of every past Claude Code conversation. Each transcript is summarized once and cached by
 * size + mtime (and persisted, so a restart doesn't re-read hundreds of MB); concurrent callers share one build.
 */
export class SessionIndex {
  private files: Map<string, FileEntry> | null = null;
  private list: IndexedSession[] | null = null;
  private builtAt = 0;
  private building: Promise<IndexedSession[]> | null = null;

  constructor(private readonly scanner: TranscriptScanner, private readonly p: { projects: string; indexFile: string }) {}

  build(force = false): Promise<IndexedSession[]> {
    if (!force && this.list && Date.now() - this.builtAt < 60000) return Promise.resolve(this.list);
    if (!this.building) this.building = this.buildNow().finally(() => { this.building = null; });
    return this.building;
  }

  private async loadCache(): Promise<Map<string, FileEntry>> {
    try {
      const cached = JSON.parse(await fs.promises.readFile(this.p.indexFile, "utf8"));
      if (cached.version === INDEX_VERSION && cached.files) return new Map(Object.entries(cached.files) as Array<[string, FileEntry]>);
    } catch {}
    return new Map();
  }

  private async buildNow(): Promise<IndexedSession[]> {
    if (!this.files) this.files = await this.loadCache();
    const files = this.files;
    const present = new Set<string>();
    let changed = false;
    try {
      for (const d of await fs.promises.readdir(this.p.projects)) {
        const dp = path.join(this.p.projects, d);
        let stat: fs.Stats; try { stat = await fs.promises.stat(dp); } catch { continue; }
        if (!stat.isDirectory()) continue;
        let names: string[]; try { names = await fs.promises.readdir(dp); } catch { continue; }
        for (const f of names.filter((x) => x.endsWith(".jsonl"))) {
          const fp = path.join(dp, f);
          let st: fs.Stats; try { st = await fs.promises.stat(fp); } catch { continue; }
          present.add(fp);
          const hit = files.get(fp);
          if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) continue;
          let session: IndexedSession | null = null;
          try { session = await this.indexConversation(fp, f.replace(".jsonl", ""), d); } catch {}
          files.set(fp, { size: st.size, mtimeMs: st.mtimeMs, session: session && session.messageCount > 0 ? session : null });
          changed = true;
        }
      }
    } catch {}
    for (const fp of files.keys()) if (!present.has(fp)) { files.delete(fp); changed = true; }

    const result: IndexedSession[] = [];
    for (const { session } of files.values()) if (session) result.push(session);
    result.sort((a, b) => new Date(b.lastMessage as string).getTime() - new Date(a.lastMessage as string).getTime());
    this.list = result;
    this.builtAt = Date.now();

    if (changed) {
      try {
        await fs.promises.writeFile(this.p.indexFile, JSON.stringify({ version: INDEX_VERSION, timestamp: Date.now(), files: Object.fromEntries(files) }));
      } catch {}
    }
    return result;
  }

  private async indexConversation(filePath: string, fileId: string, projDir: string): Promise<IndexedSession | null> {
    let firstTs: string | null = null, lastTs: string | null = null, slug: string | null = null, model: string | null = null, branch: string | null = null;
    let cwd: string | null = null, entrypoint: string | null = null;
    let msgCount = 0, userMsgCount = 0, freshInTok = 0, cacheWriteTok = 0, cacheReadTok = 0, outTok = 0;
    const kwBag = new Map<string, number>();
    const filesEdited = new Set<string>();
    const cmds = new Set<string>();
    const userMsgs: string[] = [];

    await this.scanner.scan(filePath, 0, (e) => {
      if (e.timestamp) { if (!firstTs) firstTs = e.timestamp; lastTs = e.timestamp; }
      if (!slug && e.slug) slug = e.slug;
      if (!branch && e.gitBranch && e.gitBranch !== "HEAD") branch = e.gitBranch;
      if (!cwd && e.cwd) cwd = e.cwd;
      if (!entrypoint && e.entrypoint) entrypoint = e.entrypoint;

      if (e.type === "user" && e.message?.role === "user") {
        msgCount++;
        const c = e.message.content;
        if (typeof c === "string") {
          userMsgCount++;
          if (userMsgCount <= 25) { userMsgs.push(c); extractKeywords(c, kwBag); }
        }
        if (e.toolUseResult?.filePath) {
          filesEdited.add(String(e.toolUseResult.filePath).replace(/\\/g, "/").split("/").pop() as string);
        }
      }

      if (e.type === "assistant" && e.message) {
        msgCount++;
        const u = e.message.usage;
        if (u) {
          freshInTok += u.input_tokens || 0;
          cacheWriteTok += u.cache_creation_input_tokens || 0;
          cacheReadTok += u.cache_read_input_tokens || 0;
          outTok += u.output_tokens || 0;
        }
        if (!model && e.message.model) model = e.message.model;
        if (Array.isArray(e.message.content)) {
          for (const b of e.message.content) {
            if (b.type === "tool_use" && b.name === "Bash" && b.input?.command) {
              cmds.add(String(b.input.command).split("\n")[0].trim().slice(0, 60));
            }
            // Index text blocks from assistant for richer keyword extraction
            if (b.type === "text" && typeof b.text === "string" && userMsgCount <= 25) {
              // Only extract from first ~200 chars of each response to avoid noise
              extractKeywords(b.text.slice(0, 200), kwBag);
            }
          }
        }
      }
    });

    if (userMsgCount === 0) return null;

    const sortedKw = [...kwBag.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);

    // Cost estimate — effective rates for Claude Code with ephemeral caching
    // Cache writes are free (ephemeral 5-min), cache reads ~1% input, output discounted
    let cIn = 15, cCacheRead = 0.10, cOut = 40; // opus $/M (effective)
    const m = model as string | null;
    if (m?.includes("sonnet")) { cIn = 3; cCacheRead = 0.02; cOut = 8; }
    if (m?.includes("haiku")) { cIn = 0.25; cCacheRead = 0.002; cOut = 0.65; }
    const cost = Math.round((
      (freshInTok / 1e6 * cIn) +           // fresh (uncached) input at full rate
      (cacheReadTok / 1e6 * cCacheRead) +   // cache reads at ~1% of input (ephemeral)
      (outTok / 1e6 * cOut)                  // output at full rate
    ) * 100) / 100;
    const totalInTok = freshInTok + cacheWriteTok + cacheReadTok;

    return {
      id: fileId,
      project: projDir,
      projectPath: decodeClaudeProjectPath(projDir),
      slug: (slug as string | null) || fileId.slice(0, 8),
      model: m || "unknown",
      branch: (branch as string | null) || "",
      cwd: (cwd as string | null) || "",
      entrypoint: (entrypoint as string | null) || "cli",
      firstMessage: firstTs,
      lastMessage: lastTs,
      messageCount: msgCount,
      userMessageCount: userMsgCount,
      totalInputTokens: totalInTok,
      totalOutputTokens: outTok,
      estimatedCost: cost,
      keywords: sortedKw,
      filesEdited: [...filesEdited].slice(0, 25),
      commands: [...cmds].slice(0, 20),
      summary: userMsgs.slice(0, 3).join(" | ").slice(0, 250),
    };
  }

  async search(query: string): Promise<Array<IndexedSession & { score: number }>> {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return [];
    const idx = await this.build();
    const terms = q.split(/\s+/);
    return idx.map((s) => {
      let score = 0;
      for (const t of terms) {
        if (s.keywords.some((k) => k.includes(t))) score += 10;
        if (s.summary.toLowerCase().includes(t)) score += 5;
        if (s.filesEdited.some((f) => f.toLowerCase().includes(t))) score += 3;
        if (s.commands.some((c) => c.toLowerCase().includes(t))) score += 3;
        if (s.project.toLowerCase().includes(t)) score += 2;
        if (s.branch.toLowerCase().includes(t)) score += 2;
        if (s.slug.toLowerCase().includes(t)) score += 1;
      }
      return { ...s, score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 50);
  }

  /** A conversation's first 100 user messages and assistant replies (text only), or null for an unknown id. */
  async conversation(id: string): Promise<(IndexedSession & { entries: unknown[] }) | null> {
    const s = (await this.build()).find((x) => x.id === id);
    if (!s) return null;
    // Return conversation entries (user messages + assistant text only, skip binary/tool noise)
    const entries: unknown[] = [];
    await this.scanner.scan(path.join(this.p.projects, s.project, s.id + ".jsonl"), 0, (e) => {
      if (e.type === "user" && typeof e.message?.content === "string") {
        entries.push({ type: "user", text: e.message.content, ts: e.timestamp });
      } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        const texts = e.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        if (texts) entries.push({ type: "assistant", text: texts.slice(0, 500), ts: e.timestamp, model: e.message.model });
      }
      if (entries.length >= 100) return "stop";
    });
    return { ...s, entries };
  }
}
