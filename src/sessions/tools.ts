// Tool detection — identify what's running in a session from the command that started it, or from what it printed.
const TOOL_PATTERNS: Array<{ re: RegExp; tool: string }> = [
  { re: /^claude\b/i, tool: "claude" },
  { re: /^codex\b/i, tool: "codex" },
  { re: /^gemini\b/i, tool: "gemini" },
  { re: /^(aider|opencode|qwen|amp|cursor-agent)\b/i, tool: "agent-cli" },
  { re: /^vertex\b/i, tool: "vertex" },
  { re: /^gcloud\s+ai\b/i, tool: "vertex" },
  { re: /^gcloud\b/i, tool: "gcloud" },
  { re: /^aws\b/i, tool: "aws" },
  { re: /^az\b/i, tool: "azure" },
  { re: /^ssh\b/i, tool: "ssh" },
  { re: /^docker\b/i, tool: "docker" },
  { re: /^kubectl\b/i, tool: "k8s" },
  { re: /^python3?\b/i, tool: "python" },
  { re: /^node\b/i, tool: "node" },
  { re: /^npm\b/i, tool: "npm" },
  { re: /^git\b/i, tool: "git" },
];

/**
 * The command that actually starts the program: the last step of `a && b`, without leading VAR=value assignments,
 * without a runner such as npx / pnpm dlx / bunx / npm exec, with its folder and .exe/.cmd/.ps1 extension removed
 * and a scoped package name reduced to its last part (`npx @openai/codex` is codex).
 */
function programOf(command: string): string {
  let c = command.trim();
  const steps = c.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (steps.length) c = steps[steps.length - 1];
  c = c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  c = c.replace(/^(?:npx|pnpx|bunx)\s+(?:-[-\w]+(?:=\S+)?\s+)*/i, "")
    .replace(/^(?:pnpm\s+dlx|npm\s+exec|yarn\s+dlx|bun\s+x)\s+(?:-[-\w]+(?:=\S+)?\s+)*/i, "");
  const m = /^(?:"([^"]+)"|(\S+))(.*)$/.exec(c);
  if (!m) return c;
  let exe = (m[1] || m[2]).replace(/\\/g, "/");
  exe = exe.slice(exe.lastIndexOf("/") + 1).replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return exe + m[3];
}

export function detectTool(command: string): string | null {
  const trimmed = programOf(command);
  for (const p of TOOL_PATTERNS) if (p.re.test(trimmed)) return p.tool;
  return null;
}

/**
 * Agent CLIs announce themselves when they start. Recognising the banner finds a CLI that was started some way the
 * typed command did not show (recalled from history, a shell alias, a wrapper script). Specific phrases only: a
 * word like "Gemini" alone appears in ordinary text.
 */
const BANNERS: Array<{ re: RegExp; tool: string }> = [
  { re: />_ OpenAI Codex|OpenAI Codex \(v/, tool: "codex" },
  { re: /Claude Code v\d|Welcome to Claude Code/, tool: "claude" },
  { re: /Gemini CLI|Tips for getting started:/, tool: "gemini" },
  { re: /\bAider v\d/, tool: "agent-cli" },
  { re: /\bopencode v?\d/i, tool: "agent-cli" },
];

export function detectToolFromOutput(plainText: string): string | null {
  for (const b of BANNERS) if (b.re.test(plainText)) return b.tool;
  return null;
}
