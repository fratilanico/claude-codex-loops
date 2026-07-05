// PING-PONG LEDGER — pure helpers for finding fingerprints + the JSONL trace.
//
// PURE + DETERMINISTIC (node:* stdlib only, no IO, no clocks). The orchestrator
// (bin/loop.mjs) does the file reads/writes; this module only decides.
//
// FINGERPRINT COMPATIBILITY (load-bearing): fingerprint(finding) reproduces the
// EXACT format the pr-review-triage workflow uses so existing ledgers
// (docs/reviews/pr-*.json) still parse and dedupe unchanged. That format is:
//
//     "<surface>|<path or ->|<first 120 chars of body, whitespace-collapsed>"
//
//   - surface: the comment/finding channel ("inline" | "review" | "issue" |
//     "paste" | …). Missing → "-".
//   - path: the file path the finding is about. Missing → "-".
//   - body: the finding text, whitespace-collapsed (all runs of whitespace → one
//     space, trimmed) then sliced to the first 120 chars.
//   Verified against docs/reviews/pr-164-triage.json / pr-183-triage.json.
//
// Contract locked by __tests__/ledger.test.ts (golden fingerprint + trace-line
// snapshots) and re-asserted origin-side (existing ledgers must still parse).

// ── Fingerprint ───────────────────────────────────────────────────────────────

const BODY_MAX = 120; // first N chars of the collapsed body (triage constant)

/** Whitespace-collapse: every run of whitespace → a single space, then trim. */
function collapseWs(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function fieldOrDash(v) {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? "-" : s;
}

/**
 * fingerprint(finding) → the triage-format fingerprint string.
 *
 * Accepts either the rich finding object ({ surface, path, body }) or a partial;
 * unknown fields are ignored. The body is whitespace-collapsed then truncated to
 * 120 chars — byte-identical to how pr-review-triage.js builds it, so a
 * fingerprint computed here matches one already sitting in a shipped ledger.
 *
 * @param { {surface?: string, path?: string, body?: string} } finding
 * @returns {string}
 */
export function fingerprint(finding = {}) {
  const surface = fieldOrDash(finding.surface);
  const path = fieldOrDash(finding.path);
  const body = collapseWs(finding.body).slice(0, BODY_MAX);
  return `${surface}|${path}|${body}`;
}

// ── Trace line ────────────────────────────────────────────────────────────────

// A trace EVENT is a small structured record the orchestrator emits at each
// state transition / brake. traceLine() renders ONE canonical JSONL line for it.
// The `brakeFired` flag marks the safety-relevant lines (a brake terminal) so
// `passCount()` / operators can grep them. Rendering is deterministic: keys are
// emitted in a FIXED order so the golden snapshot is stable and diffs are clean.

// Fixed key order for the rendered JSONL object.
const TRACE_KEYS = Object.freeze([
  "ts",
  "thread",
  "event",
  "from",
  "to",
  "round",
  "maxRounds",
  "brakeFired",
  "reason",
  "detail",
]);

/**
 * Render one canonical JSONL trace line (no trailing newline) from a trace event.
 * PURE — the caller supplies `ts` (no clock in here). Only known keys are
 * emitted, always in TRACE_KEYS order, so the golden snapshot is stable.
 *
 * `brakeFired` is derived, not trusted from the input: it is true iff the event
 * transitioned INTO one of the brake terminals (no-progress | stale | max-rounds
 * | blocked-needs-human | disabled). converged/quiet are clean exits, not brakes.
 *
 * @param {object} event
 * @param {string} [event.ts]
 * @param {string} [event.thread]
 * @param {string} [event.event]
 * @param {string} [event.from]
 * @param {string} [event.to]
 * @param {number} [event.round]
 * @param {number} [event.maxRounds]
 * @param {string} [event.reason]
 * @param {string} [event.detail]
 * @returns {string} one JSONL line (JSON object, no newline)
 */
export function traceLine(event = {}) {
  const to = event.to;
  const rec = {
    ts: event.ts ?? null,
    thread: event.thread ?? null,
    event: event.event ?? null,
    from: event.from ?? null,
    to: to ?? null,
    round: Number.isInteger(event.round) ? event.round : null,
    maxRounds: Number.isInteger(event.maxRounds) ? event.maxRounds : null,
    brakeFired: BRAKE_TERMINALS.has(to),
    reason: event.reason ?? null,
    detail: event.detail ?? null,
  };
  // Emit in fixed key order for a stable, greppable line.
  const ordered = {};
  for (const k of TRACE_KEYS) ordered[k] = rec[k];
  return JSON.stringify(ordered);
}

// Terminals that count as a BRAKE having fired (the safety-relevant exits).
export const BRAKE_TERMINALS = new Set([
  "no-progress",
  "stale",
  "max-rounds",
  "blocked-needs-human",
  "disabled",
]);

// ── Pass counting ──────────────────────────────────────────────────────────────

/**
 * passCount(traceText, fingerprint) → how many completed repair PASSES a given
 * fingerprint has taken, read from a JSONL trace. A "pass" is a trace line whose
 * `detail` names that fingerprint AND whose `event` is a turn-complete (a real
 * agent turn closed on it). This is what the per-fingerprint 2-pass brake reads:
 * passCount ≥ 2 ⇒ the next verdict must be blocked-needs-human.
 *
 * PURE — parses the given text, no IO. Unparseable lines are skipped fail-soft.
 *
 * @param {string} traceText   the JSONL trace contents
 * @param {string} fp          the fingerprint to count
 * @returns {number}
 */
export function passCount(traceText, fp) {
  if (!fp) return 0;
  let n = 0;
  for (const line of String(traceText ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue; // fail-soft: a corrupt line never throws
    }
    if (rec && rec.event === "turn-complete" && rec.detail === fp) n += 1;
  }
  return n;
}

// ── Rotation policy (pure decision; the bin does the fs move) ──────────────────

export const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB
export const DEFAULT_KEEP = 2; // keep 2 rotated generations

/**
 * rotationDecision(currentBytes, incomingBytes, opts) → whether to rotate the
 * trace file BEFORE appending, and how many old generations to keep. PURE: the
 * orchestrator supplies the current file size (stat) and does the actual rename;
 * this only decides. Rotate when appending would push the file past maxBytes.
 *
 * @param {number} currentBytes   size of the live trace file now
 * @param {number} incomingBytes  bytes about to be appended
 * @param { {maxBytes?: number, keep?: number} } [opts]
 * @returns { {rotate: boolean, keep: number, maxBytes: number} }
 */
export function rotationDecision(currentBytes, incomingBytes, opts = {}) {
  const maxBytes =
    Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const keep = Number.isInteger(opts.keep) && opts.keep >= 0 ? opts.keep : DEFAULT_KEEP;
  const cur = Number.isFinite(currentBytes) && currentBytes > 0 ? currentBytes : 0;
  const inc = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
  return { rotate: cur > 0 && cur + inc > maxBytes, keep, maxBytes };
}
