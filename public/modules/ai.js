// ai.js — AI assistant bridge
// Calls the user's configured agent CLI (claude, gemini, etc.) in one-shot mode
// via the server's /api/ai/ask endpoint. No extra API keys needed.

import { api } from "./util.js";

/**
 * Ask the AI assistant a question. Uses the user's configured CLI agent.
 * @param {string} prompt - The prompt to send
 * @param {object} opts - Options: { cwd, timeout, onStart, onDone }
 * @returns {Promise<{response:string, elapsed:number}|{error:string}>}
 */
export async function ask(prompt, opts = {}) {
  const agent = localStorage.getItem("tl-defaultAgent") || "claude";
  const model = localStorage.getItem("tl-aiModel") || "sonnet";
  const timeout = opts.timeout || 90000;
  const cwd = opts.cwd || undefined;

  if (opts.onStart) opts.onStart();

  try {
    const resp = await fetch(api("/api/ai/ask"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, agent, model, cwd, timeout }),
    });
    const data = await resp.json();
    if (opts.onDone) opts.onDone(data);

    if (!resp.ok) return { error: data.error || "AI request failed", elapsed: data.elapsed || 0 };
    return data;
  } catch (e) {
    const err = { error: e.message || "Network error", elapsed: 0 };
    if (opts.onDone) opts.onDone(err);
    return err;
  }
}

/**
 * Get the current AI model name for display.
 */
export function getModelName() {
  return localStorage.getItem("tl-aiModel") || "sonnet";
}

/**
 * Get the current agent CLI name.
 */
export function getAgentName() {
  return localStorage.getItem("tl-defaultAgent") || "claude";
}
