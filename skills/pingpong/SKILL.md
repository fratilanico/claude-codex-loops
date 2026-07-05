---
name: pingpong
description: >
  Run ONE bounded ping-pong review round with the Codex peer. Pull the peer's
  latest findings, verify each against the real code, fix what is real
  TDD-first (delegating the maker/checker legs to the dev-wave workflow), then
  push a redacted acknowledgement plus a fresh review-request packet and print
  the exit state. Exactly one round per session (turnBudgetThisSession = 1);
  raising the budget requires an explicit --turns. All brakes are inherited
  from the pack state machine — a terminal thread is a no-op that reports its
  reason. Trigger: /pingpong.
---

# /pingpong — one bounded ping-pong round

`/pingpong` advances a single review thread by exactly ONE round and stops. It
is a build-time control surface over the pack's bounded state machine, not a
runtime loop: the skill script shells to `node bin/*.mjs`, each of which is a
single bounded tick that always exits, and the skill itself takes one round per
session.

## The round (what one invocation does)

1. **Pull** the peer's latest findings for this thread from its review channel
   (the Codex peer follows the AGENTS review contract and emits `CCL-FINDING` /
   `CCL-EXIT` markers; the watcher extracts them under the state dir).
2. **Verify** each finding against the real code — a finding that does not
   reproduce against the current tree is dropped, not fixed.
3. **Fix TDD-first**, delegating the maker/checker legs to the `dev-wave`
   workflow (TDD-red → implement → verify → adversarial review). The session
   owns commits; the workflow never commits.
4. **Push** a redacted acknowledgement plus a fresh review-request packet back
   to the peer (every packet line passes through the runtime output filter).
5. **Print the exit state** for the thread: an active phase if the round handed
   off, or a terminal reason (`converged`, `quiet`, `max-rounds`,
   `no-progress`, `stale`, `blocked-needs-human`, `disabled`).

## Turn budget

`turnBudgetThisSession = 1`. One round, then stop and report. To take more than
one round in a session you must pass `--turns <n>` explicitly — the default
never escalates on its own. The round cap and freshness/no-progress brakes are
inherited from the state machine; a thread that has already EXITed is a no-op
that reports its terminal reason.

## Usage

```
/pingpong round   [--thread <id>] [--turns <n>]   # advance one round (default)
/pingpong status  [--thread <id>]                 # print thread state, touch nothing
/pingpong pull    [--thread <id>]                 # extract peer findings only
/pingpong push    [--thread <id>]                 # push ack + review-request only
```

The script (`pingpong.mjs`) is a thin wrapper: it shells to `node bin/loop.mjs`
for `status`, `node bin/watch-codex.mjs` for `pull`, and `node bin/loop-tick.mjs`
for the `round`/`push` work. It adds no loop logic of its own.

## Safety

- One round per session; the kill switch (`CCL_DISABLED=1` or the `DISABLED`
  file under the state dir) halts every path first.
- Every human-facing packet/trace line is redacted at runtime.
- No provider API keys are used or accepted — the pack drives the `claude`,
  `codex`, and `gh` CLIs under their own logins.
