# Safety model

The whole point of this pack is that a review loop between two agents cannot run
away. Safety is not a feature bolted on top — it is the shape of the pack. This
document is the auditable statement of *why the loop always stops.*

## Build-time only — the foundational rule

> **Runtime autonomous loops are forbidden.** Every executable in `bin/` is a
> **single bounded tick**: it does one unit of work and exits. There is no
> resident daemon, no `setInterval`, no `while (true)`, no re-armed `setTimeout`,
> no self-scheduling. Cadence is owned entirely by the **OS scheduler** (launchd
> `StartInterval`) or a human invocation.

Because the tick is model-free (it never calls `claude`/`codex`/a provider), a
tick firing repeatedly cannot cause runaway model usage. The only place a model
runs is inside a *session*, and a session does exactly **one** bounded pass per
invocation. This is the "ticks ferry, sessions think" law, and it is what keeps
the pack inside the no-runtime-autonomous-loop rule.

## Brake table

Every way a thread can stop, and what triggers it. All brakes route to a sticky
terminal via the pure `advance()` in `core/pingpong-state.mjs`.

| Terminal | Trigger | Where enforced | Brake? |
|---|---|---|---|
| `converged` | Reviewer signals the diff is clean and agreed | `advance(state, "converged")` | clean exit |
| `quiet` | Nothing new to review this wake (empty ↔ empty) | `advance(state, "quiet")` | clean exit |
| `max-rounds` | `round` reaches `pingpong.maxRounds` on a completed codex turn | `advance()` on `turn-complete` | **yes** |
| `no-progress` | The two most recent rounds carry an identical, non-empty finding set | `detectNoProgress()` -> `brakes()` | **yes** |
| `stale` | A thread untouched for `>= pingpong.staleAfterHours` | `brakes()` (freshness, clockless — caller supplies age) | **yes** |
| `blocked-needs-human` | Explicit escalation, **or** any corrupt/unknown state | `advance()` (corrupt -> safe terminal) | **yes** |
| `disabled` | Kill switch: `<stateDir>/DISABLED` file **or** `CCL_DISABLED=1` | honored FIRST on every bin path | **yes** |

The kill switch is evaluated *before any other work* in every executable
(`loop-tick`, `watch-codex`, `loop`, doctor). It is the first and most-protective
brake.

Additional operational safety valves:

- **Single-flight lock** — `bin/loop-tick.mjs` takes an atomic
  `mkdir(<stateDir>/tick.lock)` before any work. If a slower tick still holds it,
  the new tick logs `lock-held` and exits 0. A lock older than the 15-minute TTL
  is reclaimed so a crashed tick cannot wedge the loop.
- **Subprocess timeout** — every external `git`/`gh` call carries a 60s
  `execFileSync` timeout, so a hung subprocess can never defeat "exits 0 always".
- **PR-triage brakes** — a per-fingerprint **2-pass brake** (a finding re-flagged
  after a fix re-enters exactly once, then escalates) plus a whole-sweep
  `triage.maxRounds` cap (default 3). Either firing lands the finding in
  `blocked-needs-human` rather than looping. The whole-sweep cap is
  **self-enforcing**: `pr-review-triage.js` reads the sweep-round counter from its
  ledger (`<ledgerDir>/triage-sweep.json`) at the start of each pass, increments
  and writes it back on a non-quiet sweep, and resets it to `0` on a quiet round —
  so the cap holds even if the invoking session never passes a round argument (the
  caller-supplied `sweepRound` is only a seed for a brand-new ledger).

## Invariants I1–I6

These are the properties the safety spine guarantees. Each is asserted by
`__tests__/loop-safety.test.ts` (and the state-machine / ledger tests).

- **I1 — No resident process.** No `setInterval`, `while (true)`, or re-armed
  `setTimeout` anywhere in `bin/`. Every executable terminates (well under the
  test's liveness bound). Scheduling is external only.
- **I2 — The ferry is model-free.** A **transitive** static-import walk from each
  `bin/` entry point reaches nothing that spawns `claude`/`codex` or fetches a
  provider. The ferry carries messages; it never thinks. (No-direct-provider-call
  policies are satisfied by construction here: no provider call exists to route.)
- **I3 — Cadence is external and floored.** `intervalSeconds` is validated to be
  an integer `>= 60`; the tick never self-schedules. launchd owns the clock.
- **I4 — Handoffs are finite.** `round` is monotone (increments once per full
  claude->codex cycle); reaching `maxRounds` routes to the `max-rounds` terminal.
  This yields the turn corollary below.
- **I5 — Terminals are sticky; corrupt fails safe.** Once a thread exits,
  `advance()` returns the same terminal for any event — including `start`. A
  corrupt/unknown/missing state becomes `blocked-needs-human` and is never
  re-initialized.
- **I6 — Fail-soft, never fail-loop.** An error is logged and the process exits
  cleanly; there is no retry/backoff loop. A failure ends the tick; it never
  spins.

## The turn-count corollary (`<= 2 x maxRounds`)

A **tick never flips a turn** — only a completed agent session does (the
`turn-complete` event, emitted after a real Claude or Codex pass). Each full
round is at most one Claude turn plus one Codex turn, and `round` is monotone and
capped at `maxRounds`. Therefore:

> **A thread can consume at most `2 x maxRounds` model turns before it must reach
> a terminal.** With the default `maxRounds = 4`, that is **<= 8 model turns per
> thread**, then the loop exits or escalates to a human. Raising the cap raises
> the bound proportionally; the clamp keeps it in `1..20`.

This is the hard ceiling on how much model work any single review thread can ever
drive on its own.

## Redaction posture

`core/redact.mjs` is a **runtime OUTPUT filter only** — every human-facing packet,
finding summary, ack, and trace `detail` line passes through it, so a secret shape
that ever leaked into a trace is scrubbed on emit. It is explicitly **not** a
source-hygiene scanner: keeping infrastructure literals, home paths, and token
shapes out of *committed pack source* is enforced separately by the pack's
`pack-hygiene.test.ts` and the upstream fleet-literal gate, neither of which
defers to `redact()`.

## Out of scope for v0.1.0

- **Cross-machine packet sync is v2.** The loop is single-machine: state lives in
  the local `stateDir`, and the two agents share the same working tree. Syncing
  ping-pong packets between machines over git is deferred to a later version. Do
  not assume packets cross machines in v0.1.0.
- **Linux/cron scheduling is v0.2.** v0.1.0 is macOS/launchd only; `install.sh`
  refuses other platforms.
- **Codex custom prompts / automations are v0.2.** The shipped path is the
  `AGENTS.md` review contract; the machine channel it produces is exactly what the
  watcher parses.
