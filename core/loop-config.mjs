// CONFIG for the bidirectional ping-pong loop — the ONLY thing that changes per
// reuse. The logic (codex-bridge.mjs / bin/loop-tick.mjs) is frozen +
// deterministic; point the loop at a different repo / peer agent / cadence by
// changing config alone.
//
// loadConfig(env, overrides) is a PURE, DETERMINISTIC function of its inputs
// (env-NAME-as-config-data — same doctrine as the ModelPort seam): no clocks, no
// randomness, no filesystem read INSIDE the pure path. A caller that wants a
// config FILE layer merges the parsed file object in via `overrides` before env,
// or passes it as the `file` field of the second argument (see loadConfig).
// Absolute paths are resolved by the orchestrator (bin/loop-tick.mjs) from the
// neutral *Rel fields + an injected repoRoot — this module resolves none.
//
// MOVED from the origin monorepo's ops lib. The DEFAULTS here are NEUTRAL
// (repoScope resolved from the git-toplevel basename by the caller; stateDir
// '.agent-loops'; ledgerDir 'docs/reviews') so the pack ships without any
// consumer-specific value. A downstream consumer keeps a thin shim at its old
// path that re-points the defaults back to its own values, so its existing
// config contract test stays green.
//
// Contract locked by __tests__/loop-config.test.ts.

// NEUTRAL defaults. repoScope is the empty-string sentinel: the caller
// (bin/loop-tick.mjs) fills it from `basename(git rev-parse --show-toplevel)`
// when it is still empty after config resolution. Everything else is a safe,
// consumer-agnostic default.
export const DEFAULTS = Object.freeze({
  // WHO/WHERE we watch.
  repoScope: "", // "" → caller substitutes basename(git toplevel)
  peer: "codex", // the peer agent label
  branchPrefix: "refs/remotes/origin/codex", // remote-tracking refs to compare
  fetchRefspec: "+refs/heads/codex/*:refs/remotes/origin/codex/*",
  claudeBranchPrefix: "claude/", // Claude's branch namespace (into the AGENTS contract)
  // WHERE we read/write (relative to repoRoot). Neutral — no consumer literal.
  stateDir: ".agent-loops", // per-clone loop state (never collides across clones)
  ledgerDir: "docs/reviews", // ping-pong / triage ledger home
  // CADENCE + LIMITS.
  intervalSeconds: 600, // == launchd StartInterval; single source of truth
  maxAckFindings: 20,
  watchWindowHours: 24,
  fetch: false, // network opt-in
  // PING-PONG round governance (NEW — Layer C safety spine reads these).
  pingpong: Object.freeze({
    maxRounds: 4, // clamp 1..20; ≤ 2·maxRounds model turns per thread
    staleAfterHours: 48, // a thread untouched this long → EXIT{stale}
    maxPacketFindings: 30, // overflow findings deferred (noted, not dropped silently)
  }),
  // PR-review triage governance (NEW).
  triage: Object.freeze({
    maxRounds: 3, // whole-sweep cap atop the per-fingerprint 2-pass brake
  }),
  // KILL SWITCH / opt-in behaviors (NEW).
  disabled: false, // <stateDir>/DISABLED file OR CCL_DISABLED=1 → honored first
  tickOnStop: false, // Stop-hook tick only when CCL_TICK_ON_STOP=1
});

// Clamp helpers — deterministic, no throw on out-of-range (config is best-effort;
// validateConfig() is the strict gate for the required string/int invariants).
function toPosInt(val, fallback) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function clampInt(val, lo, hi, fallback) {
  const n = Number(val);
  if (!Number.isInteger(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Pure config resolution with a documented precedence:
 *   DEFAULTS  <  file  <  env  <  overrides (CLI)
 *
 * The `overrides.file` field (a parsed config-file object) is applied at the FILE
 * layer (below env); every OTHER field of `overrides` is applied at the CLI layer
 * (above env). This keeps loadConfig pure — reading/parsing the config file is the
 * caller's IO job; loadConfig only merges the parsed object. Returns a FROZEN,
 * validated config (nested `pingpong`/`triage` governors frozen too). The return
 * type is inferred from the returned object so TS consumers see the full shape.
 */
export function loadConfig(env = {}, overrides = {}) {
  const { file, ...cliOverrides } = overrides || {};

  // Start from a DEEP, mutable copy of DEFAULTS (nested objects are frozen).
  const cfg = {
    ...DEFAULTS,
    pingpong: { ...DEFAULTS.pingpong },
    triage: { ...DEFAULTS.triage },
  };

  // ── FILE layer (below env) ───────────────────────────────────────────────
  if (file && typeof file === "object") {
    applyLayer(cfg, file);
  }

  // ── ENV layer ────────────────────────────────────────────────────────────
  // Legacy CODEX_LOOP_* names (locked for back-compat) …
  if (env.CODEX_LOOP_REPO_SCOPE) cfg.repoScope = env.CODEX_LOOP_REPO_SCOPE;
  else if (env.CODEX_WATCH_REPO_SCOPE) cfg.repoScope = env.CODEX_WATCH_REPO_SCOPE;
  if (env.CODEX_LOOP_PEER) cfg.peer = env.CODEX_LOOP_PEER;
  if (env.CODEX_LOOP_BRANCH_PREFIX) cfg.branchPrefix = env.CODEX_LOOP_BRANCH_PREFIX;
  if (env.CODEX_LOOP_FETCH_REFSPEC) cfg.fetchRefspec = env.CODEX_LOOP_FETCH_REFSPEC;
  if (env.CODEX_LOOP_INTERVAL)
    cfg.intervalSeconds = toPosInt(env.CODEX_LOOP_INTERVAL, cfg.intervalSeconds);
  if (env.CODEX_LOOP_MAX_ACK)
    cfg.maxAckFindings = toPosInt(env.CODEX_LOOP_MAX_ACK, cfg.maxAckFindings);
  if (env.CODEX_LOOP_WINDOW_HOURS)
    cfg.watchWindowHours = toPosInt(env.CODEX_LOOP_WINDOW_HOURS, cfg.watchWindowHours);
  if (env.CODEX_LOOP_FETCH !== undefined) cfg.fetch = env.CODEX_LOOP_FETCH === "1";

  // … new CCL_* names.
  if (env.CCL_STATE_DIR) cfg.stateDir = env.CCL_STATE_DIR;
  if (env.CCL_LEDGER_DIR) cfg.ledgerDir = env.CCL_LEDGER_DIR;
  if (env.CCL_MAX_ROUNDS)
    cfg.pingpong.maxRounds = clampInt(env.CCL_MAX_ROUNDS, 1, 20, cfg.pingpong.maxRounds);
  if (env.CCL_STALE_HOURS)
    cfg.pingpong.staleAfterHours = toPosInt(env.CCL_STALE_HOURS, cfg.pingpong.staleAfterHours);
  if (env.CCL_TRIAGE_MAX_ROUNDS)
    cfg.triage.maxRounds = clampInt(env.CCL_TRIAGE_MAX_ROUNDS, 1, 20, cfg.triage.maxRounds);
  if (env.CCL_DISABLED !== undefined) cfg.disabled = env.CCL_DISABLED === "1";
  if (env.CCL_TICK_ON_STOP !== undefined) cfg.tickOnStop = env.CCL_TICK_ON_STOP === "1";

  // ── CLI layer (top) ──────────────────────────────────────────────────────
  applyLayer(cfg, cliOverrides);

  // Re-clamp the round governors so a file/CLI override can never smuggle an
  // out-of-range value past the DEFAULTS<file<env<CLI precedence.
  cfg.pingpong.maxRounds = clampInt(cfg.pingpong.maxRounds, 1, 20, DEFAULTS.pingpong.maxRounds);
  cfg.triage.maxRounds = clampInt(cfg.triage.maxRounds, 1, 20, DEFAULTS.triage.maxRounds);

  validateConfig(cfg);

  // Deep-freeze: nested governors are read-only too.
  cfg.pingpong = Object.freeze(cfg.pingpong);
  cfg.triage = Object.freeze(cfg.triage);
  return Object.freeze(cfg);
}

// Merge one layer object into cfg. Top-level scalar keys overwrite; the nested
// `pingpong`/`triage` objects merge field-by-field so a partial override does not
// wipe sibling governors.
function applyLayer(cfg, layer) {
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    if (k === "pingpong" && v && typeof v === "object") {
      Object.assign(cfg.pingpong, v);
    } else if (k === "triage" && v && typeof v === "object") {
      Object.assign(cfg.triage, v);
    } else {
      cfg[k] = v;
    }
  }
}

/** Deterministic validation — throws a clear, field-named error on bad config. */
export function validateConfig(cfg) {
  const nonEmpty = (k) => {
    if (typeof cfg[k] !== "string" || cfg[k].trim() === "")
      throw new Error(`loop config: ${k} must be a non-empty string`);
  };
  // repoScope may be "" here (the caller substitutes the git-toplevel basename);
  // the other path/label fields must be present.
  if (typeof cfg.repoScope !== "string")
    throw new Error(`loop config: repoScope must be a string`);
  nonEmpty("peer");
  nonEmpty("branchPrefix");
  nonEmpty("stateDir");
  nonEmpty("ledgerDir");
  // KEPT from the inherited config: the cadence sanity floor.
  if (!Number.isInteger(cfg.intervalSeconds) || cfg.intervalSeconds < 60)
    throw new Error(`loop config: intervalSeconds must be an integer >= 60`);
  if (!Number.isInteger(cfg.maxAckFindings) || cfg.maxAckFindings < 1)
    throw new Error(`loop config: maxAckFindings must be an integer >= 1`);
  if (!Number.isInteger(cfg.watchWindowHours) || cfg.watchWindowHours < 1)
    throw new Error(`loop config: watchWindowHours must be an integer >= 1`);
  const pp = cfg.pingpong || {};
  if (!Number.isInteger(pp.maxRounds) || pp.maxRounds < 1 || pp.maxRounds > 20)
    throw new Error(`loop config: pingpong.maxRounds must be an integer in 1..20`);
  if (!Number.isInteger(pp.staleAfterHours) || pp.staleAfterHours < 1)
    throw new Error(`loop config: pingpong.staleAfterHours must be an integer >= 1`);
  const tr = cfg.triage || {};
  if (!Number.isInteger(tr.maxRounds) || tr.maxRounds < 1 || tr.maxRounds > 20)
    throw new Error(`loop config: triage.maxRounds must be an integer in 1..20`);
}
