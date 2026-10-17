import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";
import { NAME_RE } from "../core/ids";
import type { RunResult, RunSpec } from "./ClaudeRunner";
import type { RunnerLike } from "./TrackedRunner";

const CREATION_BUDGET_USD = 1;
const CREATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// Creation runs must not touch the project. Note: "/compact" under plan mode is not yet verified against the real CLI (the opt-in real check in Task 7 will).
const READ_ONLY = { mode: "plan" as const, allowedTools: [] as string[] };

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
  private runner: RunnerLike;

  constructor(o: { runner: RunnerLike }) { this.runner = o.runner; }

  async fork(o: ForkOptions): Promise<{ conversationId: string; costUsd: number }> {
    const first = await this.runChecked({
      cwd: o.cwd, prompt: o.adoptionPrompt, resume: o.sourceId, fork: true,
      permission: READ_ONLY,
      maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
    });
    if (!first.conversationId || first.conversationId === o.sourceId) throw new HttpError(502, "claude did not start a new conversation");
    let costUsd = first.costUsd;
    if (o.compact) {
      let second: RunResult;
      try {
        second = await this.runChecked({
        cwd: o.cwd, prompt: "/compact", resume: first.conversationId, fork: false,
        permission: READ_ONLY,
        maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
        });
      } catch (e) {
        if (e instanceof HttpError) {
          const err = new HttpError(e.status, e.message, { error: e.message, orphanConversationId: first.conversationId }) as HttpError & { orphanConversationId?: string };
          err.orphanConversationId = first.conversationId;
          throw err;
        }
        throw e;
      }
      costUsd += second.costUsd;
      return { conversationId: second.conversationId || first.conversationId, costUsd };
    }
    return { conversationId: first.conversationId, costUsd };
  }

  async distill(o: DistillOptions): Promise<{ artifactPath: string; costUsd: number }> {
    const target = resolveTarget(o.cwd, o.name, o.artifact);
    assertInside(o.cwd, target);
    if (!o.overwrite) assertAbsent(target);
    const r = await this.runChecked({
      cwd: o.cwd, prompt: DISTILL_PROMPT, resume: o.sourceId, fork: true,
      permission: { mode: "plan", allowedTools: [] },
      maxBudgetUsd: CREATION_BUDGET_USD, timeoutMs: CREATION_TIMEOUT_MS,
    });
    const answer = r.text.trim();
    if (!answer) throw new HttpError(502, "claude returned an empty document");
    const body = o.artifact === "skill" ? skillFile(o.name, o.specialty, answer) : answer + "\n";
    assertInside(o.cwd, target);
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
  if (DEVICE_RE.test(name)) throw new HttpError(400, `"${name}" is a reserved device name on Windows`);
  const root = path.resolve(cwd);
  const target = artifact === "skill"
    ? path.resolve(root, ".claude", "skills", name, "SKILL.md")
    : path.resolve(root, ".claude", "agenv-briefings", name + ".md");
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(400, "Name would write outside the folder");
  return target;
}

/** Real path of the deepest existing ancestor of the target must still be inside the real cwd (links and junctions included). */
function assertInside(cwd: string, target: string): void {
  let root: string, d = path.dirname(target);
  try { root = fs.realpathSync(path.resolve(cwd)); } catch { throw new HttpError(400, "Folder does not exist"); }
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  let real: string;
  try { real = fs.realpathSync(d); } catch { throw new HttpError(400, "Cannot resolve the target folder"); }
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new HttpError(400, "Target resolves outside the folder");
}

function assertAbsent(file: string): void {
  let exists = true;
  try { fs.lstatSync(file); } catch { exists = false; }
  if (exists) throw new HttpError(409, `${file} already exists`, { error: `${file} already exists`, code: "exists" });
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
    fs.writeFileSync(tmp, body, { encoding: "utf8", flag: "wx" });
    if (overwrite) fs.renameSync(tmp, file);
    else publishNew(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    for (const d of created) { try { fs.rmdirSync(d); } catch {} }
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, `Could not write ${file}: ${(e as Error).message}`);
  }
}

/** Atomically publishes tmp as file only if file does not exist (hard link, then drop tmp). */
function publishNew(tmp: string, file: string): void {
  try {
    fs.linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `${file} already exists`, { error: `${file} already exists`, code: "exists" });
    assertAbsent(file);   // file system without hard links: best effort
    fs.renameSync(tmp, file);
    return;
  }
  fs.unlinkSync(tmp);
}
