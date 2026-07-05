// BOUNDED PING-PONG STATE MACHINE — the safety spine of the loop.
//
// PURE + DETERMINISTIC (node:* stdlib only, no IO, no clocks, no randomness):
// every function is a pure function of its inputs. The orchestrator (bin/*)
// injects the current state + an event and persists whatever this returns. That
// keeps the brake logic unit-testable and lets I1–I6 (loop-safety.test.ts) prove
// the invariants against this module directly.
//
// THE LAW (ticks ferry, sessions think):
//   - A ferry TICK never flips the turn. Only a COMPLETED agent turn does (the
//     `turn-complete` event, emitted after a real Claude/Codex session finishes).
//     So the model-turn count is bounded by the round count: at most one Claude
//     turn + one Codex turn per round ⇒ ≤ 2·maxRounds model turns per thread.
//   - `round` is MONOTONE: it only ever increases, one per full claude→codex
//     cycle, and reaching maxRounds routes to the EXIT{max-rounds} terminal.
//   - TERMINALS ARE STICKY: once a thread has EXITed, advance() is a no-op — it
//     returns the same terminal state forever and NEVER re-initializes. A
//     corrupt/unknown/missing state is treated as the safe terminal
//     EXIT{blocked-needs-human} (fail toward a human, never re-arm a loop).
//
// State shape (plain JSON, persisted per thread by the orchestrator):
//   { status, phase, round, maxRounds, lastFingerprints?, reason? }
//     status:  "active" | "exited"
//     phase:   ACTIVE_PHASES member while active; the EXIT reason once exited
//     round:   monotone non-negative integer (full claude→codex cycles done)
//     reason:  human-readable why-we-exited (only meaningful when status=exited)
//
// Contract locked by __tests__/pingpong-state.test.ts (+ loop-safety.test.ts).

/**
 * @typedef {object} PingpongState
 * @property {"active"|"exited"} status
 * @property {string} phase   an ACTIVE_PHASES member while active; the EXIT reason once exited
 * @property {number} round   monotone non-negative full-round count
 * @property {number} maxRounds
 * @property {string} [reason]
 */

// ── Vocabulary ────────────────────────────────────────────────────────────────

// Non-terminal phases while a thread is live.
export const ACTIVE_PHASES = Object.freeze(["idle", "claude-turn", "codex-turn"]);

// EXIT terminals. The FIRST FIVE plus blocked-needs-human are the CCL-EXIT
// vocabulary the peer emits (watch-codex CCL_EXIT_RE) — keep them identical so a
// peer-emitted CCL-EXIT maps 1:1 onto a terminal here. `disabled` is the local
// kill-switch terminal (never emitted by the peer). `stale` is the freshness
// brake. `blocked-needs-human` is BOTH a normal escalation AND the fail-safe for
// any corrupt/unknown state.
export const EXIT_STATES = Object.freeze([
  "converged",
  "quiet",
  "max-rounds",
  "no-progress",
  "stale",
  "blocked-needs-human",
  "disabled",
]);

const ACTIVE_SET = new Set(ACTIVE_PHASES);
const EXIT_SET = new Set(EXIT_STATES);

// The safe terminal for any corrupt/unknown input — fail toward a human.
export const SAFE_TERMINAL = "blocked-needs-human";

// Events the orchestrator can raise. Anything else is ignored (no-op) while
// active and, per the corrupt-input rule elsewhere, never re-arms a terminal.
//   start          idle → claude-turn (begin the thread)
//   turn-complete  the CURRENT agent finished its real session turn → flip turn
//                  (codex→claude increments the round; maxRounds ⇒ EXIT{max-rounds})
//   converged      reviewer signalled agreement/clean → EXIT{converged}
//   quiet          nothing new to review this wake → EXIT{quiet}
//   no-progress    the no-progress brake fired (see detectNoProgress) → EXIT{no-progress}
//   stale          freshness brake: thread untouched past staleAfterHours → EXIT{stale}
//   blocked        explicit escalation to a human → EXIT{blocked-needs-human}
//   disable        kill switch → EXIT{disabled}
export const EVENTS = Object.freeze([
  "start",
  "turn-complete",
  "converged",
  "quiet",
  "no-progress",
  "stale",
  "blocked",
  "disable",
]);

// Map an escalation/exit event straight to its terminal reason.
const EVENT_TO_TERMINAL = Object.freeze({
  converged: "converged",
  quiet: "quiet",
  "no-progress": "no-progress",
  stale: "stale",
  blocked: "blocked-needs-human",
  disable: "disabled",
});

const DEFAULT_MAX_ROUNDS = 4; // mirrors loop-config DEFAULTS.pingpong.maxRounds

// ── Constructors / guards ───────────────────────────────────────────────────

/**
 * A fresh, valid idle state. maxRounds is clamped to a sane 1..20 (config already
 * clamps; this is defense-in-depth so a hand-built state can never disable the
 * round brake).
 * @returns {PingpongState}
 */
export function initState(maxRounds = DEFAULT_MAX_ROUNDS) {
  const mr = clampRounds(maxRounds);
  return { status: "active", phase: "idle", round: 0, maxRounds: mr };
}

/**
 * Build the sticky terminal for a given reason (a valid EXIT_STATES member).
 * @returns {PingpongState}
 */
export function terminal(reason, base = {}) {
  const r = EXIT_SET.has(reason) ? reason : SAFE_TERMINAL;
  return {
    status: "exited",
    phase: r,
    round: Number.isInteger(base.round) && base.round >= 0 ? base.round : 0,
    maxRounds: clampRounds(base.maxRounds),
    reason: r,
  };
}

export function isTerminal(state) {
  return !!state && state.status === "exited" && EXIT_SET.has(state.phase);
}

export function isActive(state) {
  return (
    !!state &&
    state.status === "active" &&
    ACTIVE_SET.has(state.phase) &&
    Number.isInteger(state.round) &&
    state.round >= 0 &&
    Number.isInteger(state.maxRounds) &&
    state.maxRounds >= 1
  );
}

/**
 * A state is CORRUPT if it is neither a valid active state nor a valid terminal.
 * Corrupt → the machine routes to the safe terminal and never re-initializes.
 */
export function isCorrupt(state) {
  return !isActive(state) && !isTerminal(state);
}

function clampRounds(n) {
  const v = Number(n);
  if (!Number.isInteger(v)) return DEFAULT_MAX_ROUNDS;
  if (v < 1) return 1;
  if (v > 20) return 20;
  return v;
}

// ── The transition function ─────────────────────────────────────────────────

/**
 * advance(state, event) → next state. PURE. The ONLY way the machine moves.
 *
 * Ordering guarantees (all enforced here so no caller can bypass a brake):
 *   1. STICKY TERMINAL: if `state` is already a terminal, return it UNCHANGED for
 *      ANY event — including `start`. A finished thread is never re-armed.
 *   2. CORRUPT/UNKNOWN state → the safe terminal EXIT{blocked-needs-human}.
 *   3. `disable` ALWAYS wins from any active phase (kill switch is honored first).
 *   4. An exit/escalation event routes straight to its terminal.
 *   5. `start` moves idle → claude-turn (only from idle; a no-op mid-thread).
 *   6. `turn-complete` flips the CURRENT turn. codex→claude closes a round
 *      (round++); if that reaches maxRounds the thread EXITs{max-rounds}. The
 *      ferry itself never emits this — only a completed agent session does.
 *   7. Any unrecognized event is a NO-OP on an active state (never a re-arm).
 *
 * @param {object} state
 * @param {string} event
 * @returns {PingpongState} the next state (a fresh plain object; input unmutated)
 */
export function advance(state, event) {
  // (1) sticky terminal — no event, not even `start`, revives it.
  if (isTerminal(state)) return { ...state };

  // (2) corrupt/unknown → fail toward a human, never re-init.
  if (isCorrupt(state)) return terminal(SAFE_TERMINAL, { round: 0, maxRounds: safeMaxRounds(state) });

  // From here `state` is a VALID active state.
  const cur = { ...state };

  // (3) kill switch first.
  if (event === "disable") return terminal("disabled", cur);

  // (4) direct exit/escalation events.
  if (Object.prototype.hasOwnProperty.call(EVENT_TO_TERMINAL, event)) {
    return terminal(EVENT_TO_TERMINAL[event], cur);
  }

  // (5) start: idle → claude-turn. Mid-thread `start` is a no-op (never resets
  // the round or re-arms — only a fresh idle state can begin).
  if (event === "start") {
    if (cur.phase === "idle") return { ...cur, phase: "claude-turn" };
    return cur; // no-op: already running
  }

  // (6) a completed agent turn flips the turn.
  if (event === "turn-complete") {
    if (cur.phase === "idle") {
      // No turn is in flight yet; a completion here is meaningless → begin.
      return { ...cur, phase: "claude-turn" };
    }
    if (cur.phase === "claude-turn") {
      return { ...cur, phase: "codex-turn" }; // hand off; round unchanged
    }
    // codex-turn complete → a FULL round is done. round is MONOTONE.
    const nextRound = cur.round + 1;
    if (nextRound >= cur.maxRounds) {
      return terminal("max-rounds", { round: nextRound, maxRounds: cur.maxRounds });
    }
    return { ...cur, phase: "claude-turn", round: nextRound };
  }

  // (7) unknown event on an active state → no-op (never a re-arm).
  return cur;
}

function safeMaxRounds(state) {
  const v = state && Number(state.maxRounds);
  return Number.isInteger(v) && v >= 1 && v <= 20 ? v : DEFAULT_MAX_ROUNDS;
}

// ── Brakes ───────────────────────────────────────────────────────────────────

/**
 * NO-PROGRESS brake. `history` is an ordered list of per-round finding
 * fingerprint SETS (oldest → newest), one entry per completed round:
 *   [ ["fp1","fp2"], ["fp1","fp2"], ... ]
 * The loop is making no progress when the two most recent rounds carry an
 * IDENTICAL non-empty fingerprint set — the same findings survived a full
 * claude→codex round unchanged. (Empty ↔ empty is "quiet", not "no-progress":
 * detectNoProgress returns false for it; the caller raises `quiet`.)
 *
 * PURE. Returns true iff the last two rounds are identical AND non-empty.
 *
 * @param {Array<Array<string>|Set<string>>} history
 * @returns {boolean}
 */
export function detectNoProgress(history) {
  if (!Array.isArray(history) || history.length < 2) return false;
  const a = normSet(history[history.length - 2]);
  const b = normSet(history[history.length - 1]);
  if (a.size === 0 || b.size === 0) return false; // nothing to be stuck on
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

function normSet(entry) {
  if (entry instanceof Set) return new Set(entry);
  if (Array.isArray(entry)) return new Set(entry);
  return new Set();
}

/**
 * The BRAKE DECISION. Given an active state, the freshness age (hours since the
 * thread was last touched — the caller computes it; this stays clockless), the
 * per-round fingerprint history, and the config governors, return the exit event
 * the orchestrator should raise, or null to keep going. PURE.
 *
 * Precedence (most-protective first): disabled kill-switch is the caller's job
 * (checked before this). Here: stale (freshness) > no-progress > null.
 * maxRounds is enforced by advance() on turn-complete, not here.
 *
 * @param {object} state              current (should be active)
 * @param {object} [o]
 * @param {number} [o.ageHours]       hours since last activity (caller-computed)
 * @param {Array} [o.history]         per-round fingerprint sets
 * @param {number} [o.staleAfterHours] config governor
 * @returns {("stale"|"no-progress"|null)}
 */
export function brakes(state, { ageHours, history, staleAfterHours } = {}) {
  if (!isActive(state)) return null; // terminals/corrupt handled by advance()
  if (
    Number.isFinite(ageHours) &&
    Number.isFinite(staleAfterHours) &&
    staleAfterHours > 0 &&
    ageHours >= staleAfterHours
  ) {
    return "stale";
  }
  if (detectNoProgress(history)) return "no-progress";
  return null;
}

/**
 * Convenience: apply the brake decision (if any) to a state. If a brake fires,
 * returns the terminal; otherwise returns the state unchanged. PURE — a thin
 * compose of brakes() + advance().
 */
export function applyBrakes(state, opts) {
  const ev = brakes(state, opts);
  return ev ? advance(state, ev) : state;
}

// ── Peer CCL-EXIT → machine transition ───────────────────────────────────────

// Map a peer-emitted CCL-EXIT terminal state (watch-codex CCL_EXIT_RE vocabulary)
// onto the advance() event that routes to the same terminal. `max-rounds` has no
// escalation event (it is reached only via turn-complete at the round cap), so it
// is routed directly to its terminal by applyExitState below. `disabled` is a
// LOCAL kill-switch terminal the peer never emits — deliberately absent here.
const EXIT_STATE_TO_EVENT = Object.freeze({
  converged: "converged",
  quiet: "quiet",
  "no-progress": "no-progress",
  stale: "stale",
  "blocked-needs-human": "blocked",
});

/**
 * Apply a peer-emitted CCL-EXIT terminal to a thread state. PURE.
 *
 * The peer's single terminal per pass (the CCL-EXIT line) is the signal that the
 * thread reached an exit; this moves the machine to the matching sticky terminal.
 * All of advance()'s guarantees hold: a state that is ALREADY terminal is
 * returned unchanged (stickiness — a later peer exit cannot revive or overwrite
 * a finished thread), and a corrupt state fails to blocked-needs-human. An
 * unknown/invalid exitState is a no-op (returns the state unchanged) so noise on
 * the channel never forces a transition.
 *
 * @param {object} state       current thread state (active | terminal | corrupt)
 * @param {string} exitState   a CCL-EXIT vocabulary token
 * @returns {PingpongState}
 */
export function applyExitState(state, exitState) {
  // Sticky/corrupt handling is centralized in advance(); defer to it first so a
  // finished thread stays put and a corrupt one fails safe — regardless of exit.
  if (isTerminal(state)) return { ...state };
  if (isCorrupt(state)) return advance(state, "blocked");
  const ev = EXIT_STATE_TO_EVENT[exitState];
  if (ev) return advance(state, ev);
  // max-rounds: valid terminal, no escalation event → route straight to it.
  if (exitState === "max-rounds") return terminal("max-rounds", state);
  return { ...state }; // unknown/absent exit token → no-op (never a re-arm)
}
