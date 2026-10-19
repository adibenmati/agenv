// Tool detection — identify what's running in a session from the command that started it.
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

export function detectTool(command: string): string | null {
  const trimmed = command.trim();
  for (const p of TOOL_PATTERNS) if (p.re.test(trimmed)) return p.tool;
  return null;
}
