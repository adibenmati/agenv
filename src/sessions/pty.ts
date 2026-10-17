/** The slice of a pseudo-terminal that agenv uses. Only `src/index.ts` knows about the real node-pty. */
export interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (o: {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => IPty;
