import * as fs from "fs";
import * as path from "path";
import { HttpError } from "../core/HttpError";

export interface Prompt {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  created: number;
  used: number;
  lastUsed?: number;
  [extra: string]: unknown;
}

/** Saved prompts (~/.claude/agenv-prompts.json, plain readable JSON). */
export class PromptLibrary {
  constructor(private readonly file: string) {}

  list(): Prompt[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  private save(prompts: Prompt[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(prompts, null, 2));
  }

  create(b: { title?: string; content?: string; category?: string; tags?: string[] }): Prompt {
    const { title, content, category, tags } = b || {};
    if (!title || !content) throw new HttpError(400, "title and content required");
    const prompts = this.list();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const prompt: Prompt = { id, title, content, category: category || "general", tags: tags || [], created: Date.now(), used: 0 };
    prompts.push(prompt);
    this.save(prompts);
    return prompt;
  }

  update(id: string, body: Record<string, unknown>): Prompt {
    const prompts = this.list();
    const idx = prompts.findIndex((p) => p.id === id);
    if (idx < 0) throw new HttpError(404, "Not found");
    Object.assign(prompts[idx], body, { id });
    this.save(prompts);
    return prompts[idx];
  }

  /** Returns whether the prompt existed. */
  remove(id: string): boolean {
    const prompts = this.list();
    const kept = prompts.filter((p) => p.id !== id);
    this.save(kept);
    return kept.length !== prompts.length;
  }

  /** Count a use; returns whether the prompt existed. */
  use(id: string): boolean {
    const prompts = this.list();
    const p = prompts.find((x) => x.id === id);
    if (!p) return false;
    p.used = (p.used || 0) + 1;
    p.lastUsed = Date.now();
    this.save(prompts);
    return true;
  }
}
