import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Flags that take a value / that don't — used to pull the command out of `agenv run <command...>`. */
const FLAGS_WITH_VALUE = new Set(["--port", "--host", "--shell", "--token", "--sessions", "--max-sessions", "--name"]);
const FLAGS_NO_VALUE = new Set(["--open", "--qr", "--no-qr"]);

/** Command-line flags, environment and the persisted ~/.agenvrc.json, resolved once at startup. */
export class Config {
  readonly command: string | undefined;
  readonly port: number;
  host: string;
  readonly shell: string;
  token: string;
  readonly initialSessions: number;
  readonly maxSessions: number;
  readonly autoOpen: boolean;
  readonly showQr: boolean;
  /** Echo session 0 into the launching terminal (off by default). */
  readonly mirror: boolean;
  readonly runCommand: string;
  readonly runName: string;
  readonly configPath: string;
  readonly args: string[];

  private constructor(argv: string[], env: NodeJS.ProcessEnv, homedir: string, platform: NodeJS.Platform) {
    this.args = argv;
    this.command = argv[0];
    this.configPath = path.join(homedir, ".agenvrc.json");

    const flag = (name: string, fallback: string): string => {
      const i = argv.indexOf(name);
      return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
    };
    const hasFlag = (name: string): boolean => argv.includes(name);

    this.port = parseInt(flag("--port", env.PORT || "7681"), 10);
    this.host = flag("--host", env.HOST || "127.0.0.1");
    // Electron safety: force localhost binding
    if (env.ELECTRON === "1" && this.host !== "127.0.0.1" && this.host !== "localhost") {
      console.warn(`[agenv] Electron mode: overriding HOST ${this.host} → 127.0.0.1 for security`);
      this.host = "127.0.0.1";
    }
    this.shell = flag("--shell", platform === "win32" ? "cmd.exe" : env.SHELL || "bash");
    this.token = flag("--token", (this.read().token as string | undefined) || crypto.randomBytes(16).toString("hex"));
    this.initialSessions = Math.max(1, parseInt(flag("--sessions", "1"), 10));
    this.maxSessions = Math.max(1, parseInt(flag("--max-sessions", "20"), 10));
    this.autoOpen = hasFlag("--open");
    this.showQr = !hasFlag("--no-qr");
    this.mirror = hasFlag("--mirror");

    let runCommand = "";
    if (this.command === "run") {
      const parts: string[] = [];
      let skipNext = false;
      for (const a of argv.slice(1)) {
        if (skipNext) { skipNext = false; continue; }
        if (FLAGS_WITH_VALUE.has(a)) { skipNext = true; continue; }
        if (FLAGS_NO_VALUE.has(a)) continue;
        parts.push(a);
      }
      runCommand = parts.join(" ");
    }
    this.runCommand = runCommand;
    this.runName = flag("--name", "");
  }

  static fromArgv(argv: string[], env: NodeJS.ProcessEnv, homedir: string, platform: NodeJS.Platform = process.platform): Config {
    return new Config(argv, env, homedir, platform);
  }

  private read(): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(this.configPath, "utf8")); } catch { return {}; }
  }

  /** Dotted keys ("auth.password") into ~/.agenvrc.json. */
  get(key: string): unknown {
    let obj: any = this.read();
    for (const p of key.split(".")) {
      if (obj == null || typeof obj !== "object") return undefined;
      obj = obj[p];
    }
    return obj;
  }

  set(key: string, value: unknown): void {
    const config = this.read();
    const parts = key.split(".");
    let obj: any = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== "object") obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
  }
}
