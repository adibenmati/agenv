// `agenv sessions` and `agenv send`: how an agent CLI running inside an agenv session talks to its peers. The session's
// environment carries AGENV_URL and AGENV_SESSION_TOKEN (set when its shell starts).

const HELP = `
  Usage (inside an agenv session):
    agenv sessions                       List the sessions you can message
    agenv send <name> <message...>       Send a message to another session (its name or id)
`;

interface Peer { id: number; name: string; tool: string; state: string; live: boolean }

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = process.env.AGENV_URL;
  const token = process.env.AGENV_SESSION_TOKEN;
  if (!url || !token) throw new Error("This is not an agenv session (AGENV_URL / AGENV_SESSION_TOKEN are not set). Open the session from the agenv app, or restart its shell.");
  let res: Response;
  try {
    res = await fetch(url + path, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Cannot reach agenv at " + url + ". Is it still running?");
  }
  let data: any = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

/** Returns the exit code when `command` is one of ours, or null so the caller carries on. */
export async function runMessagingCommand(command: string | undefined, args: string[]): Promise<number | null> {
  if (command !== "sessions" && command !== "send") return null;
  try {
    if (command === "sessions") {
      const { status, data } = await call("GET", "/api/messages/peers");
      if (status !== 200) { console.error("[agenv] " + ((data && data.error) || "HTTP " + status)); return 1; }
      const self = process.env.AGENV_SESSION_ID;
      const peers = (data as Peer[]).filter((p) => String(p.id) !== self);
      if (peers.length === 0) { console.log("No other sessions are open."); return 0; }
      for (const p of peers) {
        console.log(`${String(p.id).padEnd(4)} ${(p.name || "(unnamed)").padEnd(24)} ${p.tool.padEnd(10)} ${p.live ? p.state : "closed"}`);
      }
      return 0;
    }
    const to = args[1];
    const text = args.slice(2).join(" ");
    if (!to || !text) { console.error(HELP); return 1; }
    const { status, data } = await call("POST", "/api/messages", { to, text });
    if (status !== 200) { console.error("[agenv] " + ((data && data.error) || "HTTP " + status)); return 1; }
    console.log(data.status === "delivered" ? `Sent to ${data.to}.` : `Queued for ${data.to}; it is busy and will get it as soon as it is idle.`);
    return 0;
  } catch (e) {
    console.error("[agenv] " + (e as Error).message);
    return 1;
  }
}
