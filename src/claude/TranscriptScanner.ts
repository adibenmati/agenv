import * as fs from "fs";
import * as path from "path";

/** Return "stop" to end the scan early. */
export type EntryHandler = (entry: any) => void | "stop";

/**
 * Reads Claude Code transcripts (~/.claude/projects/**\/*.jsonl). They run to tens of MB, so they are streamed in
 * chunks and never read whole.
 */
export class TranscriptScanner {
  constructor(private readonly projectsDir: string) {}

  /**
   * Streams JSON lines from byte `start` and resolves to the offset just past the last line consumed — scan again
   * from there to read only what was appended. A final line with no newline is consumed only if it is complete
   * JSON (otherwise it is probably still being written). Blank and malformed lines are skipped.
   */
  async scan(filePath: string, start: number, onEntry: EntryHandler): Promise<number> {
    let offset = start;
    let carry: Buffer | null = null;
    const stream = fs.createReadStream(filePath, { start, highWaterMark: 1 << 20 });
    for await (const raw of stream) {
      let chunk = raw as Buffer;
      if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
      let pos = 0, nl: number;
      while ((nl = chunk.indexOf(0x0A, pos)) !== -1) {
        const stop = this.feed(chunk.toString("utf8", pos, nl), onEntry);
        pos = nl + 1;
        if (stop === "stop") return offset + pos;   // leaving the loop destroys the stream
      }
      offset += pos;
      if (pos < chunk.length) carry = chunk.subarray(pos);
    }
    if (carry) {
      try {
        const e = JSON.parse(carry.toString("utf8"));
        offset += carry.length;
        onEntry(e);
      } catch {}
    }
    return offset;
  }

  private feed(line: string, onEntry: EntryHandler): void | "stop" {
    if (!line.trim()) return;
    let e: unknown;
    try { e = JSON.parse(line); } catch { return; }
    return onEntry(e) === "stop" ? "stop" : undefined;
  }

  /** Every transcript under the projects folder, up to five levels deep. */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.name.endsWith(".jsonl")) out.push(full);
      }
    };
    await walk(this.projectsDir, 0);
    return out;
  }

  /** The first line of a file, without reading the rest (up to 8 MiB). */
  firstLine(filePath: string): string {
    const fd = fs.openSync(filePath, "r");
    try {
      const chunks: Buffer[] = [];
      const buf = Buffer.alloc(64 * 1024);
      for (let total = 0; total < 8 * 1024 * 1024;) {
        const n = fs.readSync(fd, buf, 0, buf.length, total);
        if (n === 0) break;
        const nl = buf.subarray(0, n).indexOf(0x0A);
        if (nl !== -1) { chunks.push(Buffer.from(buf.subarray(0, nl))); break; }
        chunks.push(Buffer.from(buf.subarray(0, n)));
        total += n;
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { fs.closeSync(fd); }
  }
}
