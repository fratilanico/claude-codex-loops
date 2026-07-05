# Architecture

`claude-codex-loops` is a **bounded, build-time** review ping-pong between a
Claude session and a Codex peer working the same git repository. The one law that
shapes every module:

> **Ticks ferry, sessions think.** A scheduled *tick* only carries messages
> between the two agents and updates disk state — it never calls a model. Only a
> completed agent *session* flips a turn. Because turns advance only on real
> session completions, the model-turn count is bounded by the round count.

## Absorbed loop-spine doctrine

Every loop in this pack is one instance of the same six-part spine. It is the
skeleton the PR-triage loop and the ping-pong loop both follow:

1. **Trigger** — an external event or scheduled tick (launchd `StartInterval`, a
   push/merge, a Claude hook). The loop never triggers itself; there is no
   self-re-arm.
2. **Maker** — the agent that does the work (verify a finding, write the TDD-red
   test, implement the fix). Runs inside a *session*, not a tick.
3. **Independent checker** — a *separate* adversarial pass that re-gates the
   maker's uncommitted diff. The maker and checker are never the same turn, and
   the maker never commits.
4. **Disk state** — every decision is persisted (per-thread state under
   `stateDir`, the fingerprint ledger under `ledgerDir`, the JSONL trace). State
   survives session death, so dedupe and round counting are durable.
5. **Explicit exit** — a loop ends in a named terminal (`converged`, `quiet`,
   `max-rounds`, `no-progress`, `stale`, `blocked-needs-human`, `disabled`).
   Anything still "running" that is not one of these is a bug, not a state.
6. **Trace** — a JSONL journal records each transition and brake so a human can
   reconstruct exactly what happened and why the loop stopped.

Terminals are **sticky**: once a thread exits, it stays exited. A corrupt or
unknown state is treated as `blocked-needs-human` — the loop fails *toward* a
human, never re-arms.

## Dependency graph

```
                         core/loop-config.mjs   (pure: loadConfig, validate)
                                  |
   +------------------------------+------------------------------+
   |            |                 |                |             |
bin/loop-tick  bin/watch-codex  bin/loop        bin/doctor    (skills shell to bin/*)
   |            |                 |                |
   |            |                 +--> core/pingpong-state.mjs  (pure state machine)
   |            |                 +--> core/ledger.mjs          (pure fingerprint + trace)
   |            +------------------+--> core/redact.mjs         (runtime OUTPUT filter)
   +--> core/codex-bridge.mjs                                  (pure git-porcelain parsing)

workflows/pr-review-triage.js --> core/collect-round.mjs, parse-agent-json.mjs, untrusted-body.mjs
   (harness-only; keeps INLINE copies of pure modules — byte-parity-tested)
workflows/dev-wave.js          (harness-only; generic maker/checker engine)
```

Rules the graph obeys, enforced by tests:

- **`core/` and `bin/` import `node:*` stdlib only** — no npm runtime deps, no
  provider SDK. (`__tests__/loop-safety.test.ts`, pack-hygiene.)
- **No model call is reachable from any `bin/` entry point.** The invariant `I2`
  walks the *transitive* static-import graph from each bin and proves nothing in
  the reachable set spawns `claude`/`codex` or fetches a provider. The ferry is
  model-free by construction.
- **`workflows/*` are harness-only.** They use the Claude Code Workflow globals
  `agent()` / `parallel()` / `phase()`, which are not stdlib and not available
  under bare `npm test`. They are exercised by `workflow-contract.test.ts` (parse
  as text, required sections/keys present, imports limited to `node:*` + harness
  globals), and `dev-wave.js`'s contract test is its *only* automated coverage.
- **Dependency direction is one-way:** everything depends on `core/`; `core/`
  depends on nothing but `node:*`.

## The ping-pong sequence

```mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Claude as Claude session
    participant Tick as bin/loop-tick (ferry)
    participant State as stateDir + ledger + trace
    participant Codex as Codex peer session
    participant Watch as bin/watch-codex (ferry)

    Human->>Claude: commit work
    Note over Tick: launchd StartInterval fires a tick<br/>(external cadence — never self-scheduled)
    Tick->>Tick: (a) kill-switch check  (b) single-flight lock
    Tick->>State: read last state / packet
    Tick->>Codex: push ack + review-request packet (lastAckSha)
    Note over Tick: tick EXITS 0 — no model call
    Codex->>Codex: read AGENTS contract; review diff since lastAckSha
    Codex-->>Watch: emit CCL-FINDING [HIGH|NORMAL] ... / CCL-EXIT <state>
    Watch->>Watch: scope to this repo; redact every line
    Watch->>State: extract findings under stateDir/cursor
    Note over Tick: next tick
    Tick->>State: surface only findings NEW since last tick
    Tick->>Claude: hand off (probe / packet)
    Claude->>Claude: verify vs real code; TDD-first fix (dev-wave maker/checker)
    Claude->>State: advance() round++; append trace line
    alt findings resolved / clean
        State-->>Human: EXIT converged | quiet
    else brake fires
        State-->>Human: EXIT max-rounds | no-progress | stale | blocked-needs-human
    end
```

The tick never appears as a "thinking" participant that emits findings — it only
moves packets and updates state. The two *sessions* (Claude, Codex) are the only
places a model runs, and each does exactly one bounded pass per invocation.

## State schemas

### Per-thread ping-pong state (`core/pingpong-state.mjs`)

Persisted as plain JSON per thread under `stateDir`:

```jsonc
{
  "status": "active" | "exited",
  "phase":  "idle" | "claude-turn" | "codex-turn"   // while active
          | "<exit-reason>",                          // once exited
  "round":  0,            // MONOTONE non-negative full claude->codex cycles
  "maxRounds": 4,         // clamp 1..20
  "reason": "converged"   // only meaningful when exited
}
```

- Active phases: `idle`, `claude-turn`, `codex-turn`.
- Exit terminals: `converged`, `quiet`, `max-rounds`, `no-progress`, `stale`,
  `blocked-needs-human`, `disabled`.
- `advance(state, event)` is the *only* way the machine moves; it is pure.
  Sticky-terminal, corrupt-to-`blocked-needs-human`, and `disable`-wins-first are
  enforced inside `advance()` so no caller can bypass a brake.

### Ledger fingerprint + trace (`core/ledger.mjs`)

Fingerprint format (byte-identical to the PR-triage ledger so existing ledgers
still parse and dedupe):

```
<surface>|<path or ->|<first 120 chars of whitespace-collapsed body>
```

Ledger file (`<ledgerDir>/pr-<N>-triage.json`):

```jsonc
{ "pr": 164, "entries": [
  { "fingerprint": "inline|path|first-120-chars",
    "verdict": "fixed" | "declined" | "needs-human" | "stale",
    "evidence": "file:line reasoning or commit",
    "files": ["..."], "date": "YYYY-MM-DD" }
] }
```

JSONL trace line (fixed key order for stable, greppable output):

```jsonc
{ "ts": "...", "thread": "...", "event": "...", "from": "...", "to": "...",
  "round": 0, "maxRounds": 4, "brakeFired": false, "reason": null, "detail": null }
```

`brakeFired` is *derived* (true iff the transition entered a brake terminal:
`no-progress`, `stale`, `max-rounds`, `blocked-needs-human`, `disabled`) — never
trusted from the input. The trace rotates at 1 MB, keeping 2 generations.

## Out-of-scope integrations

This pack is a deliberately small extraction. Several deeper integrations exist
in the source monorepo it was split from and are **intentionally left behind** —
they are optional and not part of the v0.1.0 surface:

- A build-loop board / deliverable registry, and a continuous multi-goal
  `dev-loop` driver. This pack ships only the single `dev-wave` maker/checker
  engine those drivers call, not the drivers themselves.
- A multilateral decision "council" skill.
- The broader loop-system / loop-wiring documentation and any organization
  governance hooks.
- The upstream fleet-literal hygiene gate and its canonical denylist live
  **upstream-side on purpose** (shipping infrastructure literals inside the
  pack's own test would itself be a leak). The pack ships only the generic
  `pack-hygiene.test.ts`.

Two other upstream details, noted so a maintainer is not surprised:

- The upstream monorepo keeps thin re-export **shims** at the old module paths so
  its existing consumers stay green after the move; those shims are not part of
  the pack.
- Stale upstream worktrees carry their own self-contained copies of the original
  scripts; they are unaffected by this pack and out of scope.

## Codex-side contract

For v0.1.0 the **fallback is the shipped path**: a Codex session (manual or
headless) that reads the marker-fenced contract in the consumer repo's
`AGENTS.md` (installed from `codex/AGENTS.review-contract.md`) and emits the
`CCL-FINDING` / `CCL-EXIT` machine lines is all the wiring the loop needs — those
lines are exactly what `bin/watch-codex.mjs` parses. Codex custom prompts and
automations are deferred to v0.2 behind a pre-ship format verification.
