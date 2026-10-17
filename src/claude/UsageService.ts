import * as fs from "fs";
import * as path from "path";
import type { TranscriptScanner } from "./TranscriptScanner";

// Pricing per 1M tokens, per provider. Effective pricing for Claude Code with ephemeral caching ($/M tokens):
// cache writes are free (ephemeral 5-min), cache reads ~1% of the input rate.
interface Pricing { input: number; output: number; cache_create: number; cache_read: number }
const PRICING_TABLES: Record<string, Record<"opus" | "sonnet" | "haiku", Pricing>> = {
  anthropic: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.25, output: 0.65, cache_create: 0, cache_read: 0.002 },
  },
  bedrock: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.80, output: 4,    cache_create: 0, cache_read: 0.008 },
  },
  vertex: {
    opus:   { input: 15,   output: 40,   cache_create: 0, cache_read: 0.10  },
    sonnet: { input: 3,    output: 8,    cache_create: 0, cache_read: 0.02  },
    haiku:  { input: 0.25, output: 0.65, cache_create: 0, cache_read: 0.002 },
  },
};

function getModelPricing(modelId: string | null, provider: string): Pricing {
  const table = PRICING_TABLES[provider] || PRICING_TABLES.anthropic;
  if (!modelId) return table.sonnet;
  const lower = modelId.toLowerCase();
  if (lower.includes("opus")) return table.opus;
  if (lower.includes("haiku")) return table.haiku;
  return table.sonnet; // default to sonnet
}

/** Detect provider from message ID patterns in JSONL entries. */
function detectProvider(msgId: string): string | null {
  if (!msgId) return null;
  if (msgId.startsWith("msg_bdrk_")) return "bedrock";
  if (msgId.startsWith("msg_vrtx_")) return "vertex";
  return "anthropic";
}

interface Tokens { input: number; output: number; cacheCreate: number; cacheRead: number }

/** Handles several field-name formats. */
function extractTokens(usage: any): Tokens | null {
  if (!usage) return null;
  return {
    input: usage.inputTokens || usage.input_tokens || usage.prompt_tokens || 0,
    output: usage.outputTokens || usage.output_tokens || usage.completion_tokens || 0,
    cacheCreate: usage.cacheCreationInputTokens || usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0,
  };
}

interface UsageEntry { t: number | null; model: string | null; provider: string | null; tokens: Tokens }
/** What is remembered per transcript. `stamps` are timestamps of entries without usage; they only feed firstSeen/lastSeen. */
interface FileRecord { size: number; mtimeMs: number; offset: number; usage: UsageEntry[]; stamps: number[] }

export interface UsageBucket { input: number; output: number; cacheCreate: number; cacheRead: number; cost: number; messages: number }
export interface UsageResult {
  models: Record<string, UsageBucket>;
  totals: UsageBucket;
  daily: Record<string, { input: number; output: number; cost: number; messages: number }>;
  sessions: Array<{ file: string; messages: number; cost: number }>;
  providers: Record<string, number>;
  firstSeen: string | null;
  lastSeen: string | null;
}

/**
 * Token usage and cost across every Claude Code transcript. A transcript directory easily holds hundreds of MB, so
 * each file is parsed once and then only its appended tail is read (transcripts are append-only); a refresh
 * touches just the files that changed, and concurrent callers share one pass.
 */
export class UsageService {
  private readonly files = new Map<string, FileRecord>();
  private inflight: Promise<void> | null = null;
  private refreshedAt = 0;

  /** `refreshMs`: how long a refresh is trusted before the folder is checked again (env AGENV_USAGE_REFRESH_MS, default 10 s). */
  constructor(
    private readonly scanner: TranscriptScanner,
    private readonly refreshMs = Math.max(0, parseInt(process.env.AGENV_USAGE_REFRESH_MS || "10000", 10)),
  ) {}

  private note(rec: FileRecord, entry: any): void {
    const ts = entry.timestamp || entry.created_at || entry.ts;
    const t = ts ? new Date(ts).getTime() : null;
    // Extract usage data — could be at top level or nested in response/message
    const usage = entry.usage || entry.response?.usage || entry.message?.usage;
    if (!usage) { if (t != null) rec.stamps.push(t); return; }
    const msgId = entry.message?.id || entry.response?.id || entry.id || "";
    rec.usage.push({
      t,
      model: entry.model || entry.response?.model || entry.message?.model || null,
      provider: msgId ? detectProvider(msgId) : null,
      tokens: extractTokens(usage) as Tokens,
    });
  }

  /** Bring the per-file cache up to date. */
  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.refreshedAt < this.refreshMs) return Promise.resolve();
    this.inflight = (async () => {
      const files = await this.scanner.listFiles();
      const present = new Set(files);
      for (const p of this.files.keys()) if (!present.has(p)) this.files.delete(p);
      for (const filePath of files) {
        let st: fs.Stats;
        try { st = await fs.promises.stat(filePath); } catch { continue; }
        let rec = this.files.get(filePath);
        if (rec && rec.size === st.size && rec.mtimeMs === st.mtimeMs) continue;
        // Transcripts are append-only, so a grown file only needs its new tail. A file that shrank was rewritten — start over.
        if (!rec || st.size < rec.offset) {
          rec = { size: 0, mtimeMs: 0, offset: 0, usage: [], stamps: [] };
          this.files.set(filePath, rec);
        }
        try {
          const fileRec = rec;
          fileRec.offset = await this.scanner.scan(filePath, fileRec.offset, (e) => { this.note(fileRec, e); });
          fileRec.size = st.size; fileRec.mtimeMs = st.mtimeMs;
        } catch {
          this.files.delete(filePath); // partial read — re-read from scratch next time
        }
      }
    })().finally(() => { this.inflight = null; this.refreshedAt = Date.now(); });
    return this.inflight;
  }

  async query(o: { from?: string; to?: string; provider?: string }): Promise<UsageResult> {
    try { await this.refresh(); } catch {}

    const providerOverride = o.provider || ""; // "anthropic", "bedrock", "vertex", or "" (auto)
    const from = o.from ? new Date(o.from).getTime() : null;
    const to = o.to ? new Date(o.to).getTime() : null;
    // Entries without a timestamp are never filtered out.
    const inRange = (t: number | null): boolean => t == null || ((from == null || !(t < from)) && (to == null || !(t >= to)));

    const result: UsageResult = {
      models: {},
      totals: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, messages: 0 },
      daily: {},
      sessions: [],
      providers: {}, // auto-detected: { anthropic: count, bedrock: count, vertex: count }
      firstSeen: null,
      lastSeen: null,
    };
    let firstSeen = Infinity, lastSeen = -Infinity;
    const seen = (t: number | null): void => {
      if (t == null || Number.isNaN(t)) return;
      if (t < firstSeen) firstSeen = t;
      if (t > lastSeen) lastSeen = t;
    };

    for (const [filePath, rec] of this.files) {
      for (const t of rec.stamps) if (inRange(t)) seen(t);

      const sessionInfo = { file: path.basename(filePath), messages: 0, cost: 0 };
      for (const u of rec.usage) {
        if (!inRange(u.t)) continue;
        seen(u.t);
        if (u.provider) result.providers[u.provider] = (result.providers[u.provider] || 0) + 1;

        const tokens = u.tokens;
        // Use override provider if set, otherwise auto-detected, otherwise anthropic
        const pricing = getModelPricing(u.model, providerOverride || u.provider || "anthropic");
        const cost =
          (tokens.input * pricing.input / 1000000) +
          (tokens.output * pricing.output / 1000000) +
          (tokens.cacheCreate * pricing.cache_create / 1000000) +
          (tokens.cacheRead * pricing.cache_read / 1000000);

        // Aggregate per model
        const modelKey = u.model || "unknown";
        const m = result.models[modelKey] || (result.models[modelKey] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, messages: 0 });
        m.input += tokens.input; m.output += tokens.output; m.cacheCreate += tokens.cacheCreate; m.cacheRead += tokens.cacheRead; m.cost += cost; m.messages += 1;

        // Aggregate totals
        const tot = result.totals;
        tot.input += tokens.input; tot.output += tokens.output; tot.cacheCreate += tokens.cacheCreate; tot.cacheRead += tokens.cacheRead; tot.cost += cost; tot.messages += 1;

        // Daily breakdown
        if (u.t != null && !Number.isNaN(u.t)) {
          const dayKey = new Date(u.t).toISOString().slice(0, 10);
          const d = result.daily[dayKey] || (result.daily[dayKey] = { input: 0, output: 0, cost: 0, messages: 0 });
          d.input += tokens.input; d.output += tokens.output; d.cost += cost; d.messages += 1;
        }

        sessionInfo.messages += 1;
        sessionInfo.cost += cost;
      }
      if (sessionInfo.messages > 0) result.sessions.push(sessionInfo);
    }

    // Sort sessions by cost descending
    result.sessions.sort((a, b) => b.cost - a.cost);
    result.sessions = result.sessions.slice(0, 20);

    if (firstSeen !== Infinity) result.firstSeen = new Date(firstSeen).toISOString();
    if (lastSeen !== -Infinity) result.lastSeen = new Date(lastSeen).toISOString();
    return result;
  }
}
