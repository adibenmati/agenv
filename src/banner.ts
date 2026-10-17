export interface BannerOptions {
  version: string;
  accessUrl: string;
  /** Set for `agenv run <command>`; replaces the sessions/shell lines. */
  runCommand?: string;
  sessions: number;
  /** True when the sessions came from the previous run's saved state. */
  restored: boolean;
  shell: string;
  showQr: boolean;
  /** The qrcode-terminal module, when installed. */
  qr?: { generate(text: string, opts: { small?: boolean }, cb: (qr: string) => void): void };
}

/** The box printed at startup with the URL to open. */
export function printBanner(o: BannerOptions, log: (line: string) => void = console.log): void {
  // Compute width based on longest content line
  const urlLine = `URL:      ${o.accessUrl}`;
  const cmdLine = o.runCommand ? `Command:  ${o.runCommand}` : "";
  const contentWidth = Math.max(urlLine.length, cmdLine.length, 40) + 4;
  const w = Math.min(Math.max(contentWidth, process.stdout.columns || 60), 100);
  const line = "─".repeat(w);
  // "│ " + text + padding + "│" is w + 2 wide, the same as "┌" + line + "┐"
  const pad = (s: string): string => "│ " + s + " ".repeat(Math.max(0, w - 1 - s.length)) + "│";

  log("");
  log(`┌${line}┐`);
  log(pad(`Agenv v${o.version}`));
  log(`├${line}┤`);
  if (o.runCommand) {
    log(pad(`Command:  ${o.runCommand}`));
    log(pad(`Folder:   ${process.cwd()}`));
  } else {
    log(pad(`Sessions: ${o.sessions} (${o.restored ? "restored" : "new"})`));
    log(pad(`Shell:    ${o.shell}`));
  }
  log(pad(urlLine));
  log(pad(""));
  log(pad("Scan QR or open URL on any device."));
  log(pad("Tip: ngrok tunneling is supported in web mode (--web)."));
  log(pad("Press Ctrl+C twice to exit."));
  log(`└${line}┘`);

  // QR code
  if (o.showQr && o.qr) {
    log("");
    o.qr.generate(o.accessUrl, { small: true }, (qr) => { if (qr) log(qr); });
  }
}
