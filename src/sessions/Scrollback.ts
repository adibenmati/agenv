export const MAX_SCROLLBACK = 100 * 1024;

// Reset sequence prepended after truncation to neutralize any partial ANSI state:
// \x1b[0m = reset attributes, \x1b[?25h = show cursor
const RESET = Buffer.from("\x1b[0m\x1b[?25h");
// Cap the stored bytes so buffer + reset prefix still fits in MAX_SCROLLBACK.
const CAP = MAX_SCROLLBACK - RESET.length;

/**
 * A byte ring of recent terminal output. It keeps the pty chunks as they arrive and only tracks a running byte
 * count, so appending is O(chunk) and dropping from the front is a subarray view, not a copy. Nothing is
 * concatenated until something reads it. (An earlier version rebuilt one Buffer per chunk and copied ~100 KB each
 * time — gigabytes of memcpy for a few MB of output, whether or not anyone was watching.)
 */
export class Scrollback {
  private chunks: Buffer[] = [];
  private total = 0;
  private truncated = false;
  private aligned = true;
  /** True when there is output that has not been saved yet. */
  dirty = false;

  constructor(initial?: Buffer) {
    if (initial && initial.length) { this.chunks.push(initial); this.total = initial.length; }
  }

  get bytes(): number { return this.total; }

  append(data: string | Buffer): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.total += buf.length;
    this.dirty = true;

    while (this.total > CAP) {
      const head = this.chunks[0];
      const excess = this.total - CAP;
      if (head.length <= excess) { this.chunks.shift(); this.total -= head.length; }
      else { this.chunks[0] = head.subarray(excess); this.total -= excess; }
      this.truncated = true;
      this.aligned = false;
    }
  }

  /**
   * Materializes the ring. Collapses the chunk list, and — only after a truncation — realigns the head to a
   * character/line boundary so a cut escape sequence can't bleed into the client.
   */
  read(): Buffer {
    if (this.total === 0) return Buffer.alloc(0);
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    let buf = this.chunks[0];

    if (!this.aligned) {
      let start = 0;
      // Skip any UTF-8 continuation bytes (10xxxxxx) so we don't start mid-character
      while (start < buf.length && (buf[start] & 0xC0) === 0x80) start++;
      // Try to find a newline within 2KB for a clean line boundary
      const searchEnd = Math.min(start + 2048, buf.length);
      for (let i = start; i < searchEnd; i++) {
        if (buf[i] === 0x0A) { start = i + 1; break; }
      }
      if (start > 0) { buf = buf.subarray(start); this.chunks = [buf]; this.total = buf.length; }
      this.aligned = true;
    }

    return this.truncated ? Buffer.concat([RESET, buf]) : buf;
  }
}
