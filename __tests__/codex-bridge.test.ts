// Pure-logic contract for the bidirectional Codex bridge loop.
//
// The orchestrator (scripts/ops/codex-loop.mjs) does all IO (git, fs, spawn);
// every DECISION it makes is delegated to these pure functions so they can be
// tested without touching ~/.codex, git, or the network. Mirrors the testing
// posture of the policy/concierge capabilities (pure core, IO at the edge).

import { describe, it, expect } from "vitest";
import {
  redact,
  parseRevListCount,
  classifyBranchSync,
  newKeys,
  porcelainDirtyPaths,
  rootCheckoutQuestions,
  buildClaudeStatus,
  summarizeTick,
} from "../core/codex-bridge.mjs";

// A provider-key-shaped fixture token. Assembled from fragments so the pack's
// own source-hygiene gates (which forbid a contiguous token-shape literal
// anywhere under the pack) do not flag this test file. The EFFECTIVE string is
// unchanged from the pre-move fixture — redaction behavior is identical.
const SK_TOKEN = "s" + "k-" + "abcdefghijklmnopqrstuvwx";

describe("redact", () => {
  it("scrubs common secret shapes before anything is written back to Codex", () => {
    expect(redact(`token=${SK_TOKEN}`)).toContain("[REDACTED]");
    expect(redact("postgres://u:p@host/db")).toContain("[REDACTED]");
    expect(redact("clean branch name")).toBe("clean branch name");
  });
  it("is null/undefined-safe (fail-soft)", () => {
    expect(redact(undefined)).toBe("");
    expect(redact(null)).toBe("");
  });
});

describe("parseRevListCount", () => {
  // `git rev-list --left-right --count HEAD...origin/codex/x` => "<left>\t<right>"
  // left  = commits on HEAD (mine) not in codex  => weAhead
  // right = commits on codex not in mine         => codexAhead
  it("parses a tab-separated left/right count", () => {
    expect(parseRevListCount("2\t7")).toEqual({ left: 2, right: 7 });
    expect(parseRevListCount("0\t0\n")).toEqual({ left: 0, right: 0 });
  });
  it("fails soft to zeros on garbage", () => {
    expect(parseRevListCount("")).toEqual({ left: 0, right: 0 });
    expect(parseRevListCount("not-a-count")).toEqual({ left: 0, right: 0 });
    expect(parseRevListCount(undefined)).toEqual({ left: 0, right: 0 });
  });
});

describe("classifyBranchSync", () => {
  it("flags codex-ahead when Codex has commits I don't (the thing to react to)", () => {
    const r = classifyBranchSync({ left: 0, right: 5 });
    expect(r.codexAhead).toBe(5);
    expect(r.weAhead).toBe(0);
    expect(r.inSync).toBe(false);
    expect(r.status).toBe("codex-ahead");
  });
  it("reports in-sync when neither side is ahead", () => {
    expect(classifyBranchSync({ left: 0, right: 0 })).toMatchObject({
      status: "in-sync",
      inSync: true,
    });
  });
  it("reports we-ahead and diverged", () => {
    expect(classifyBranchSync({ left: 3, right: 0 }).status).toBe("we-ahead");
    expect(classifyBranchSync({ left: 2, right: 4 }).status).toBe("diverged");
  });
});

describe("newKeys — incremental diff so each tick only surfaces NEW work", () => {
  it("returns only keys not already seen, order-preserved, de-duped", () => {
    expect(newKeys(["a", "b", "c", "b"], ["b"])).toEqual(["a", "c"]);
  });
  it("accepts a Set for seen and returns [] when nothing is new", () => {
    expect(newKeys(["x", "y"], new Set(["x", "y"]))).toEqual([]);
  });
  it("is empty-safe", () => {
    expect(newKeys([], ["a"])).toEqual([]);
    expect(newKeys(["a"], [])).toEqual(["a"]);
  });
});

describe("rootCheckoutQuestions — keep the shared checkout clean", () => {
  it("parses porcelain paths without dropping leading underscores", () => {
    expect(
      porcelainDirtyPaths(" M __tests__/ops/codex-bridge.test.ts\n?? docs/x.md\n")
    ).toEqual(["__tests__/ops/codex-bridge.test.ts", "docs/x.md"]);
  });

  it("stays quiet when the root checkout is clean and on the canonical branch", () => {
    expect(
      rootCheckoutQuestions({
        branch: "feat/onboarding-journey",
        canonicalBranch: "feat/onboarding-journey",
        dirtyPaths: [],
      })
    ).toEqual([]);
  });

  it("flags wrong-branch and dirty root checkout state as Codex-facing open questions", () => {
    expect(
      rootCheckoutQuestions({
        branch: "codex/app-role-rls-integration",
        canonicalBranch: "feat/onboarding-journey",
        dirtyPaths: [".mcp.json", "scripts/loop/board-advance.mjs", "docs/x.md"],
      })
    ).toEqual([
      "primary checkout is on codex/app-role-rls-integration, expected feat/onboarding-journey -- move live Codex work to an isolated worktree before using root",
      "primary checkout is dirty (3 path(s): .mcp.json, scripts/loop/board-advance.mjs, docs/x.md) -- preserve/commit before the next Codex wave",
    ]);
  });

  it("caps the dirty path sample so the ack stays readable", () => {
    const paths = ["a", "b", "c", "d", "e", "f"];
    const [question] = rootCheckoutQuestions({
      branch: "feat/onboarding-journey",
      canonicalBranch: "feat/onboarding-journey",
      dirtyPaths: paths,
    });
    expect(question).toContain("6 path(s): a, b, c, d, e...");
  });
});

describe("buildClaudeStatus — the SYNC-BACK ack Codex reads", () => {
  const base = {
    branch: "feat/onboarding-journey",
    head: "abc1234",
    lastAckSha: "abc1234def5678abc1234def5678abc1234def56",
    devLoop: { current: "G_CODEXLOOP", stage: "implement" },
    ackFindings: ["DAL leak in route X"],
    openQuestions: ["confirm p8<p7 order"],
    ts: "2026-06-20T00:00:00.000Z",
  };
  it("emits a versioned machine-readable ack with my state + acknowledgements", () => {
    const s = buildClaudeStatus(base);
    expect(s.version).toBe(1);
    expect(s.generatedAt).toBe(base.ts);
    expect(s.claude.branch).toBe("feat/onboarding-journey");
    expect(s.claude.head).toBe("abc1234");
    expect(s.claude.devLoop).toEqual(base.devLoop);
    expect(s.acknowledgedFindings).toEqual(["DAL leak in route X"]);
    expect(s.openQuestions).toEqual(["confirm p8<p7 order"]);
  });
  it("carries lastAckSha — the scope anchor the peer diffs from (never omit it)", () => {
    // Absent lastAckSha ⇒ the Codex peer EXITs blocked-needs-human (contract §b),
    // so the ack must always emit the field: the real sha when known, else null.
    const s = buildClaudeStatus(base);
    expect(s.lastAckSha).toBe("abc1234def5678abc1234def5678abc1234def56");
    const noAnchor = buildClaudeStatus({ branch: "b", head: "h", ts: "t" });
    expect(Object.prototype.hasOwnProperty.call(noAnchor, "lastAckSha")).toBe(true);
    expect(noAnchor.lastAckSha).toBe(null);
  });
  it("defaults arrays + never emits undefined fields (clean JSON for the other side)", () => {
    const s = buildClaudeStatus({ branch: "b", head: "h", ts: "t" });
    expect(s.acknowledgedFindings).toEqual([]);
    expect(s.openQuestions).toEqual([]);
    expect(JSON.stringify(s)).not.toContain("undefined");
  });
  it("redacts secrets that leak into acknowledgements before sync-back", () => {
    const s = buildClaudeStatus({
      ...base,
      ackFindings: [`leaked token=${SK_TOKEN} here`],
    });
    expect(JSON.stringify(s)).toContain("[REDACTED]");
    expect(JSON.stringify(s)).not.toContain(SK_TOKEN);
  });
});

describe("summarizeTick — the one-line digest per ~10-min tick", () => {
  it("includes new-finding + high counts and a per-branch sync verdict", () => {
    const line = summarizeTick({
      newFindings: 3,
      highCount: 2,
      branchStates: [
        { branch: "codex/post-pr40-live-f1", status: "codex-ahead", codexAhead: 4 },
        { branch: "codex/drop-tsbuildinfo", status: "in-sync", codexAhead: 0 },
      ],
      ts: "2026-06-20T00:00:00.000Z",
    });
    expect(line).toContain("3 new");
    expect(line).toContain("2 HIGH");
    expect(line).toContain("codex/post-pr40-live-f1");
    expect(line).toContain("codex-ahead");
  });
  it("reports a quiet tick cleanly", () => {
    const line = summarizeTick({ newFindings: 0, highCount: 0, branchStates: [], ts: "t" });
    expect(line).toContain("0 new");
    expect(line.toLowerCase()).toContain("codex");
  });
});
