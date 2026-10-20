import { detectToolFromOutput } from "./tools";
import * as path from "path";
import type { SessionStatus } from "../core/types";
import type { Session } from "./Session";
import type { SessionBus } from "./events";

// ---------------------------------------------------------------------------
// Status detection — pattern matching on PTY output
// ---------------------------------------------------------------------------
const STATUS_PATTERNS: Record<"idle" | "waiting" | "error" | "busy", RegExp[]> = {
  // Prompt patterns → idle (waiting for user input in shell)
  idle: [
    /[\$#>]\s*$/,                    // bash/zsh prompt
    /^PS [A-Z]:\\/i,                 // PowerShell
    /^[A-Z]:\\[^>]*>/,               // cmd.exe
    /^\([\w.-]+\)\s.*[\$#>]\s*$/,    // venv prompt
  ],
  // Waiting patterns → agent needs human input
  waiting: [
    /\? .*[:：]\s*$/,                // interactive prompt
    /\(y\/n\)/i,                     // yes/no
    /\[Y\/n\]/i,                     // default yes
    /\[yes\/no\]/i,
    /Press Enter/i,
    /waiting for.*input/i,
    /Do you want to/i,
    /\(yes\/no\/\[fingerprint\]\)/,  // SSH
    /Enter passphrase/i,
    /Password:/i,
    /approve this tool/i,            // Claude Code
    /Do you want to proceed/i,
  ],
  // Error patterns
  error: [
    /error[:\s]/i,
    /Error:/,
    /FAILED/,
    /panic:/,
    /Traceback \(most recent/,
    /SyntaxError/,
    /TypeError/,
    /fatal:/i,
    /ENOENT/,
    /EACCES/,
    /command not found/,
  ],
  // Busy patterns → agent is actively working
  busy: [
    /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,      // spinner
    /\.\.\.\s*$/,                    // trailing dots
    /Compiling|Building|Installing/i,
    /Downloading|Fetching/i,
    /Running|Executing/i,
    /Thinking|Generating/i,
    /\[\d+\/\d+\]/,                  // progress [3/10]
    /\d+%/,                          // percentage
  ],
};

// Cost tracking patterns (Claude Code, Vertex, OpenAI Codex, Gemini)
const COST_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  // "$X.XX" standalone or "cost: $X.XX" or "total: $X.XX" or "session cost: $X.XX"
  { type: "cost", pattern: /(?:cost|total|session|spent)[:\s]*\$?([\d]+\.[\d]+)/i },
  // "X input tokens ... Y output tokens"
  { type: "tokens_io", pattern: /(\d[\d,]*)\s*input\s*tokens?.*?(\d[\d,]*)\s*output\s*tokens?/i },
  // "Input: N tokens" lines
  { type: "input_tokens", pattern: /input[:\s]*(\d[\d,]*)\s*tokens?/i },
  // "Output: N tokens" lines
  { type: "output_tokens", pattern: /output[:\s]*(\d[\d,]*)\s*tokens?/i },
  // "N tokens" generic
  { type: "generic_tokens", pattern: /(\d[\d,]+)\s*tokens?\s*(?:used|consumed|total)/i },
  // Claude Code summary: "⏺ Total cost: $X.XX"
  { type: "cost", pattern: /\$(\d+\.[\d]+)/i },
];

export function detectSessionStatus(text: string): SessionStatus | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] || "";
  const last3 = lines.slice(-3).join("\n");

  // Check waiting first (highest priority)
  for (const p of STATUS_PATTERNS.waiting) if (p.test(lastLine) || p.test(last3)) return "waiting";
  // Check busy
  for (const p of STATUS_PATTERNS.busy) if (p.test(lastLine) || p.test(last3)) return "running";
  // Check error (only on last line)
  for (const p of STATUS_PATTERNS.error) if (p.test(lastLine)) return "error";
  // Check idle
  for (const p of STATUS_PATTERNS.idle) if (p.test(lastLine)) return "idle";
  return null; // unknown
}

export interface TokenInfo { inputTokens?: number; outputTokens?: number; cost?: number }

export function parseTokenInfo(text: string): TokenInfo | null {
  const info: TokenInfo = {};
  for (const { type, pattern } of COST_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    if (type === "cost") {
      const c = parseFloat(m[1]);
      if (c > 0 && c < 1000) info.cost = c; // sanity check
    } else if (type === "tokens_io") {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
      info.outputTokens = parseInt(m[2].replace(/,/g, ""), 10);
    } else if (type === "input_tokens") {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    } else if (type === "output_tokens") {
      info.outputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    } else if (type === "generic_tokens" && !info.inputTokens) {
      info.inputTokens = parseInt(m[1].replace(/,/g, ""), 10);
    }
  }
  return Object.keys(info).length ? info : null;
}

// ---------------------------------------------------------------------------
// Output analysis (cwd / status / cost)
//
// Runs on a timer over the accumulated tail rather than on every chunk. Re-running a strip-ANSI pass plus ~20
// regexes — and a synchronous existsSync+statSync — for every repaint frame of every session was a major cost.
// ---------------------------------------------------------------------------
const DETECT_INTERVAL_MS = 250;
const DETECT_TAIL_BYTES = 8192;
export const STRIP_ANSI = /\x1b\[[0-9;?]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]/g;
const OSC7_CWD = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/;
const CMD_PROMPT = /([a-zA-Z]:\\[^>\r\n]*?)>\s*$/m;
const PS_PROMPT = /PS\s+([a-zA-Z]:\\[^\r\n>]*?)>\s*$/m;

interface Pending { tail: string; timer: NodeJS.Timeout | null }

/** Watches every session's output and keeps its folder, status and cost up to date. */
export class OutputAnalyzer {
  private readonly pending = new Map<Session, Pending>();
  private readonly onOutput = (s: Session, data: string): void => this.note(s, data);
  private readonly onDeleted = (s: Session): void => this.forget(s);

  constructor(
    private readonly bus: SessionBus,
    private readonly isRealDir: (p: string) => boolean,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    bus.on("output", this.onOutput);
    bus.on("deleted", this.onDeleted);
  }

  dispose(): void {
    this.bus.off("output", this.onOutput);
    this.bus.off("deleted", this.onDeleted);
    for (const s of [...this.pending.keys()]) this.forget(s);
  }

  private forget(s: Session): void {
    const p = this.pending.get(s);
    if (p?.timer) clearTimeout(p.timer);
    this.pending.delete(s);
  }

  private note(s: Session, data: string): void {
    let p = this.pending.get(s);
    if (!p) { p = { tail: "", timer: null }; this.pending.set(s, p); }
    p.tail += data;
    if (p.tail.length > DETECT_TAIL_BYTES) p.tail = p.tail.slice(-DETECT_TAIL_BYTES);
    if (p.timer) return;
    p.timer = setTimeout(() => { p!.timer = null; this.run(s); }, DETECT_INTERVAL_MS);
  }

  private setCwd(s: Session, cwd: string): void {
    if (!cwd || cwd === s.cwd) return;
    s.cwd = cwd;
    this.bus.emit("changed", s);
    this.bus.emit("cwd", s, cwd);
  }

  private run(s: Session): void {
    const p = this.pending.get(s);
    if (!p) return;
    const raw = p.tail;
    if (!raw) return;
    p.tail = "";

    const osc7 = raw.match(OSC7_CWD);
    if (osc7) {
      try { this.setCwd(s, decodeURIComponent(osc7[1])); } catch {}
    }

    const plain = raw.replace(STRIP_ANSI, "");

    // CWD from Windows/PowerShell prompts (no OSC7 there)
    if (this.platform === "win32") {
      const psMatch = plain.match(PS_PROMPT);
      const cmdMatch = plain.match(CMD_PROMPT);
      const detected = (psMatch && psMatch[1]) || (cmdMatch && cmdMatch[1]);
      if (detected && detected !== s.cwd) {
        try {
          const resolved = path.win32.resolve(detected);
          if (this.isRealDir(resolved)) this.setCwd(s, resolved);
        } catch {}
      }
    }

    if (s.detectedTool === "terminal") {
      const found = detectToolFromOutput(plain);
      if (found) { s.detectedTool = found; this.bus.emit("changed", s); }
    }

    const newStatus = detectSessionStatus(plain);
    if (newStatus && newStatus !== s.status) {
      s.status = newStatus;
      this.bus.emit("status", s, newStatus);
    }

    if (s.detectedTool !== "terminal") {
      const info = parseTokenInfo(plain);
      if (info) {
        if (info.inputTokens) s.analytics.inputTokens += info.inputTokens;
        if (info.outputTokens) s.analytics.outputTokens += info.outputTokens;
        if (info.cost) s.analytics.estimatedCost += info.cost;
        s.analytics.turnCount++;
      }
    }
  }
}
