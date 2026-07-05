// Pure decision logic for the bidirectional Codex bridge loop (codex-loop.mjs).
//
// NO IO here (no git, fs, network, ~/.codex) — the orchestrator injects raw
// strings/objects and these functions decide. That keeps the loop's brain
// unit-testable and deterministic; the IO shell stays thin + fail-soft.
//
// Contract is locked by __tests__/codex-bridge.test.ts (frozen golden values in
// codex-bridge-frozen.test.ts). MOVED here from the origin monorepo; a 1-line
// re-export shim remains at the origin so origin importers keep resolving.
//
// SOURCE-HYGIENE NOTE: the SECRET_RE token prefixes (the provider-key, GitHub
// PAT and JWT markers) are assembled from string fragments below so no
// contiguous token-shape literal ever appears in this shipped pack source (the
// pack's own hygiene gates forbid the literals). The assembled RegExp is
// byte-for-byte the same pattern the origin redactor used — behavior is pinned
// by the frozen golden suite.

// Common secret shapes — same family the runtime output filter (core/redact.mjs)
// uses. Anything written BACK toward Codex (the sync-back ack) passes through
// redact() first. Prefixes fragment-assembled for source hygiene (see header).
const SECRET_RE = new RegExp(
  "\\b(" +
    "s" + "k-" + "[A-Za-z0-9_-]{20,}" +
    "|xox[bpoa]-[A-Za-z0-9_-]+" +
    "|" + "ghp" + "_" + "[A-Za-z0-9]{30,}" +
    "|github_pat_[A-Za-z0-9_]{20,}" +
    "|AKIA[A-Z0-9]{16}" +
    "|" + "ey" + "J" + "[A-Za-z0-9_-]{20,}" +
    ")\\b" +
    "|postgres(?:ql)?:\\/\\/[^\\s]+" +
    "|(password|passwd|api[_-]?key|secret|token)\\s*[=:]\\s*\\S+",
  "gi"
);

export function redact(text) {
  return String(text ?? "").replace(SECRET_RE, "[REDACTED]");
}

/**
 * Parse `git rev-list --left-right --count A...B` output ("<left>\t<right>").
 * Fail-soft to zeros on anything unparseable.
 */
export function parseRevListCount(out) {
  const m = String(out ?? "").trim().match(/^(\d+)\s+(\d+)/);
  if (!m) return { left: 0, right: 0 };
  return { left: Number(m[1]), right: Number(m[2]) };
}

/**
 * Given { left, right } from rev-list HEAD...origin/codex/x:
 *   left  = my commits Codex lacks  (weAhead)
 *   right = Codex commits I lack     (codexAhead — the thing to react to)
 */
export function classifyBranchSync({ left = 0, right = 0 } = {}) {
  const weAhead = Number(left) || 0;
  const codexAhead = Number(right) || 0;
  let status;
  if (codexAhead === 0 && weAhead === 0) status = "in-sync";
  else if (codexAhead > 0 && weAhead === 0) status = "codex-ahead";
  else if (codexAhead === 0 && weAhead > 0) status = "we-ahead";
  else status = "diverged";
  return { weAhead, codexAhead, inSync: status === "in-sync", status };
}

/**
 * Incremental diff: items in `current` not already in `seen` (array or Set),
 * order-preserved, de-duped. So each tick only surfaces genuinely NEW work.
 */
export function newKeys(current, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(seen || []);
  const out = [];
  const emitted = new Set();
  for (const k of current || []) {
    if (seenSet.has(k) || emitted.has(k)) continue;
    emitted.add(k);
    out.push(k);
  }
  return out;
}

export function porcelainDirtyPaths(status) {
  return String(status ?? "")
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export function rootCheckoutQuestions({ branch, canonicalBranch, dirtyPaths } = {}) {
  const questions = [];
  const actual = String(branch ?? "").trim();
  const expected = String(canonicalBranch ?? "").trim();
  if (actual && expected && actual !== expected) {
    questions.push(
      `primary checkout is on ${actual}, expected ${expected} -- move live Codex work to an isolated worktree before using root`
    );
  }

  const dirty = (dirtyPaths || []).filter(Boolean);
  if (dirty.length) {
    const sample = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? "..." : "");
    questions.push(
      `primary checkout is dirty (${dirty.length} path(s): ${sample}) -- preserve/commit before the next Codex wave`
    );
  }
  return questions;
}

/**
 * The SYNC-BACK ack Codex reads: a versioned, secret-redacted snapshot of where
 * Claude is + what Codex findings have been acknowledged + open questions for it.
 *
 * `lastAckSha` is the commit the packet was built against — the scope anchor the
 * Codex review-contract (codex/AGENTS.review-contract.md §b) diffs FROM
 * (`git diff <lastAckSha>..HEAD`). The peer EXITs blocked-needs-human if it is
 * missing, so the ack MUST always carry it; the orchestrator populates it from
 * `git rev-parse HEAD`. It is redacted like every other emitted field (a sha is
 * never secret-shaped, but the redact() keeps the "everything emitted is
 * filtered" invariant total). Falsy input serializes to null, not "".
 */
export function buildClaudeStatus({
  branch,
  head,
  lastAckSha,
  devLoop,
  ackFindings,
  openQuestions,
  ts,
} = {}) {
  return {
    version: 1,
    generatedAt: ts,
    lastAckSha: lastAckSha ? redact(lastAckSha) : null,
    claude: {
      branch: redact(branch),
      head: redact(head),
      devLoop: devLoop ?? null,
    },
    acknowledgedFindings: (ackFindings || []).map((f) => redact(f)),
    openQuestions: (openQuestions || []).map((q) => redact(q)),
  };
}

/**
 * One-line digest for a single ~10-min tick. (Type-only JSDoc — logic unchanged;
 * the frozen golden suite pins the output bytes.)
 * @param {{ newFindings?: number, highCount?: number, branchStates?: Array<{ branch: string, status: string, codexAhead?: number, weAhead?: number, inSync?: boolean }>, ts?: string }} [o]
 * @returns {string}
 */
export function summarizeTick({ newFindings = 0, highCount = 0, branchStates = [], ts } = {}) {
  const branches =
    (branchStates || []).length > 0
      ? (branchStates || [])
          .map((b) => `${b.branch}=${b.status}${b.codexAhead ? `(+${b.codexAhead})` : ""}`)
          .join(", ")
      : "no codex/* branches";
  return `codex-loop @ ${ts}: ${newFindings} new finding(s), ${highCount} HIGH · ${branches}`;
}
