# FOR-AGENTS — self-onboard and drive the loop pack (read this ONE file)

You are an AI agent (Claude Code or Codex) in some git repo. This file is your
paste-ready quickstart. Read it top to bottom, run the commands, start looping.
No other doc is required to get going.

`<pack>` below = the path to this `claude-codex-loops/` directory (the published
install path, or `packages/claude-codex-loops` inside the source repo). Run every
command from **inside the git repo you want to orchestrate**.

## 0. Safety first (know the brakes before you start)

The pack CANNOT spin forever. Every loop is BUILD-TIME, BOUNDED, and self-paced:
trigger → maker → independent checker → disk state → explicit exit → trace. Brakes:

- **maxRounds** — hard round cap per loop (default 4, clamp 1..20). Reaching it exits.
- **no-progress** — report a `no-change`/quiet round and the machine routes to a
  sticky `blocked-needs-human` / clean `quiet` exit. It will not re-run forever.
- **needs-human** — you can escalate; a terminal is STICKY (never re-armed).
- **KILL SWITCH** — `CCL_DISABLED=1` (env) or a `<stateDir>/DISABLED` file halts
  ALL new work first, on every command. To stop everything now:
  `node <pack>/bin/loop.mjs disable`. `enable` releases it.

No provider API keys are used or accepted. The pack drives the `claude`, `codex`,
and `gh` CLIs under their OWN logins. Never add an API key or a provider SDK.

## 1. Install (one command)

```
bash <pack>/install.sh --repo .
```

Idempotent (safe to re-run) and fully reversible (`bash <pack>/uninstall.sh --repo .`).
It copies the skills, writes a default config, deep-merges the Claude/Codex hook
fragments without clobbering foreign hooks, appends the marker-fenced Codex review
contract to `AGENTS.md`, and loads a per-clone launchd job.

## 2. Verify

```
node <pack>/bin/doctor.mjs --repo .
```

Every check must be `PASS`. A `WARN` for a set provider API key is fine — the pack
never needs one. Fix any `FAIL` (`git`, `gh auth`, `claude`, `codex`, node >= 20,
a parseable Codex session, a writable state dir) before looping.

## 3. Start a loop — pick by task

Slash triggers (skills) and what each is for:

| Trigger | Use it for |
|---|---|
| `/research-loop` | **Primary for research.** Bounded cite-or-drop research: verified/sourced findings compound to a per-topic ledger; unsourced claims are dropped. |
| `/ccl-loop` | GENERAL bounded orchestration of ANY multi-step task — build, refactor, migration. Same machinery, generic. |
| `/pingpong` | Advance ONE Claude<->Codex mutual-review round on the working diff. |
| `/pingpong-pr` | Triage outstanding review-bot findings on a pull request through the bounded triage workflow. |
| `/pingpong-install` | Install the pack into the current repo (or `check` = run preflight only). |

### Research (the main cofounder use)

```
/research-loop start  <topic>
/research-loop record <topic> --finding "<claim>" --source "<url>"
/research-loop round  <topic>     # close a round; exits {quiet} when no new sourced finding
/research-loop status <topic>
/research-loop stop   <topic>     # force EXIT{disabled}
```

You do the searching with YOUR OWN session tools (WebSearch / fetch / read). A
claim with a real source is appended (deduped by fingerprint); a claim with no
`--source` is DROPPED to the drop log. Cite or it does not survive.

### General bounded loop (build / refactor / migration)

```
/ccl-loop start  <name> [--max-rounds <n>]
/ccl-loop step   <name> [progress|no-change|converged|quiet|blocked]
/ccl-loop status <name>
/ccl-loop stop   <name>
```

Each iteration: YOU do one unit of work (maker), run an INDEPENDENT checker that
can say "no" (tests / type-check / diff review), then `step` the outcome. The
helper spawns no model — it only keeps disk state and prints the next step.

## 4. Cross-agent Claude<->Codex comms (make the two agents talk)

The two agents never call each other directly. They communicate through a
**ferry tick** + a **review contract**, both on disk in this repo:

- **The ferry tick** (`bin/loop-tick.mjs`, run by launchd) carries messages
  between the Claude session and the Codex session. It NEVER calls a model — it
  pulls what the peer did since the last tick, surfaces only what is new, and
  pushes a machine-readable ack packet. It always exits 0. Force one now:

  ```
  node <pack>/bin/loop-tick.mjs --agent claude --repo .
  ```

- **The review contract** (`codex/AGENTS.review-contract.md`, appended to this
  repo's `AGENTS.md` by install) tells the Codex session how to answer: review
  only the diff since the packet's `lastAckSha`, then emit `CCL-FINDING
  [HIGH|NORMAL] …` lines plus one `CCL-EXIT <state>` line.

- **The watcher** (`bin/watch-codex.mjs`) reads the Codex session's markers back
  out into the state dir so the next tick can ferry them to Claude.

Decision tree — which side are you:

- **If you are Claude:** commit your change, then run `/pingpong round` (or let a
  launchd tick fire). Read the ferried Codex findings, verify each against the
  REAL code, fix what is real, then tick your ack back. `/pingpong status` shows
  every thread without touching state.
- **If you are Codex:** read `AGENTS.md` (the review contract), review only the
  diff since `lastAckSha`, and emit the `CCL-FINDING …` / `CCL-EXIT <state>`
  lines exactly as the contract specifies. The watcher does the rest.

Full round: **commit → tick → Codex review → CCL-FINDING → tick → Claude ack →
quiet.** It terminates or escalates on its own via the brakes above.

## 5. Inspect / stop

```
node <pack>/bin/loop.mjs status          # every thread's state, touches nothing
node <pack>/bin/loop.mjs trace <thread>  # the append-only trace for one thread
node <pack>/bin/loop.mjs reset <thread>  # clear one sticky terminal to re-arm it
node <pack>/bin/loop.mjs disable         # KILL SWITCH — halts all new work
```

That is the whole onboarding. Deeper detail lives in `README.md`,
`docs/ARCHITECTURE.md` (dependency graph + sequence), and `docs/SAFETY.md`
(brake table + invariants) — but you do not need them to start.
