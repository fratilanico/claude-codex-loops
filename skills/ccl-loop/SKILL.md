---
name: ccl-loop
description: >
  Drive ANY multi-iteration task — build, refactor, migration, or research —
  as a bounded, self-paced orchestration loop. Each iteration you do a unit of
  work (the maker), run an INDEPENDENT checker, record the outcome to a named
  loop's disk state, then let the pack's bounded state machine decide whether to
  continue or exit. Brakes are inherited: a round cap (maxRounds), a
  no-progress brake, and the kill switch all force a sticky terminal so the loop
  cannot spin. This is BUILD-TIME only — a self-paced session loop that always
  exits, never a runtime daemon. The helper manages state under
  <stateDir>/loops/<name>.json and prints the next step; it spawns no models —
  YOU are the maker and checker. Trigger: /ccl-loop.
---

# /ccl-loop — general bounded orchestration loop

`/ccl-loop` is the pack's GENERAL continuous-orchestration driver. It turns any
multi-step task into an explicit, bounded loop with an independent checker and
hard brakes. It is the same self-pacing machinery the pack uses for ping-pong
review, exposed generically for build / refactor / migration / research work.

It is NOT a daemon. There is no schedule, no re-arm, no background process. Each
command is one bounded tick that always exits. The helper (`loop.mjs`) only
keeps a named loop's disk state and tells you the next step — it spawns no
model. **You** are the maker and the checker; the loop keeps you honest and
bounded.

## The loop contract

    trigger → maker → independent checker → record state → decide → trace → (exit)

Per iteration, in order:

1. **Maker.** Do exactly one unit of work toward the goal (write the code, run
   the migration step, gather the next research batch — whatever this loop is
   for). Keep it small enough that a checker can judge it.
2. **Checker (independent).** Run the loop's checker — a command or review that
   did NOT do the work and can fail: tests, a type-check, a diff review, a
   source-verification pass. The checker must be able to say "no".
3. **Record state.** Report the outcome to the helper with
   `loop step <name> <outcome>`. This advances the bounded state machine and
   appends a trace line.
4. **Decide.** Read the printed next-step line. If the loop is still `active`,
   continue with another iteration. If it EXITed, stop.

## Brakes (inherited from the pack state machine)

- **maxRounds** — a full iteration cycle count; reaching it EXITs `{max-rounds}`.
  Default from config (`pingpong.maxRounds`, clamp 1..20); override per loop with
  `--max-rounds <n>`.
- **no-progress** — report `no-change` when the checker sees nothing new; the
  machine routes toward `blocked-needs-human`. Do not keep re-running a checker
  that never moves.
- **needs-human** — report `blocked` to escalate. A brake terminal is STICKY:
  every later `step` is a no-op that reprints the reason. Do NOT re-arm it.
- **kill switch** — `CCL_DISABLED=1` or the `<stateDir>/DISABLED` file halts
  `start`/`step` first, on every command.

## Usage

```
/ccl-loop start  <name> [--max-rounds <n>] [--detail <text>]   # begin a named loop
/ccl-loop step   <name> [outcome] [--detail <text>]            # record one iteration + advance
/ccl-loop status <name>                                        # print state; touch nothing
/ccl-loop stop   <name>                                        # force EXIT{disabled} (kill this loop)
```

`outcome` ∈ `progress` (default) | `no-change` | `converged` | `quiet` |
`blocked`.

- `progress` — the checker passed and there is more to do → advance a turn.
- `converged` — the checker is satisfied and the goal is met → clean exit.
- `quiet` — nothing to do this iteration → clean exit.
- `no-change` — the checker saw no movement → no-progress brake.
- `blocked` — escalate to a human.

The script (`loop.mjs`) shells to nothing and calls no model; it reuses the
pack's pure `pingpong-state` (round/brakes/sticky-exit), `ledger` (trace), and
`loop-config` (state dir + governors). State lives at
`<stateDir>/loops/<name>.json`; the trace at `<stateDir>/loops/<name>.trace.jsonl`.

## Safety

- Build-time and bounded: the loop ALWAYS exits (a terminal is sticky). It is a
  self-paced session loop, never an always-on daemon.
- The kill switch halts new work first on every path.
- No provider API keys are used or accepted — the pack drives the `claude`,
  `codex`, and `gh` CLIs under their own logins, and this helper drives none of
  them: it is pure local bookkeeping.
