# Managing 20 Claude sessions without losing your mind

*Folders, a model and effort for each session, resume-all, and a backup file. What changed in Agenv 1.10.*

If you work across several projects, you end up with a lot of Claude Code conversations. Ten is normal. Twenty is not unusual. Terminal tabs stop scaling around five.

## Put sessions in a tree

Agenv's Sessions panel is a folder tree. Group by client, project or purpose (`Intelis/marketing`, `CrawlerData`), drag sessions around, rename them. Each session keeps its own persistent terminal that survives browser refreshes and reconnects.

## No more 20-session ceiling

Earlier versions capped open sessions at 20. The default is now 100 (`--max-sessions` changes it), and after a restart every saved session comes back.

## A model and an effort for each session

Not every conversation needs your most expensive setting. From the ⚙ button, or the right-click menu on a session or a folder, set a model (`opus`, `sonnet`, `haiku`, or a full model name) and an effort (`low` to `max`). A small badge on the session shows what it uses.

One thing to know: Agenv applies these when it starts or resumes that session's Claude, meaning Resume all, Continue, and reopening from "Recently closed". A Claude that is already running keeps what it has, because changing a running session's model would also change your global default.

## Wake everything up

After a reboot, **Resume all** restarts the Claude conversation in every sleeping session, each with its own model and effort. Nothing to retype.

## A backup you can read

The ⤓ button exports your whole tree to a JSON file: sessions, folders and the recently-closed list. ⤒ imports one. Import is additive: it skips sessions you already have, keeps your existing folder colours, and never overwrites. It is a good habit before you upgrade or move machines, and it is plain JSON, so you can fix a file by hand if you need to.

*A note on trust:* version 1.10.3 fixed a bug in which updating Agenv could lose saved sessions. The backup button exists because of it.

## Terminals that behave

Recent releases also fixed terminals that kept a stale size after a panel moved, and keyboard focus that disappeared after a minimise and restore. If a pop-up in a TUI ran off the bottom of the screen before, update.
