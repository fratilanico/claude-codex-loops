---
name: pingpong-pr
description: >
  Triage the outstanding review-bot findings on a pull request through the
  bounded pr-review-triage workflow. Optionally pass a PR number; otherwise the
  workflow resolves the current PR from the branch. It collects the bot
  comments, classifies each finding evaluator-first, fixes what is real, and
  records a terminal verdict per finding in the review ledger — bounded by the
  per-fingerprint two-pass brake and the whole-sweep triage.maxRounds cap, so
  it always terminates or escalates to blocked-needs-human. Runs inside the
  Claude Code Workflow harness; it adds no new logic beyond that workflow.
  Trigger: /pingpong-pr.
---

# /pingpong-pr [N] — bounded PR review triage

`/pingpong-pr` runs the packaged `workflows/pr-review-triage.js` workflow. It is
a documentation-and-entry surface only — it introduces NO logic of its own.

## What it does

The triage workflow:

1. Resolves the target repo via `gh repo view` and the PR (either the number you
   pass as `[N]` or the current branch's PR).
2. Collects outstanding review-bot findings (default bots: `coderabbitai`,
   `chatgpt-codex-connector`; configurable via `CCL_PR_BOTS`).
3. Classifies each finding evaluator-first, fixes the real ones, and re-checks.
4. Writes a terminal verdict per finding into the review ledger under
   `ledgerDir` (default `docs/reviews/pr-*.json`).

## Bounds

Two independent brakes guarantee termination:

- a **per-fingerprint two-pass brake** — a finding that survives two fix passes
  is escalated, never retried forever;
- a **whole-sweep cap** — `triage.maxRounds` (default 3, env `CCL_TRIAGE_MAX_ROUNDS`).

When either brake fires, the affected finding lands in `blocked-needs-human`
rather than looping.

## Execution harness

This runs inside the Claude Code **Workflow harness** (the workflow uses the
harness globals `agent()` / `parallel()` / `phase()`), not under bare
`node`/`npm test`. Invoke it as a workflow, not as a standalone script.

## Usage

```
/pingpong-pr        # triage the current branch's PR
/pingpong-pr 177    # triage PR #177
```

No provider API keys are used — the workflow drives the `gh` and `claude` CLIs
under their own logins.
