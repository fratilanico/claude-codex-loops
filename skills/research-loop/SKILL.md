---
name: research-loop
description: >
  Run a bounded, self-paced RESEARCH loop that compounds only VERIFIED, cited
  findings. Each round you do one research pass with YOUR OWN session tools
  (WebSearch / fetch / read — never a provider API), then verify every claim
  against a real source: a claim with a source is appended to a per-topic
  findings ledger (deduped by fingerprint); a claim with NO source is DROPPED
  and logged. Adversarial verification is built in — unsourced claims never
  reach the ledger. The loop is bounded: it exits on a QUIET round (no new
  verified findings) or on maxRounds, and the kill switch halts it first. This
  is BUILD-TIME only, a self-paced session loop that always exits, never a
  daemon. The helper manages state and the ledger under <stateDir>/research/;
  it spawns no models — YOU do the searching and verifying. Trigger:
  /research-loop.
---

# /research-loop — bounded, cite-or-drop research loop

`/research-loop` is the RESEARCH flavor of the pack's general bounded loop
(`/ccl-loop`). It is built for the cofounder's main use — research — and it
enforces one rule above all: **only sourced, verifiable findings survive.** An
unsourced claim is not knowledge; it is dropped and logged.

It is NOT a daemon. Each command is one bounded tick that always exits. The
helper (`research-loop.mjs`) keeps a per-topic state file and a markdown
findings ledger; it spawns no model and hits no provider API. **You** run each
research pass with your own session tools and verify each claim.

## The research round

    trigger → research pass (your tools) → verify each claim vs a real source
            → record cited findings (dedup) / drop unsourced → close round → exit-on-quiet

Per round:

1. **Research pass.** Use your session tools (WebSearch, fetch, file reads) to
   gather claims about the topic. Do the actual searching — the helper does not.
2. **Verify (cite-or-drop).** For each claim, find a real source (a URL, a doc,
   a file+line). A claim you cannot source is a guess.
3. **Record.** For each VERIFIED claim:
   `research record <topic> --finding "<claim>" --source "<url>"`. The helper
   appends it to the ledger, deduped by fingerprint (the same triage-format
   fingerprint the pack uses), so a claim is never written twice. A `record`
   with no `--source` is DROPPED and written to the drop log.
4. **Close the round.** `research round <topic>`. If the round added zero NEW
   verified findings, the loop EXITs `{quiet}` — the topic is exhausted for now.
   Otherwise it advances a turn; reaching `maxRounds` EXITs `{max-rounds}`.

## Brakes (inherited from the pack state machine)

- **quiet** — a round with no new verified findings exits cleanly. This is the
  normal way a research loop ends: you stop finding new sourced facts.
- **maxRounds** — hard cap on rounds (config `pingpong.maxRounds`, clamp 1..20;
  override with `--max-rounds <n>`).
- **drop-on-unsourced** — the built-in adversarial gate; unsourced claims are
  logged to `<stateDir>/research/<topic>.dropped.log`, never appended.
- **kill switch** — `CCL_DISABLED=1` or `<stateDir>/DISABLED` halts new work
  first. A terminal is sticky; `stop <topic>` forces `EXIT{disabled}`.

## Usage

```
/research-loop start  <topic> [--max-rounds <n>]                        # begin
/research-loop record <topic> --finding "<claim>" --source "<url>" [--path <k>]
/research-loop round  <topic>                                          # close a round; exit on quiet
/research-loop status <topic>                                          # state + finding count
/research-loop stop   <topic>                                          # force EXIT{disabled}
```

State: `<stateDir>/research/<topic>.state.json`. Findings ledger (the durable
output): `<stateDir>/research/<topic>.md`. Dropped claims:
`<stateDir>/research/<topic>.dropped.log`. The helper reuses the pack's pure
`pingpong-state` (round/brakes/sticky-exit) and `ledger` (fingerprint dedupe).

## Safety

- Bounded and build-time: exits on quiet or maxRounds; a terminal is sticky. It
  is a self-paced session loop, never an always-on process.
- Cite-or-drop is enforced in code — the ledger cannot hold an unsourced claim.
- No provider API keys are used or accepted. You research with your own session
  tools; the helper is pure local bookkeeping over the CLIs' own logins.
