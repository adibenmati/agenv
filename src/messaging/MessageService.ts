import * as crypto from "crypto";
import { HttpError } from "../core/HttpError";
import type { TypedEmitter } from "../core/TypedEmitter";
import type { Session } from "../sessions/Session";
import type { SessionEvents } from "../sessions/events";

export type MessageStatus = "queued" | "delivered" | "failed";

export interface Message {
  id: number;
  ts: number;
  /** Sender's session name, or "you" for a message typed in the agenv UI. */
  from: string;
  fromId: number | null;
  to: string;
  toId: number;
  text: string;
  status: MessageStatus;
  error?: string;
}

export interface Peer {
  id: number;
  name: string;
  tool: string;
  /** "busy" while the terminal printed something a moment ago; a message waits for "idle". */
  state: "idle" | "busy";
  live: boolean;
}

export interface BroadcastResult {
  id: number;
  name: string;
  status: "sent" | "skipped";
  reason?: string;
}

export interface MessageServiceOptions {
  bus: TypedEmitter<SessionEvents>;
  sessions: { get(id: number): Session | undefined; all(): Session[] };
  onChange?: () => void;
  now?: () => number;
  /** Output must have been silent this long before a message is typed in. */
  quietMs?: number;
  /** A message that never finds its target quiet is failed after this long. */
  maxWaitMs?: number;
  /** Gap between typing the message and pressing Enter. */
  submitDelayMs?: number;
  /** Poll interval of the delivery loop; 0 = no timer (tests call pump()). */
  tickMs?: number;
}

/** CLIs that read a typed line as a prompt; anything else (a bare shell, ssh, python) would run the text as a command. */
const AGENT_TOOLS = new Set(["claude", "codex", "gemini", "vertex", "agent-cli"]);
const MAX_TEXT = 4000;
const MAX_LOG = 200;
const PAIR_LIMIT = 30;
const PAIR_WINDOW_MS = 10 * 60 * 1000;

const displayName = (s: Session): string => s.name || "session " + s.id;
const quoteArg = (name: string): string => (/^[\w.-]+$/.test(name) ? name : '"' + name.replace(/"/g, "'") + '"');

/**
 * Lets running sessions talk to each other by name, whatever CLI runs inside them. A message is typed into the
 * target's terminal as if the user had typed it, once that terminal has been quiet for a moment; the target answers
 * with `agenv send` the same way. Closed sessions and sessions with no agent CLI are refused, not queued.
 */
export class MessageService {
  private readonly log: Message[] = [];
  private nextId = 1;
  private readonly lastOutput = new Map<number, number>();
  private readonly tokens = new Map<string, number>();
  private readonly tokenBySession = new Map<number, string>();
  private readonly pairSends = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly submitDelayMs: number;

  constructor(private readonly o: MessageServiceOptions) {
    this.now = o.now || Date.now;
    this.quietMs = o.quietMs ?? 1500;
    this.maxWaitMs = o.maxWaitMs ?? 5 * 60 * 1000;
    this.submitDelayMs = o.submitDelayMs ?? 300;
    o.bus.on("output", (s) => { this.lastOutput.set(s.id, this.now()); });
    o.bus.on("deleted", (s) => { this.lastOutput.delete(s.id); this.failQueued(s.id, "the session was closed"); });
    const tick = o.tickMs ?? 500;
    if (tick > 0) { this.timer = setInterval(() => this.pump(), tick); this.timer.unref(); }
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }

  // ---- identity ----

  /** The private token a session carries in its environment; it can only use the messaging routes. */
  tokenFor(sessionId: number): string {
    let t = this.tokenBySession.get(sessionId);
    if (!t) { t = crypto.randomBytes(24).toString("hex"); this.tokenBySession.set(sessionId, t); this.tokens.set(t, sessionId); }
    return t;
  }

  sessionForToken(token: string): number | null {
    const id = this.tokens.get(token);
    return id !== undefined && this.o.sessions.get(id) ? id : null;
  }

  // ---- reading ----

  peers(): Peer[] {
    return this.o.sessions.all().map((s) => ({
      id: s.id, name: s.name, tool: s.detectedTool || "terminal", live: !!(s.live && s.pty),
      state: this.isQuiet(s.id) ? "idle" : "busy",
    }));
  }

  messages(): Message[] { return this.log.slice(); }

  // ---- sending ----

  send(fromId: number | null, ref: string, text: string): Message {
    const body = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!body) throw new HttpError(400, "Message is empty");
    if (body.length > MAX_TEXT) throw new HttpError(400, "Message is too long (max " + MAX_TEXT + " characters)");
    const target = this.resolve(ref);
    if (fromId === target.id) throw new HttpError(400, "A session cannot message itself");
    const sender = fromId === null ? null : this.o.sessions.get(fromId);
    if (fromId !== null && !sender) throw new HttpError(404, "Sending session not found");
    const label = displayName(target);
    if (!target.live || !target.pty) throw new HttpError(409, `"${label}" is closed (it has no running terminal)`);
    if (!AGENT_TOOLS.has(target.detectedTool) && !target.claudeRunning) {
      throw new HttpError(409, `No agent CLI is running in "${label}" (it shows ${target.detectedTool || "a plain terminal"}), so the message would run as a shell command`);
    }
    this.checkPairLimit(fromId, target.id);

    const m: Message = {
      id: this.nextId++, ts: this.now(), from: sender ? displayName(sender) : "you", fromId,
      to: label, toId: target.id, text: body, status: "queued",
    };
    this.log.push(m);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.pump();
    this.o.onChange?.();
    return m;
  }

  /**
   * Type `command` and Enter into many sessions at once — what you would do by hand in each tab, e.g. a slash command
   * such as /remote-control. `group` limits it to a session group (and its subgroups); `agentsOnly` skips plain shells,
   * where the text would run as a shell command.
   */
  broadcast(command: string, opts: { group?: string; agentsOnly?: boolean } = {}): BroadcastResult[] {
    const text = String(command == null ? "" : command).replace(/\s+/g, " ").trim();
    if (!text) throw new HttpError(400, "Command is empty");
    if (text.length > MAX_TEXT) throw new HttpError(400, "Command is too long (max " + MAX_TEXT + " characters)");
    const group = typeof opts.group === "string" ? opts.group : undefined;
    const results: BroadcastResult[] = [];
    for (const s of this.o.sessions.all()) {
      if (group !== undefined && !(s.group === group || s.group.startsWith(group + "/"))) continue;
      const name = displayName(s);
      const skip = (reason: string): void => { results.push({ id: s.id, name, status: "skipped", reason }); };
      if (!s.live || !s.pty) { skip("closed"); continue; }
      if (opts.agentsOnly && !AGENT_TOOLS.has(s.detectedTool) && !s.claudeRunning) { skip("no agent CLI running"); continue; }
      s.pty.write(text);
      this.lastOutput.set(s.id, this.now());
      const pty = s.pty;
      const press = (): void => { try { pty.write("\r"); } catch {} };
      if (this.submitDelayMs > 0) setTimeout(press, this.submitDelayMs).unref(); else press();
      results.push({ id: s.id, name, status: "sent" });
    }
    return results;
  }

  /** Deliver what is deliverable (one message per target per call) and fail what waited too long. */
  pump(): void {
    const served = new Set<number>();
    let changed = false;
    const t = this.now();
    for (const m of this.log) {
      if (m.status !== "queued") continue;
      const s = this.o.sessions.get(m.toId);
      if (!s || !s.live || !s.pty) { this.fail(m, "the session was closed"); changed = true; continue; }
      if (t - m.ts > this.maxWaitMs) { this.fail(m, "the session stayed busy"); changed = true; continue; }
      if (served.has(m.toId) || !this.isQuiet(m.toId)) continue;
      served.add(m.toId);
      this.deliver(m, s);
      changed = true;
    }
    if (changed) this.o.onChange?.();
  }

  // ---- internals ----

  private isQuiet(id: number): boolean {
    const last = this.lastOutput.get(id);
    return last === undefined || this.now() - last >= this.quietMs;
  }

  private deliver(m: Message, s: Session): void {
    const reply = m.fromId === null ? "" : ` (reply with: agenv send ${quoteArg(m.from)} "<your answer>")`;
    s.pty!.write(`[agenv message from ${m.from}] ${m.text}${reply}`);
    this.lastOutput.set(s.id, this.now());
    const press = (): void => { try { s.pty?.write("\r"); } catch {} };
    if (this.submitDelayMs > 0) setTimeout(press, this.submitDelayMs).unref(); else press();
    m.status = "delivered";
  }

  private fail(m: Message, why: string): void { m.status = "failed"; m.error = why; }

  private failQueued(toId: number, why: string): void {
    let changed = false;
    for (const m of this.log) if (m.status === "queued" && m.toId === toId) { this.fail(m, why); changed = true; }
    if (changed) this.o.onChange?.();
  }

  private checkPairLimit(fromId: number | null, toId: number): void {
    const key = fromId + ">" + toId;
    const t = this.now();
    const recent = (this.pairSends.get(key) || []).filter((x) => t - x < PAIR_WINDOW_MS);
    if (recent.length >= PAIR_LIMIT) {
      throw new HttpError(429, `Too many messages in a row from this session to that one (max ${PAIR_LIMIT} per 10 minutes); it looks like a loop`);
    }
    recent.push(t);
    this.pairSends.set(key, recent);
  }

  private resolve(ref: string): Session {
    const r = String(ref == null ? "" : ref).trim();
    if (!r) throw new HttpError(400, "Say who the message is for");
    const num = /^#?(\d+)$/.exec(r);
    if (num) {
      const byId = this.o.sessions.get(parseInt(num[1], 10));
      if (byId) return byId;
    }
    const lower = r.toLowerCase();
    const named = this.o.sessions.all().filter((s) => s.name && s.name.toLowerCase() === lower);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new HttpError(409, `More than one session is named "${r}"; use its id (${named.map((s) => s.id).join(", ")})`);
    throw new HttpError(404, `No session named "${r}"`);
  }
}
