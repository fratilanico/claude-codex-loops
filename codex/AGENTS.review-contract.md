# Codex review contract (claude-codex-loops)

This file documents the **Codex -> Claude** review direction for the
`claude-codex-loops` ping-pong. `install.sh` appends the marker-fenced block
below into the **consumer repo's `AGENTS.md`** — never into the global
`~/.codex/AGENTS.md`. The block is idempotent: a re-install replaces only the
fenced region and leaves the rest of `AGENTS.md` untouched.

For v0.1.0 the **fallback path is the shipped path**: a Codex session (manual or
headless) that reads `AGENTS.md` and follows the contract below is enough to
drive the loop. There is no `codex/prompts/` or `codex/automations/` in this
release — those are deferred to v0.2. A Codex session that honors this contract
produces exactly the machine-readable channel the Claude-side watcher already
parses, so no additional wiring is required.

The block between the `ccl:begin` / `ccl:end` markers is the literal text that
install.sh manages. Everything inside those markers is the operative contract.

<!-- ccl:begin -->
## Claude <-> Codex review loop (managed by claude-codex-loops — do not edit inside the ccl markers)

You are the **Codex peer** in a bounded, build-time review ping-pong with a
Claude session working the same repository. Each time you run under this
contract you perform **one review pass and then stop**. You never start a
background loop, never re-arm yourself, and never keep working after the pass is
emitted. The Claude side runs a bounded tick that ferries your findings back;
the two sessions do the thinking, the ticks only carry messages.

### (a) Ack-read the latest Claude packet

Before doing anything else, **read the latest Claude status / review-request
packet for this repo**. It is written under the pack state directory
(default `.agent-loops/`, overridable via `CCL_STATE_DIR`) — look for the most
recent review-request packet and the current status line. Acknowledge that you
have read it: record the packet's `lastAckSha` (the commit the packet was built
against). If no packet exists yet, treat the loop as not-yet-started and emit a
single `CCL-EXIT quiet` — do not invent findings.

### (b) Scope your work to changes since `lastAckSha`

Review **only the changes since the `lastAckSha`** carried by that packet
(`git diff <lastAckSha>..HEAD` and the files it touches). Do not re-review the
whole tree, do not walk history before `lastAckSha`, and do not comment on code
the packet did not put in scope. If `lastAckSha` is missing or does not resolve,
emit `CCL-EXIT blocked-needs-human` and stop — never fall back to a full-repo
sweep.

### (c) Emit findings on the CCL-FINDING channel

Emit each finding as its **own line**, in this exact machine format, so the
Claude-side watcher parses it structurally (no prose heuristics):

```
CCL-FINDING [HIGH] <one-line summary of the finding>
CCL-FINDING [NORMAL] <one-line summary of the finding>
```

- The priority tag is **exactly** `[HIGH]` or `[NORMAL]` (uppercase, in square
  brackets, with a space before the summary).
- `HIGH` = security / correctness / data-loss / CI-breaking; `NORMAL` =
  everything else worth a round.
- One finding per line; keep each summary short (it is truncated downstream).

When the pass is complete, emit **exactly one** exit line naming the terminal
state for this thread:

```
CCL-EXIT <state>
```

where `<state>` is one of: `converged`, `quiet`, `max-rounds`, `no-progress`,
`stale`, `blocked-needs-human`. Use `converged` when the diff is clean and you
agree with it, `quiet` when there is nothing new to review this pass, and
`blocked-needs-human` when you cannot safely proceed. Emit the `CCL-FINDING`
lines first, then the single `CCL-EXIT` line last.

### (d) Mirror the redaction rules (no secrets or paths in findings)

Your finding summaries mirror the pack's runtime redaction rules
(`core/redact.mjs`). **Never** put a secret shape (provider key, GitHub PAT,
JWT, connection URL with credentials, or any `password`/`api_key`/`token=…`
pair) or an absolute machine path into a `CCL-FINDING` line. Reference code by
repo-relative path and line only. Describe the defect, not the secret — if a
finding *is* a leaked secret, say "hard-coded credential at `<relpath>:<line>`"
and stop there; do not echo the value.

### (e) Bounded exits — exactly ONE pass per tick

Do **one** review pass per invocation and then exit. Do not spawn a watcher, do
not `sleep`-and-retry, do not schedule yourself, and do not open a second pass
in the same run. If you have nothing to add, emit `CCL-EXIT quiet` and stop.
Reaching a natural end of review means emitting your single `CCL-EXIT` line and
returning — the cadence between passes belongs to the Claude-side tick and the
repo's scheduler, not to you.

### (f) Never force-push, never push to main/master

Never `git push --force` / `--force-with-lease` on any branch, and never push to
`main` or `master`. Your output is **findings on the CCL channel**, not commits
to shared branches. If a fix is warranted you describe it as a finding; the
Claude session applies and commits fixes under its own TDD-first flow. If you
must record work, use a scoped, non-`main` branch and a normal (non-force)
push only.

<!-- ccl:end -->
