# PR-REVIEW-LOOP — bounded bot-review triage for every PR

Standing rule: after **every push** to an open PR and after **every merge**,
sweep the review bots (e.g. CodeRabbit + Codex, across all `gh` surfaces: inline
comments, reviews, and issue comments), verify each finding against real code,
fix what is valid, decline with recorded evidence what is not, and re-sweep until
a round comes back quiet. Bots find bugs **in** the fixes, so one pass is never
enough — the loop keeps going, bounded, until it converges or escalates.

## The runner

`workflows/pr-review-triage.js` — a Claude Code **Workflow** (it uses the harness
globals `agent()` / `parallel()` / `phase()`; it is not run under bare `node` or
`npm test`). Invoke it as a workflow with `{ pr: <N> }`, or with no `pr` to sweep
all open PRs. The `/pingpong-pr [N]` skill is a thin entry surface over it.

Loop spine: **trigger** (push/merge/scheduled tick) -> **collect** (a cheap agent
reads all comment surfaces and dedupes) -> **maker** (one agent per finding:
verify -> TDD fix or decline-with-evidence) -> **independent checker** (a separate
adversarial re-gate over the uncommitted diff) -> **disk state**
(`<ledgerDir>/pr-<N>-triage.json` fingerprint ledger — dedupe survives session
death) -> **explicit exit** (quiet round, or a fix-required blocker) -> **trace**
(workflow journal + ledger entries).

Model routing is deliberate and config-driven: a capable model on per-finding
work, a strong model only on the final re-gate, and the **invoking session
commits** — makers never commit (committer/maker separation). The model labels
come from config / env (`CCL_VERIFY_MODEL`, `CCL_REGATE_MODEL`); they are labels
passed to the `claude` CLI, never keys.

## Triggers

- After any push to an open PR, and after any merge (post-merge sweep).
- A scheduled safety-net tick when idle (owned by the OS scheduler, not the
  workflow — the workflow never self-schedules).
- Manually: paste bot findings into the same runner and the same ledger.

## Ledger format (`<ledgerDir>/pr-<N>-triage.json`)

```json
{ "pr": 164, "entries": [
  { "fingerprint": "inline|path|first-120-chars", "verdict": "fixed",
    "evidence": "file:line reasoning or commit", "files": ["..."], "date": "2026-07-03" }
] }
```

A finding whose fingerprint is already in the ledger is never re-worked. Declines
are first-class records — **a decline without evidence is not a decline.**

## Brakes, verdicts, and grounding

- **Verdict vocabulary:** `fixed` · `declined` · `needs-human` · `needs-worktree`.
  A verdict without `file:line` evidence the agent actually read is invalid;
  unverifiable claims escalate to `needs-human` with an explicit uncertainty
  statement — never a guess.
- **Evaluator-first:** `fixed` is only legal with a runnable test command + a
  tally. Model review (the adversarial re-gate) is advisory; deterministic tests
  are the hard gate, and the invoking session re-runs them before commit.
- **2-pass brake / no-progress detection:** a fingerprint whose `fixed` entry gets
  re-flagged by the bot re-enters exactly once (`reflagged: true`); if the second
  pass isn't clearly stronger, it escalates to `needs-human` and the loop stops
  touching it. No infinite fix-reflag ping-pong.
- **Whole-sweep cap:** `triage.maxRounds` (default 3, env `CCL_TRIAGE_MAX_ROUNDS`)
  bounds the number of sweeps atop the per-fingerprint brake.
- **FLAKY is not RED:** a check that fails in parallel but passes in
  isolation/sequential is recorded as flaky, never "fixed" blindly, and never
  blocks the verdict.
- **Explicit exits:** quiet round · committed-after-gates · blocked-needs-human.
  Anything else still running is a bug in the loop, not a state.

## Configuration

The default review bots are `coderabbitai` and `chatgpt-codex-connector`
(override with `CCL_PR_BOTS`). The ledger directory is `ledgerDir` (default
`docs/reviews`). The target repo is resolved via `gh repo view`. See the pack
`README.md` for the full config/env table.
