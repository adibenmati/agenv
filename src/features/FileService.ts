import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HttpError } from "../core/HttpError";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface FileItem { name: string; path: string; isDir: boolean; size: number; mtime: number }

export interface FileServiceOptions {
  /** Where uploads (and clips without a session) go; default `<tmp>/agenv-uploads`. */
  uploadDir?: string;
  /** Working folder of a session, for saving clips next to it; undefined when there is no such session. */
  sessionCwd: (sessionId: number) => string | undefined;
}

/** The file explorer, editor save, and drag-drop / clipboard uploads. */
export class FileService {
  private readonly uploadDir: string;

  constructor(private readonly o: FileServiceOptions) {
    this.uploadDir = o.uploadDir || path.join(os.tmpdir(), "agenv-uploads");
    try { fs.mkdirSync(this.uploadDir, { recursive: true }); } catch {}
  }

  async list(dirArg: unknown, hidden: boolean): Promise<{ dir: string; parent: string; items: FileItem[] }> {
    const resolved = path.resolve(typeof dirArg === "string" && dirArg ? dirArg : process.cwd());
    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      const items: FileItem[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && !hidden) continue;
        const full = path.join(resolved, e.name);
        let stat: fs.Stats;
        try { stat = await fs.promises.stat(full); } catch { continue; }
        items.push({ name: e.name, path: full, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : stat.size, mtime: stat.mtimeMs });
      }
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return { dir: resolved, parent: path.dirname(resolved), items };
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
  }

  async read(filePath: unknown): Promise<{ path: string; name: string; content: string; size: number }> {
    if (!filePath || typeof filePath !== "string") throw new HttpError(400, "Missing path");
    const resolved = path.resolve(filePath);
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.size > MAX_READ_BYTES) throw new HttpError(400, "File too large (>2MB)");
      const content = await fs.promises.readFile(resolved, "utf8");
      return { path: resolved, name: path.basename(resolved), content, size: stat.size };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      if (e.code === "ENOENT") throw new HttpError(404, "File not found", { error: "File not found", code: "ENOENT", path: resolved });
      throw new HttpError(400, e.message);
    }
  }

  async write(filePath: unknown, content: unknown): Promise<{ ok: true; path: string; size: number }> {
    if (!filePath || typeof filePath !== "string") throw new HttpError(400, "Missing path");
    if (content == null) throw new HttpError(400, "Missing content");
    const resolved = path.resolve(filePath);
    try {
      await fs.promises.writeFile(resolved, content as string, "utf8");
      const stat = await fs.promises.stat(resolved);
      return { ok: true, path: resolved, size: stat.size };
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
  }

  /** A dropped or pasted file, base64-encoded. */
  async upload(b: { filename?: string; data?: unknown; type?: string }): Promise<{ ok: true; path: string; name: string; size: number }> {
    const { filename, data, type } = b;
    if (!data) throw new HttpError(400, "Missing data");

    const ext = filename
      ? path.extname(filename)
      : (type === "image/png" ? ".png" : type === "image/jpeg" ? ".jpg" : type === "image/gif" ? ".gif" : ".bin");
    const baseName = filename ? path.basename(filename, path.extname(filename)) : "upload";
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, "_") + "-" + Date.now() + ext;
    const filePath = path.join(this.uploadDir, safeName);

    try {
      const buf = Buffer.from(data as string, "base64");
      if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(400, "File too large (>50MB)");
      await fs.promises.writeFile(filePath, buf);
      return { ok: true, path: filePath, name: safeName, size: buf.length };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, e.message);
    }
  }

  /**
   * Smart Paste: saves clipboard content to a file (in the session's folder under .clips when there is one) so an
   * agent can read it from a path instead of an inline paste.
   */
  async clip(b: { sessionId?: unknown; content?: unknown; contentBase64?: unknown; mimeType?: string; filename?: string }): Promise<{ ok: true; path: string; name: string; size: number }> {
    const { sessionId, content, contentBase64, mimeType, filename } = b;
    if (!content && !contentBase64) throw new HttpError(400, "Missing content");

    // Determine save directory — session CWD if available, else the upload folder
    let saveDir = this.uploadDir;
    if (sessionId) {
      const cwd = this.o.sessionCwd(Number(sessionId));
      if (cwd) saveDir = path.join(cwd, ".clips");
    }
    try { await fs.promises.mkdir(saveDir, { recursive: true }); } catch {}

    // Determine extension and name
    let ext = ".txt";
    if (filename) {
      ext = path.extname(filename) || ext;
    } else if (mimeType) {
      if (mimeType.startsWith("image/png")) ext = ".png";
      else if (mimeType.startsWith("image/jpeg")) ext = ".jpg";
      else if (mimeType.startsWith("image/gif")) ext = ".gif";
      else if (mimeType.startsWith("image/webp")) ext = ".webp";
      else if (mimeType.startsWith("image/svg")) ext = ".svg";
      else if (mimeType === "text/html") ext = ".html";
      else if (mimeType === "text/csv") ext = ".csv";
      else if (mimeType === "application/json") ext = ".json";
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const baseName = filename ? path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9._-]/g, "_") : "clip";
    const safeName = `${baseName}-${ts}${ext}`;
    const filePath = path.join(saveDir, safeName);

    try {
      if (contentBase64) {
        const buf = Buffer.from(contentBase64 as string, "base64");
        if (buf.length > MAX_UPLOAD_BYTES) throw new HttpError(400, "Content too large (>50MB)");
        await fs.promises.writeFile(filePath, buf);
        return { ok: true, path: filePath, name: safeName, size: buf.length };
      }
      const text = content as string;
      if (text.length > MAX_UPLOAD_BYTES) throw new HttpError(400, "Content too large (>50MB)");
      await fs.promises.writeFile(filePath, text, "utf8");
      return { ok: true, path: filePath, name: safeName, size: Buffer.byteLength(text, "utf8") };
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, e.message);
    }
  }
}
