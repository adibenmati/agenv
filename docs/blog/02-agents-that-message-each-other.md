# Let your coding agents message each other

*A reviewer agent, a builder agent and you, in one workspace. Agenv's `agenv send` makes them talk.*

Once you run more than one agent at a time, you become the message bus. The builder finishes, you copy the diff to the reviewer, the reviewer complains, you copy that back. It works, but you're doing a job a script could do.

Agenv sessions can now message each other by name, whatever CLI runs inside them: Claude, Codex, Gemini, Aider.

## How it works

Every session's shell gets three environment variables: `AGENV_URL`, `AGENV_SESSION_ID` and a private `AGENV_SESSION_TOKEN`. An agent just runs a command:

```
agenv sessions                    # who else is open (id, name, tool, idle/busy)
agenv send reviewer "please check the diff in src/api"
```

The text is typed into the target's terminal as if you had typed it, together with a note of who sent it and how to answer (`agenv send <sender> "..."`). So the reviewer replies the same way, and the conversation closes without you in the middle.

## The safety details

- If the target is busy printing, the message waits until the terminal has been quiet for a moment (up to 5 minutes, then it fails).
- A closed session, or one with no agent CLI running, is refused with a clear error. A plain shell would execute your text as a command, so Agenv won't deliver into one.
- At most 30 messages per 10 minutes from one session to another, which breaks loops where two agents politely thank each other forever.
- Session tokens only work on the messaging routes. Messages are not stored on disk.

## You can join in

The **Messages** panel (the envelope button) shows the log and lets you message any session yourself.

## Running one command in many sessions

The same panel can **run a command in many sessions at once**. Pick all sessions or a session group (subgroups included), type something like `/remote-control`, and Agenv types it into each open terminal and presses Enter. You can limit it to sessions that are running an agent CLI. Only the logged-in UI can do this; a session's own token cannot.

## Getting agents to use it

Tell them in `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, or simply say "use `agenv send`". A good first setup is two sessions: one that writes code, one named `reviewer`, with a line in the builder's instructions to send the reviewer a summary of every finished change.
