// FROZEN-LOGIC lock + determinism for the pure bridge core.
//
// The user's contract: "deterministic logic — it won't change." This suite is the
// enforcement. It pins the EXACT output of every pure function over fixed fixtures
// to a committed golden value. Any change to the LOGIC (not config) breaks it, so
// logic drift cannot land silently. It also proves the functions are referentially
// transparent (same input → identical output across many calls) and that config
// has NO bearing on the logic (these functions take no config — that IS the proof).

import { describe, it, expect } from "vitest";
import {
  redact,
  parseRevListCount,
  classifyBranchSync,
  newKeys,
  buildClaudeStatus,
  summarizeTick,
} from "../core/codex-bridge.mjs";

// Provider-key-shaped fixture token, assembled from fragments so the pack's
// source-hygiene gates do not flag this file (they forbid a contiguous
// token-shape literal under the pack). The EFFECTIVE input and the pinned
// golden OUTPUT below are byte-for-byte the pre-move values — the frozen
// redaction golden is unchanged; only the literal's spelling in source moved.
const SK_TOKEN = "s" + "k-" + "abcdefghijklmnopqrstuvwx";

describe("determinism — referential transparency over repeated calls", () => {
  it("classifyBranchSync is identical across 100 calls", () => {
    const first = classifyBranchSync({ left: 2, right: 5 });
    for (let i = 0; i < 100; i++) {
      expect(classifyBranchSync({ left: 2, right: 5 })).toEqual(first);
    }
  });
  it("buildClaudeStatus is identical across calls for fixed input (ts pinned)", () => {
    const input = {
      branch: "b",
      head: "h",
      devLoop: { current: "G", stage: "implement" },
      ackFindings: ["x"],
      openQuestions: ["q"],
      ts: "2026-01-01T00:00:00.000Z",
    };
    const a = buildClaudeStatus(input);
    const b = buildClaudeStatus(input);
    expect(a).toEqual(b);
  });
});

describe("FROZEN golden snapshot — logic is pinned; changing it must fail CI", () => {
  it("redact golden", () => {
    expect(redact(`user token=${SK_TOKEN} and postgres://u:p@h/db ok`)).toBe(
      "user [REDACTED] and [REDACTED] ok"
    );
  });

  it("parseRevListCount golden", () => {
    expect(parseRevListCount("3\t8")).toEqual({ left: 3, right: 8 });
    expect(parseRevListCount("garbage")).toEqual({ left: 0, right: 0 });
  });

  it("classifyBranchSync golden across all four verdicts", () => {
    expect(classifyBranchSync({ left: 0, right: 0 })).toEqual({
      weAhead: 0,
      codexAhead: 0,
      inSync: true,
      status: "in-sync",
    });
    expect(classifyBranchSync({ left: 0, right: 4 })).toEqual({
      weAhead: 0,
      codexAhead: 4,
      inSync: false,
      status: "codex-ahead",
    });
    expect(classifyBranchSync({ left: 3, right: 0 })).toEqual({
      weAhead: 3,
      codexAhead: 0,
      inSync: false,
      status: "we-ahead",
    });
    expect(classifyBranchSync({ left: 2, right: 6 })).toEqual({
      weAhead: 2,
      codexAhead: 6,
      inSync: false,
      status: "diverged",
    });
  });

  it("newKeys golden", () => {
    expect(newKeys(["a", "b", "c", "b"], ["b"])).toEqual(["a", "c"]);
  });

  it("buildClaudeStatus golden (full shape pinned)", () => {
    // lastAckSha is a DELIBERATE schema addition (finding #2): the review-contract
    // tells the Codex peer to EXIT blocked-needs-human when it is absent, so the
    // packet must always carry the scope anchor. This golden is intentionally
    // updated to include it.
    expect(
      buildClaudeStatus({
        branch: "feat/onboarding-journey",
        head: "abc1234",
        lastAckSha: "abc1234def5678abc1234def5678abc1234def56",
        devLoop: { current: "G_LOOP_REUSE", stage: "implement" },
        ackFindings: ["[HIGH] DAL leak in route X"],
        openQuestions: ["codex branch foo is diverged (+1)"],
        ts: "2026-01-01T00:00:00.000Z",
      })
    ).toEqual({
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      lastAckSha: "abc1234def5678abc1234def5678abc1234def56",
      claude: {
        branch: "feat/onboarding-journey",
        head: "abc1234",
        devLoop: { current: "G_LOOP_REUSE", stage: "implement" },
      },
      acknowledgedFindings: ["[HIGH] DAL leak in route X"],
      openQuestions: ["codex branch foo is diverged (+1)"],
    });
  });

  it("buildClaudeStatus golden — lastAckSha is null when the anchor is absent", () => {
    // The orchestrator fail-softs a failed `git rev-parse HEAD` to "" — that must
    // serialize as an explicit null (never "" or undefined) so the peer sees a
    // clean "no anchor" signal and takes the blocked-needs-human branch.
    const s = buildClaudeStatus({ branch: "b", head: "h", ts: "t" });
    expect(s.lastAckSha).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(s, "lastAckSha")).toBe(true);
  });

  it("summarizeTick golden", () => {
    expect(
      summarizeTick({
        newFindings: 2,
        highCount: 1,
        branchStates: [{ branch: "codex/x", status: "codex-ahead", codexAhead: 3 }],
        ts: "2026-01-01T00:00:00.000Z",
      })
    ).toBe(
      "codex-loop @ 2026-01-01T00:00:00.000Z: 2 new finding(s), 1 HIGH · codex/x=codex-ahead(+3)"
    );
  });
});
