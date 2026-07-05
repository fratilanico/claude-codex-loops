---
name: pingpong-install
description: >
  Install the claude-codex-loops pack into the current git repo, or run the
  preflight check with the `check` argument. The check shells to the pack
  doctor (bin/doctor.mjs), which reports PASS/FAIL for the CLIs and state the
  pack needs — git, the gh/claude/codex logins, node, a writable state dir,
  merged hooks, no duplicate scheduler label — and warns if a provider API key
  is set (the pack neither needs nor accepts one). If the doctor is not yet
  installed the check reports that gracefully and never throws. The pack ships
  for macOS/launchd in v0.1.0; the installer refuses other platforms with a
  clear message. Trigger: /pingpong-install.
---

# /pingpong-install [check] — install or preflight the pack

`/pingpong-install` is the entry surface for setting the pack up in a repo. It
shells to the pack's own scripts; it adds no logic of its own.

## Modes

```
/pingpong-install         # run the installer (install.sh) for this repo
/pingpong-install check   # preflight only — shell to the doctor, change nothing
```

### check

`check` shells to `node bin/doctor.mjs` and prints its PASS/FAIL preflight:

- `git`, and that you are inside a git repo;
- the `gh`, `claude`, and `codex` CLIs available and logged in under their own
  accounts;
- node at the required minimum;
- a parseable peer session so the watcher has something to read;
- the hook fragments merged into the Claude/Codex settings;
- a writable state dir;
- no duplicate loaded scheduler label across clones of the same repo;
- a WARNING if a provider API key env var is set — the pack drives CLIs under
  their own logins and neither needs nor accepts provider keys.

The doctor is built in a later wave. Until it exists, `check` reports
`doctor not yet installed` and exits cleanly — it never throws.

### install (default)

Runs `install.sh`, which is macOS/launchd-only for v0.1.0 and refuses to run on
other platforms with a clear message (Linux/cron is a later version). The
installer is idempotent, never clobbers your config or foreign hook entries, and
is reversible via `uninstall.sh`.

## Safety

No provider API keys are used or accepted. Every action is a bounded,
build-time step; nothing installs a resident daemon — scheduling is handed to
the OS scheduler with an interval floor.
