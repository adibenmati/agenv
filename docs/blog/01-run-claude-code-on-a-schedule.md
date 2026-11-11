# Run Claude Code on a schedule, without babysitting it

*Agenv 1.7 added Routines. This is how to use them without waking up to a surprise bill.*

Most of what people do with Claude Code is interactive: you type, it works, you review. But a lot of useful work is boring and repeats: triage a folder of notes every morning, summarise yesterday's commits, check a report and write down what changed. You don't want to open a terminal for that. You want it to just happen.

A **routine** in Agenv is exactly that: an agent that runs on a schedule, unattended. "Every weekday at 09:00, triage my inbox folder and write a summary."

## What you set up

- **A schedule.** A normal 5-field cron expression plus a timezone (it defaults to your machine's). There are presets for hourly, daily 09:00, weekdays 09:00 and weekly Monday 09:00.
- **A target.** Either one of your agents (its folder, instructions, MCP config and model come along) or just a plain folder.
- **A conversation mode.** Continue the agent's own conversation so context builds up over weeks, fork it for every run and leave the original alone, or start fresh each time.

Nothing here talks to a service on your behalf. Agenv starts **your own `claude` CLI**, with your own login and your own MCP servers.

## The part that matters: nobody is there to answer a prompt

When a human isn't watching, permission prompts can't be answered, so you choose the mode up front:

- **Read-only** (plan mode, changes nothing)
- **Edit files** (the default)
- **Allowlist only** (just the tools you list)
- **Skip all permissions**, which is never implicit: you have to tick a box saying the agent can run any command unattended.

## Guardrails against runaway cost

Every run has a budget (default $2) and a timeout (default 20 minutes, max 120). A run that exceeds either is stopped. The budget is checked by the CLI after each turn, so a run can overshoot slightly. On top of that you can cap runs per day per routine, and set a global daily cost cap. A single **Pause all automation** switch stops everything: scheduled, catch-up and manual runs.

## What happens when your laptop was asleep?

Routines only fire while Agenv is running. If a slot arrives within about two minutes of its time (a quick restart, say) it still fires. Older slots are, by default, skipped: the routine jumps to its next future slot and leaves a visible "skipped" row saying how many it missed. If you'd rather catch up, choose *Run missed ones when back*: up to 25 missed slots are replayed, and never for schedules more frequent than hourly.

## Looking at what it did

The newest 500 runs are kept with status, duration, cost, the result summary and a live log. If a result needs a human, **Open interactively** continues that run's conversation in a normal terminal tab.

## When it's worth it

Start with one read-only routine on a folder you care about, run it manually twice, and read the log. Once you trust the output, switch it to Edit files and let the schedule take over.

```bash
npm install -g @adibenmatdev/agenv
agenv
```

Open the Routines panel in the sidebar and create your first one.
