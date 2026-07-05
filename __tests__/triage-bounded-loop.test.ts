// BOUNDED-LOOP GATE for the pr-review-triage whole-sweep cap.
//
// The triage loop has TWO independent brakes that together guarantee it cannot
// loop forever, even against a bot that re-flags the SAME finding every round:
//   1. per-fingerprint 2-pass brake — the SECOND time a fingerprint is seen
//      (reflagged), that pass is the LAST; a fix not clearly stronger → the
//      finding is escalated needs-human (a NON-terminal, so it is not deduped,
//      but it is routed to a human and no longer auto-fixed).
//   2. whole-sweep cap (NEW in W5) — a full collect→triage→re-gate sweep that is
//      not quiet increments a sweep-round counter; once it reaches
//      triage.maxRounds the loop is force-exited blocked-needs-human and must not
//      re-arm. A QUIET round resets the counter.
//
// The workflow (workflows/pr-review-triage.js) runs only in the harness, so it
// cannot be imported here. This gate instead pins the LAW the workflow encodes:
// it reproduces the workflow's exact whole-sweep decision as a pure predicate
// and proves that a bot which re-flags forever reaches blocked-needs-human
// within triage.maxRounds — using the SAME maxRounds the config module ships.

import { describe, it, expect } from "vitest";
import { loadConfig } from "../core/loop-config.mjs";

// EXACT reproduction of the workflow's whole-sweep decision (pr-review-triage.js
// Ledger phase): a non-quiet sweep bumps sweepRound; capReached when it hits
// maxRounds. `prevSweepRound` is the counter the workflow READS FROM ITS LEDGER at
// the start of each pass (finding #6: self-enforcing — NOT a caller-trusted arg),
// and the workflow WRITES the returned sweepRound back to that ledger. This
// mirrors the shipped code — if the workflow's rule changes, this predicate must
// change with it (workflow-contract.test.ts guards the presence of
// priorSweepRound / writeSweepRound / capReached in the workflow, so the two
// cannot silently diverge).
function sweepDecision(prevSweepRound: number, quiet: boolean, maxRounds: number) {
  if (quiet) return { exit: "quiet" as const, sweepRound: 0 };
  const sweepRound = Number(prevSweepRound ?? 0) + 1;
  const capReached = sweepRound >= maxRounds;
  return {
    exit: capReached ? ("blocked-needs-human" as const) : ("re-arm" as const),
    sweepRound,
  };
}

// A bot that re-flags forever ⇒ every collector sweep is NON-quiet. The ledger
// counter starts at 0 (fresh ledger) and is carried across passes purely via the
// PERSISTED value — modelling a caller that NEVER supplies --sweepRound, which was
// the exact unbounded case in finding #6. If the cap is honoured the loop MUST
// terminate blocked-needs-human before a hard iteration ceiling.
function runForeverReflaggingBot(maxRounds: number) {
  const HARD_CEILING = 1000; // fuse: proves termination is by the cap, not this
  let sweepRound = 0; // fresh ledger; no caller-supplied seed
  const trace: string[] = [];
  for (let i = 0; i < HARD_CEILING; i++) {
    // Each pass reads the PERSISTED prior (sweepRound), decides, then persists the
    // new value back — exactly the workflow's read-ledger → decide → write-ledger.
    const d = sweepDecision(sweepRound, /* quiet */ false, maxRounds);
    sweepRound = d.sweepRound;
    trace.push(d.exit);
    if (d.exit === "blocked-needs-human") {
      return { terminated: true, rounds: sweepRound, trace };
    }
  }
  return { terminated: false, rounds: sweepRound, trace };
}

describe("triage whole-sweep cap: a forever-reflagging bot is bounded", () => {
  it("uses the config-shipped triage.maxRounds (default 3, clamped 1..20)", () => {
    expect(loadConfig({}).triage.maxRounds).toBe(3);
  });

  it("reaches blocked-needs-human within triage.maxRounds", () => {
    const { maxRounds } = { maxRounds: loadConfig({}).triage.maxRounds };
    const r = runForeverReflaggingBot(maxRounds);
    expect(r.terminated).toBe(true);
    expect(r.rounds).toBe(maxRounds);
    expect(r.trace[r.trace.length - 1]).toBe("blocked-needs-human");
    // Every earlier round re-armed; only the last is the brake terminal.
    expect(r.trace.slice(0, -1).every((s) => s === "re-arm")).toBe(true);
  });

  it("honours an env override of the cap (CCL_TRIAGE_MAX_ROUNDS), still bounded", () => {
    const cfg = loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "5" });
    expect(cfg.triage.maxRounds).toBe(5);
    const r = runForeverReflaggingBot(cfg.triage.maxRounds);
    expect(r.terminated).toBe(true);
    expect(r.rounds).toBe(5);
  });

  it("clamps an absurd cap into 1..20 so it can never be disabled", () => {
    expect(loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "9999" }).triage.maxRounds).toBe(20);
    expect(loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "0" }).triage.maxRounds).toBe(1);
    const r = runForeverReflaggingBot(loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "9999" }).triage.maxRounds);
    expect(r.terminated).toBe(true);
    expect(r.rounds).toBe(20);
  });

  it("a QUIET sweep resets the counter (a productive loop is not penalised)", () => {
    const maxRounds = loadConfig({}).triage.maxRounds;
    // Two non-quiet sweeps, then a quiet one → counter back to 0.
    let sr = 0;
    sr = sweepDecision(sr, false, maxRounds).sweepRound; // 1
    sr = sweepDecision(sr, false, maxRounds).sweepRound; // 2
    const afterQuiet = sweepDecision(sr, true, maxRounds);
    expect(afterQuiet.exit).toBe("quiet");
    expect(afterQuiet.sweepRound).toBe(0);
  });
});
