# claude-codex-loops

A **general agent-orchestration platform**: bounded, **build-time**, self-paced
loops that let one AI session drive any multi-step task — **research**, build,
refactor, migration — with an independent checker and hard brakes, plus mutual
**Claude<->Codex review** between two sessions on the same repo. It is not a
PR-review tool; PR review is one of several loops it ships.

> **For agents:** if you are an AI agent (Claude Code or Codex) landing in a repo,
> read **[`FOR-AGENTS.md`](FOR-AGENTS.md)** — one file, paste-ready, gets you
> installed and looping.

> **Ticks ferry, sessions think.** A scheduled *tick* only carries messages
> between the two agents — it never calls a model. The two sessions do the
> thinking. Every executable is a single bounded run that always exits: there is
> **no resident daemon, no self-re-arming loop, and no runtime autonomous agent
> surface**. Cadence is owned by the OS scheduler, not by the pack.

**NO API keys required or accepted — the pack drives the `claude`, `codex`, and
`gh` CLIs under their own logins; `doctor` warns if provider API keys are set.**

Zero runtime dependencies. `core/` + `bin/` are Node stdlib (`node:*`) only.
`vitest` is the sole dev dependency.

---

## Bootstrap — one command

Run from inside the git repo you want to orchestrate (`<pack>` = this directory):

```
bash <pack>/install.sh --repo .
```

Idempotent, reversible (`bash <pack>/uninstall.sh --repo .`). Then verify with
`node <pack>/bin/doctor.mjs --repo .` and start any loop below.

## Primary example — a research loop

Research is the flagship use. `/research-loop` compounds only **sourced, verified**
findings; an unsourced claim is dropped. You do the searching with your own session
tools — the helper is pure local bookkeeping over a per-topic findings ledger.

```
/research-loop start  <topic>
/research-loop record <topic> --finding "<claim>" --source "<url>"
/research-loop round  <topic>     # close a round; exits {quiet} when nothing new is sourced
/research-loop status <topic>
```

## Other loops

- **`/ccl-loop`** — the same bounded machinery, generic: drive ANY multi-step
  build / refactor / migration as maker → independent checker → disk state → exit.
- **`/pingpong`** — advance ONE Claude<->Codex mutual-review round on the diff.
- **`/pingpong-pr`** — triage outstanding review-bot findings on a pull request.
- **`/pingpong-install`** — install the pack into the current repo (or preflight).

All share the same brakes (maxRounds, no-progress, needs-human) and kill switch;
see the ping-pong walkthrough below and `docs/SAFETY.md`.

---

## Compatibility matrix

| Surface | v0.1.0 support | Notes |
|---|---|---|
| OS / scheduler | **macOS + launchd only** | `install.sh` refuses to run on any non-Darwin platform with a clear message. Linux/cron is **v0.2** (not shipped — do not rely on it). |
| Node | **>= 20** | `doctor` fails below 20. |
| Claude CLI | any logged-in `claude` on `PATH` | Driven under its own login; no API key. |
| Codex CLI | pinned tested version: **`<PIN codex CLI version here at ship time>`** | Contract-driven (see `docs/PR-REVIEW-LOOP.md` and `codex/AGENTS.review-contract.md`). A Codex session that follows the `AGENTS.md` contract is the shipped path; `codex/prompts/` + automations are **v0.2**. |
| `gh` CLI | any authenticated `gh` | Used for PR triage; driven under its own login. |

> The Codex CLI version is intentionally a placeholder: pin the exact version you
> tested against before handing the pack to a collaborator, so a Codex-side
> rollout-format change is caught by `doctor` (which asserts a parseable
> `session_meta` rollout) rather than silently.

---

## Walkthrough — 0 to Claude<->Codex ping-pong in 6 steps

Run everything from **inside the git repo** you want the loop to watch.

1. **Preflight.** Confirm the environment is ready:

   ```
   node <pack>/bin/doctor.mjs --repo .
   ```

   Every check must be `PASS` (a `WARN` for a set provider key is fine — it is
   never needed). Fix any `FAIL` (`git`, `gh auth`, `claude`, `codex`, node >= 20,
   a parseable Codex session, a writable state dir) before continuing.

2. **Install into this repo.** Copies the skills, writes a default config,
   deep-merges the Claude/Codex hook fragments (never clobbering foreign hooks),
   appends the marker-fenced Codex review contract to `AGENTS.md`, and loads a
   per-clone launchd job:

   ```
   <pack>/install.sh --repo .
   ```

   The installer is idempotent (re-running changes nothing) and fully reversible
   via `<pack>/uninstall.sh`.

3. **Configure (optional).** Every key is optional; the defaults ship working.
   To override, copy the example and edit:

   ```
   cp <pack>/config.example.json .claude-codex-loops.json
   ```

   See the **Config & environment** table below for every key and its env var.

4. **Let a tick run.** launchd fires `bin/loop-tick.mjs` on the interval (floor
   60s). To force one now:

   ```
   node <pack>/bin/loop-tick.mjs --agent claude --repo .
   ```

   A tick pulls what the Codex peer is doing, surfaces only what is new since the
   last tick, and pushes a machine-readable ack packet. It always exits 0 — even
   on kill-switch, lock-held, or a hung subprocess.

5. **Run the Codex peer.** Open (or headlessly run) a Codex session in the same
   repo. It reads the `AGENTS.md` review contract, reviews only the diff since
   the packet's `lastAckSha`, and emits `CCL-FINDING [HIGH|NORMAL] …` lines plus
   one `CCL-EXIT <state>` line. `bin/watch-codex.mjs` extracts those markers into
   the state dir for the next tick.

6. **Drive & inspect the round.** Advance one bounded round and read state with
   the skills or the control plane:

   ```
   /pingpong round        # advance exactly ONE review round, then stop
   /pingpong status       # print every thread's state, touch nothing
   node <pack>/bin/loop.mjs status
   node <pack>/bin/loop.mjs trace <thread>
   ```

That is a full ping-pong: **commit -> tick -> Codex review -> findings -> tick ->
ack -> quiet.** The loop terminates or escalates on its own (see `docs/SAFETY.md`).

---

## Config & environment

Config file: `<repo>/.claude-codex-loops.json` (all keys optional, **zero
secrets**). Precedence is **DEFAULTS < config file < environment < CLI flags**,
resolved by the pure `loadConfig()` in `core/loop-config.mjs`. Every value below
is the built-in default.

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `repoScope` | `""` -> git-toplevel basename | Which repo's peer sessions/branches to watch. Empty = the caller substitutes `basename(git rev-parse --show-toplevel)`. |
| `peer` | `codex` | The peer agent label. |
| `branchPrefix` | `refs/remotes/origin/codex` | Remote-tracking refs to compare against the peer. |
| `fetchRefspec` | `+refs/heads/codex/*:refs/remotes/origin/codex/*` | Refspec used when `fetch` is on. |
| `claudeBranchPrefix` | `claude/` | Claude's branch namespace (referenced by the `AGENTS.md` contract). |
| `stateDir` | `.agent-loops` | Per-clone loop state dir (relative to repo root; never collides across clones). |
| `ledgerDir` | `docs/reviews` | Ping-pong / triage ledger home. |
| `intervalSeconds` | `600` | launchd `StartInterval`. **Floor 60**, validated. |
| `maxAckFindings` | `20` | Max findings carried in one ack packet. |
| `watchWindowHours` | `24` | How far back the watcher scans peer sessions. |
| `fetch` | `false` | Network opt-in (`"1"` to enable a fetch during a tick). |
| `pingpong.maxRounds` | `4` | Round cap per thread. Clamp `1..20`. Bounds model turns per thread to `<= 2 x maxRounds` (= 8). |
| `pingpong.staleAfterHours` | `48` | A thread untouched this long exits `stale`. |
| `pingpong.maxPacketFindings` | `30` | Overflow findings are deferred (noted), never silently dropped. |
| `triage.maxRounds` | `3` | Whole-sweep PR-triage cap, atop the per-fingerprint 2-pass brake. Clamp `1..20`. |
| `disabled` | `false` | Kill switch (also `<stateDir>/DISABLED` file / `CCL_DISABLED=1`). |
| `tickOnStop` | `false` | Run a tick on the Claude `Stop` hook only when opted in. |

### Environment variables

Every env var the pack reads, its config key, and default. New `CCL_*` names are
preferred; the legacy `CODEX_*` names are retained for back-compat.

| Env var | Maps to | Default |
|---|---|---|
| `CCL_CONFIG` | path to the config file the tick loads | `<repo>/.claude-codex-loops.json` |
| `CCL_STATE_DIR` | `stateDir` | `.agent-loops` |
| `CCL_LEDGER_DIR` | `ledgerDir` | `docs/reviews` |
| `CCL_MAX_ROUNDS` | `pingpong.maxRounds` (clamp 1..20) | `4` |
| `CCL_STALE_HOURS` | `pingpong.staleAfterHours` | `48` |
| `CCL_TRIAGE_MAX_ROUNDS` | `triage.maxRounds` (clamp 1..20) | `3` |
| `CCL_DISABLED` | `disabled` (`"1"` = kill switch on) | unset (off) |
| `CCL_TICK_ON_STOP` | `tickOnStop` (`"1"` = tick on Stop hook) | unset (off) |
| `CCL_WATCH_FILE_ISSUES` | file GitHub issues from watcher findings (`"1"` = on) | unset (off; local report only) |
| `CCL_PR_BOTS` | PR-triage bot logins (comma-separated) | `coderabbitai,chatgpt-codex-connector` |
| `CCL_VERIFY_MODEL` | triage per-finding verify model label | `opus` |
| `CCL_REGATE_MODEL` | triage final re-gate model label | `opus` |
| `CCL_IMPL_HARD_MODEL` | dev-wave hard-implementation model label | `opus` |
| `CCL_IMPL_STD_MODEL` | dev-wave standard-implementation model label | `sonnet` |
| `CCL_REVIEW_MODEL` | dev-wave review model label | `opus` |
| `CCL_SAFETY_LENS` | dev-wave generic safety-lens prompt override | built-in generic lens |
| `CODEX_LOOP_REPO_SCOPE` | `repoScope` | git-toplevel basename |
| `CODEX_WATCH_REPO_SCOPE` | `repoScope` (fallback) | git-toplevel basename |
| `CODEX_LOOP_PEER` | `peer` | `codex` |
| `CODEX_LOOP_BRANCH_PREFIX` | `branchPrefix` | `refs/remotes/origin/codex` |
| `CODEX_LOOP_FETCH_REFSPEC` | `fetchRefspec` | `+refs/heads/codex/*:refs/remotes/origin/codex/*` |
| `CODEX_LOOP_INTERVAL` | `intervalSeconds` (floor 60) | `600` |
| `CODEX_LOOP_MAX_ACK` | `maxAckFindings` | `20` |
| `CODEX_LOOP_WINDOW_HOURS` | `watchWindowHours` | `24` |
| `CODEX_LOOP_FETCH` | `fetch` (`"1"` = on) | unset (off) |

> The model-label env vars (`CCL_VERIFY_MODEL`, `CCL_REGATE_MODEL`,
> `CCL_IMPL_HARD_MODEL`, `CCL_IMPL_STD_MODEL`, `CCL_REVIEW_MODEL`) are **labels
> only** — the pack passes them to the `claude` CLI; they are never keys and
> carry no secret.
>
> The subprocess timeout (60s on every external `git`/`gh` call) is fixed in
> v0.1.0 and is not configurable.

### Multi-repo / multi-clone

State never collides: `stateDir` is `.agent-loops/` **relative to each clone's
repo root**, so two clones keep independent state by construction. The only
user-global namespace is launchd, so the scheduler label is made unique per
clone:

```
com.claude-codex-loops.<repo-basename>-<sha256(repo-abspath)[0:8]>
```

`doctor` detects a **duplicate loaded launchd label** (the same repo installed
twice) and refuses. Two *different* clones of the same repo therefore get
distinct labels and coexist safely.

---

## FAQ / troubleshooting

**`doctor` says `gh` is not authenticated.**
Run `gh auth login`. The pack drives `gh` under your own login and never stores a
token.

**A tick printed `lock-held` and did nothing.**
Expected. A slower tick was still running (e.g. launchd fired again). The
single-flight lock (`<stateDir>/tick.lock`) makes the second tick exit 0
immediately. A lock older than the 15-minute TTL is reclaimed automatically, so a
crashed tick cannot wedge the loop.

**A thread is stuck reporting `blocked-needs-human`.**
Terminals are **sticky** — a finished or escalated thread is never re-armed. This
is the safe design. Review it, then `node bin/loop.mjs reset <thread>` to clear
that thread's state and trace so a fresh round can begin.

**The loop stopped early with `stale` / `no-progress` / `max-rounds`.**
Those are the brakes doing their job (see `docs/SAFETY.md`). Raise
`pingpong.maxRounds` (or `pingpong.staleAfterHours`) in config if a real thread
legitimately needs more rounds.

**The watcher isn't picking up Codex findings.**
Confirm the Codex session ran *in this repo* (the watcher only reads sessions
scoped to this repo's path by segment match) and that it emitted `CCL-FINDING` /
`CCL-EXIT` lines per `codex/AGENTS.review-contract.md`. `doctor` asserts at least
one parseable `session_meta` rollout exists.

**Nothing happens on macOS after install.**
Check the launchd job loaded: `launchctl list | grep claude-codex-loops`. Logs
land under `<stateDir>/launchd.out.log` and `<stateDir>/launchd.err.log`.

**How do I stop the loop entirely?**
`node bin/loop.mjs disable` (writes `<stateDir>/DISABLED`) or set
`CCL_DISABLED=1`. The kill switch is honored first on every path. `enable`
releases it. To remove the pack entirely, run `uninstall.sh`.

**Does the pack ever call a model or need an API key?**
No. `core/` + `bin/` make **zero** model calls (enforced by the I2 import-graph
test). The workflows drive the `claude`/`gh` CLIs under their own logins.
`doctor` **warns** if a provider API key env var is set, because the pack neither
needs nor accepts one.

---

## Maintainers — subtree sync doctrine

This pack is published from an upstream monorepo via **`git subtree`**:

- **Publish upstream -> pack repo:**
  `git subtree push --prefix=packages/claude-codex-loops <pack-remote> main`
- **Pull a collaborator's changes back:**
  `git subtree pull --prefix=packages/claude-codex-loops <pack-remote> main`
- **`skills-lock.json`** carries the sha256 of each shipped skill; recompute the
  hashes per release tag with the documented one-liner and commit the update in
  the same release.
- A subtree split preserves **full path history**, so the directory must be born
  clean — no home paths, no infrastructure literals, no secret shapes. Two
  hygiene gates enforce this (`__tests__/pack-hygiene.test.ts` ships in-pack; the
  upstream fleet-literal gate runs upstream-side).
- **Inline-copy parity:** the harness cannot static-import from `core/`, so the
  triage workflow keeps inline copies of a couple of pure modules.
  `__tests__/inline-copy-parity.test.ts` byte-compares them (sha256) and fails on
  any drift — keep the copies identical to `core/` when you edit either.

---

## Uninstall

```
<pack>/uninstall.sh --repo .
```

`uninstall.sh` unloads and removes the launchd job, strips the marker-fenced
blocks it added, removes **only** the `_ccl`-tagged hook entries (foreign hooks
survive untouched), writes the `DISABLED` kill switch, and **keeps your state
dir** (its path is printed so you can remove it manually if you want). It is the
exact reverse of `install.sh`.

---

## Layout

```
FOR-AGENTS.md  paste-ready self-onboarding for an AI agent (install → verify → loop → comms)
core/        pure, node:*-only logic (config, state machine, ledger, redactor, bridge)
bin/         bounded single-tick executables (loop-tick, watch-codex, loop, doctor)
workflows/   harness-only Workflows (pr-review-triage, dev-wave) — not run under bare npm test
skills/      /research-loop, /ccl-loop, /pingpong, /pingpong-pr, /pingpong-install (thin wrappers over core/ + bin/*)
hooks/       Claude + Codex hook fragments (deep-merged, never clobbered, by install.sh)
codex/       the Codex review contract appended to the consumer AGENTS.md
schedule/    the launchd plist template
docs/        ARCHITECTURE.md, SAFETY.md, PR-REVIEW-LOOP.md
```

See `docs/ARCHITECTURE.md` for the dependency graph and the ping-pong sequence,
and `docs/SAFETY.md` for the brake table and the I1–I6 invariants.
