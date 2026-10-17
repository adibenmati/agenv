import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import { ClaudeRunner, RunResult, RunSpec } from "./ClaudeRunner";

const CREATION_BUDGET_USD = 1;
const CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

export const DISTILL_PROMPT = [
  "You are preparing a hand-over for a new assistant that has no access to this conversation.",
  "Write a self-contained document that lets it take over this work. Cover:",
  "- Role: what the assistant is for and what it is responsible for.",
  "- Conventions: coding style, naming, structure and rules this project follows.",
  "- Decisions: choices already made, with the reason, so they are not reopened.",
  "- Commands: the exact commands to build, test, run and deploy.",
  "- Pitfalls: mistakes to avoid and problems already hit.",
  "Do not use any tools and do not change any files.",
  "Reply with only the document, in Markdown, with no preface and no closing remarks.",
].join("\n");

export interface ForkOptions { sourceId: string; cwd: string; adoptionPrompt: string; compact: boolean }
export interface DistillOptions {
  sourceId: string; cwd: string; name: string; specialty: string;
  artifact: "briefing" | "skill"; overwrite: boolean;
}

export class ConversationForker {
  private runner: ClaudeRunner;

  constructor(o: { runner: ClaudeRunner }) { this.runner = o.runner; }

  async fork(o: ForkOptions): Promise<{ conversationId: string; costUsd: number }> {
    const first = await this.runChecked({
      cwd: o.cwd, prompt: o.adoptionPrompt, resume: o.sourceId, fork: true,
      permission: { mode: "acceptEdits", allowedTools: [] },
      maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
    });
    if (!first.conversationId || first.conversationId === o.sourceId) throw new HttpError(502, "claude did not start a new conversation");
    let costUsd = first.costUsd;
    if (o.compact) {
      const second = await this.runChecked({
        cwd: o.cwd, prompt: "/compact", resume: first.conversationId, fork: false,
        permission: { mode: "acceptEdits", allowedTools: [] },
        maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
      });
      costUsd += second.costUsd;
    }
    return { conversationId: first.conversationId, costUsd };
  }

  async distill(o: DistillOptions): Promise<{ artifactPath: string; costUsd: number }> {
    const target = resolveTarget(o.cwd, o.name, o.artifact);
    if (!o.overwrite) assertAbsent(target);
    const r = await this.runChecked({
      cwd: o.cwd, prompt: DISTILL_PROMPT, resume: o.sourceId, fork: true,
      permission: { mode: "plan", allowedTools: [] },
      maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
    });
    const answer = r.text.trim();
    if (!answer) throw new HttpError(502, "claude returned an empty document");
    const body = o.artifact === "skill" ? skillFile(o.name, o.specialty, answer) : answer + "\n";
    writeNew(target, body, o.overwrite);
    return { artifactPath: target, costUsd: r.costUsd };
  }

  private async runChecked(spec: RunSpec): Promise<RunResult> {
    const r = await this.runner.run(spec).done;
    if (r.status !== "succeeded") throw new HttpError(502, r.error || `Run ${r.status.replace("_", " ")}`);
    return r;
  }
}

function resolveTarget(cwd: string, name: string, artifact: "briefing" | "skill"): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new HttpError(400, "Name must be 1-48 characters: letters, digits, '-' or '_'");
  }
  const root = path.resolve(cwd);
  const target = artifact === "skill"
    ? path.resolve(root, ".claude", "skills", name, "SKILL.md")
    : path.resolve(root, ".claude", "agenv-briefings", name + ".md");
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(400, "Name would write outside the folder");
  return target;
}

function assertAbsent(file: string): void {
  let exists = true;
  try { fs.lstatSync(file); } catch { exists = false; }
  if (exists) throw new HttpError(409, `${file} already exists`);
}

function skillFile(name: string, specialty: string, body: string): string {
  const desc = specialty.replace(/\s+/g, " ").trim() || `Knowledge distilled for ${name}`;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`;
}

/** Writes through a temp file and rename; creates missing directories only now and removes them again if the write fails. */
function writeNew(file: string, body: string, overwrite: boolean): void {
  const dir = path.dirname(file);
  const created: string[] = [];
  for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) created.push(d);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!overwrite) assertAbsent(file);
    fs.writeFileSync(tmp, body, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    for (const d of created) { try { fs.rmdirSync(d); } catch {} }
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `Could not write ${file}: ${(e as Error).message}`);
  }
}
