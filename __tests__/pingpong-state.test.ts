// PING-PONG STATE MACHINE — pure transition + brake tests.
//
// Proves the safety-spine invariants of core/pingpong-state.mjs directly (the
// loop-safety.test.ts file proves the same invariants hold end-to-end from the
// bin entrypoints). Covered here: monotone round, sticky terminals, the
// no-progress brake, corrupt-state → blocked-needs-human, the ferry-never-flips
// law, and the ≤ 2·maxRounds model-turn corollary.

import { describe, it, expect } from "vitest";
import {
  advance,
  initState,
  terminal,
  isTerminal,
  isActive,
  isCorrupt,
  detectNoProgress,
  brakes,
  applyBrakes,
  applyExitState,
  ACTIVE_PHASES,
  EXIT_STATES,
  SAFE_TERMINAL,
} from "../core/pingpong-state.mjs";

// Drive a thread from idle through N completed rounds, returning the trail of
// states. `turn-complete` is the ONLY event that flips a turn.
function runRounds(maxRounds: number) {
  let s: any = initState(maxRounds);
  const trail = [{ ...s }];
  s = advance(s, "start"); // idle → claude-turn
  trail.push({ ...s });
  // Keep completing turns until we hit a terminal or a hard safety ceiling.
  let guard = 0;
  while (!isTerminal(s) && guard < 1000) {
    s = advance(s, "turn-complete");
    trail.push({ ...s });
    guard++;
  }
  return { final: s, trail };
}

describe("initState / vocabulary", () => {
  it("starts idle, active, round 0, with a clamped maxRounds", () => {
    const s = initState(4);
    expect(s).toMatchObject({ status: "active", phase: "idle", round: 0, maxRounds: 4 });
    expect(isActive(s)).toBe(true);
    expect(isTerminal(s)).toBe(false);
  });

  it("clamps maxRounds into 1..20 (defense-in-depth)", () => {
    expect(initState(0).maxRounds).toBe(1);
    expect(initState(-5).maxRounds).toBe(1);
    expect(initState(999).maxRounds).toBe(20);
    expect(initState(NaN as any).maxRounds).toBe(4); // default
  });

  it("EXIT_STATES is the expected safety vocabulary (superset of the CCL-EXIT set)", () => {
    expect(EXIT_STATES).toEqual([
      "converged",
      "quiet",
      "max-rounds",
      "no-progress",
      "stale",
      "blocked-needs-human",
      "disabled",
    ]);
    // The peer-emitted CCL-EXIT vocabulary must all be terminals here.
    for (const ccl of ["converged", "quiet", "max-rounds", "no-progress", "blocked-needs-human"]) {
      expect(EXIT_STATES).toContain(ccl);
    }
    expect(ACTIVE_PHASES).toEqual(["idle", "claude-turn", "codex-turn"]);
  });
});

describe("turn flow — the ferry never flips; only a completed turn does", () => {
  it("start moves idle → claude-turn; a completed claude turn → codex-turn (round unchanged)", () => {
    let s: any = initState(4);
    s = advance(s, "start");
    expect(s.phase).toBe("claude-turn");
    expect(s.round).toBe(0);
    s = advance(s, "turn-complete");
    expect(s.phase).toBe("codex-turn");
    expect(s.round).toBe(0); // a claude→codex handoff is NOT a full round
  });

  it("a completed codex turn closes a round (round++) and hands back to claude", () => {
    let s: any = initState(4);
    s = advance(s, "start"); // claude-turn, r0
    s = advance(s, "turn-complete"); // codex-turn, r0
    s = advance(s, "turn-complete"); // full round done → claude-turn, r1
    expect(s.phase).toBe("claude-turn");
    expect(s.round).toBe(1);
  });

  it("an unknown event is a NO-OP on an active state (never a re-arm, never a flip)", () => {
    let s: any = initState(4);
    s = advance(s, "start"); // claude-turn
    const before = { ...s };
    s = advance(s, "totally-unknown-event");
    expect(s).toEqual(before);
    // Repeated ferry wakes with no turn completion never move the turn.
    s = advance(s, "tick");
    s = advance(s, "poll");
    expect(s).toEqual(before);
  });
});

describe("round is MONOTONE and maxRounds → terminal", () => {
  it("round only ever increases across a run", () => {
    const { trail } = runRounds(4);
    const rounds = trail.map((s) => s.round);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]).toBeGreaterThanOrEqual(rounds[i - 1]);
    }
  });

  it("reaching maxRounds routes to EXIT{max-rounds} and STOPS", () => {
    const { final } = runRounds(4);
    expect(isTerminal(final)).toBe(true);
    expect(final.phase).toBe("max-rounds");
    expect(final.reason).toBe("max-rounds");
    expect(final.round).toBe(4);
  });

  it("COROLLARY: ≤ 2·maxRounds model turns per thread", () => {
    for (const mr of [1, 2, 3, 4, 7, 20]) {
      const { trail } = runRounds(mr);
      // Every state after the first `start` that we produced via a turn-complete
      // corresponds to exactly one completed model turn. Count them.
      const turnCompletions = trail.length - 2; // minus the initial idle + the `start` step
      expect(turnCompletions).toBeLessThanOrEqual(2 * mr);
      // And it should be exactly 2·mr for maxRounds>=1 (claude+codex each round,
      // with the final codex completion tipping into max-rounds).
      expect(turnCompletions).toBe(2 * mr);
    }
  });
});

describe("STICKY terminals — once exited, never re-init", () => {
  it("every event (incl. start) is a no-op on a terminal state", () => {
    for (const reason of EXIT_STATES) {
      const t = terminal(reason, { round: 3, maxRounds: 4 });
      for (const ev of [
        "start",
        "turn-complete",
        "converged",
        "quiet",
        "no-progress",
        "stale",
        "blocked",
        "disable",
        "garbage",
      ]) {
        const after = advance(t, ev);
        expect(after.status).toBe("exited");
        expect(after.phase).toBe(reason);
        expect(after.reason).toBe(reason);
        expect(after.round).toBe(3);
      }
    }
  });

  it("a terminal cannot be walked back to an active phase", () => {
    let s: any = terminal("converged", { round: 2, maxRounds: 4 });
    s = advance(s, "start");
    s = advance(s, "turn-complete");
    expect(isActive(s)).toBe(false);
    expect(isTerminal(s)).toBe(true);
    expect(s.phase).toBe("converged");
  });
});

describe("direct exit / escalation events + kill switch precedence", () => {
  it("each escalation event maps to its terminal from an active phase", () => {
    const cases: Array<[string, string]> = [
      ["converged", "converged"],
      ["quiet", "quiet"],
      ["no-progress", "no-progress"],
      ["stale", "stale"],
      ["blocked", "blocked-needs-human"],
      ["disable", "disabled"],
    ];
    for (const [ev, expected] of cases) {
      let s: any = initState(4);
      s = advance(s, "start"); // claude-turn
      s = advance(s, ev);
      expect(isTerminal(s)).toBe(true);
      expect(s.phase).toBe(expected);
    }
  });

  it("disable wins from any active phase (kill switch honored first)", () => {
    for (const start of ["idle", "claude-turn", "codex-turn"]) {
      const s: any = { status: "active", phase: start, round: 1, maxRounds: 4 };
      const after = advance(s, "disable");
      expect(after.phase).toBe("disabled");
      expect(after.status).toBe("exited");
    }
  });
});

describe("CORRUPT / unknown state → blocked-needs-human (fail toward a human)", () => {
  const corrupt: any[] = [
    null,
    undefined,
    {},
    { status: "active" }, // no phase
    { status: "active", phase: "wat", round: 0, maxRounds: 4 }, // bad phase
    { status: "active", phase: "claude-turn", round: -1, maxRounds: 4 }, // bad round
    { status: "active", phase: "claude-turn", round: 0, maxRounds: 0 }, // bad maxRounds
    { status: "exited", phase: "not-a-terminal" }, // bogus terminal
    { status: "weird", phase: "claude-turn", round: 0, maxRounds: 4 }, // bad status
    "a string",
    42,
  ];

  it("isCorrupt flags every malformed state", () => {
    for (const c of corrupt) expect(isCorrupt(c)).toBe(true);
    expect(isCorrupt(initState(4))).toBe(false);
    expect(isCorrupt(terminal("quiet"))).toBe(false);
  });

  it("advance(corrupt, *) → sticky blocked-needs-human for ANY event", () => {
    for (const c of corrupt) {
      for (const ev of ["start", "turn-complete", "converged", "tick", "disable"]) {
        const after = advance(c, ev);
        expect(after.status).toBe("exited");
        expect(after.phase).toBe(SAFE_TERMINAL);
        expect(after.phase).toBe("blocked-needs-human");
      }
    }
  });

  it("the recovered terminal is itself sticky (does not thrash back to active)", () => {
    let s: any = advance({ status: "active", phase: "wat" }, "turn-complete");
    expect(s.phase).toBe("blocked-needs-human");
    s = advance(s, "start");
    expect(s.phase).toBe("blocked-needs-human");
    expect(isTerminal(s)).toBe(true);
  });
});

describe("detectNoProgress", () => {
  it("false with <2 rounds of history", () => {
    expect(detectNoProgress([])).toBe(false);
    expect(detectNoProgress([["a"]])).toBe(false);
    expect(detectNoProgress(null as any)).toBe(false);
  });

  it("true when the last two rounds carry an identical NON-EMPTY fingerprint set", () => {
    expect(detectNoProgress([["a", "b"], ["a", "b"]])).toBe(true);
    // order-independent (sets)
    expect(detectNoProgress([["b", "a"], ["a", "b"]])).toBe(true);
    // only the LAST two rounds matter
    expect(detectNoProgress([["x"], ["a", "b"], ["b", "a"]])).toBe(true);
    // accepts Set entries too
    expect(detectNoProgress([new Set(["a"]), new Set(["a"])])).toBe(true);
  });

  it("false when findings changed, shrank, grew, or both rounds are empty", () => {
    expect(detectNoProgress([["a", "b"], ["a"]])).toBe(false); // shrank (progress)
    expect(detectNoProgress([["a"], ["a", "b"]])).toBe(false); // grew
    expect(detectNoProgress([["a"], ["c"]])).toBe(false); // different
    expect(detectNoProgress([[], []])).toBe(false); // quiet, not stuck
    expect(detectNoProgress([["a", "b"], []])).toBe(false); // cleared (progress)
  });
});

describe("brakes() + applyBrakes()", () => {
  it("stale brake fires when ageHours ≥ staleAfterHours", () => {
    const s = initState(4);
    expect(brakes(s, { ageHours: 49, staleAfterHours: 48 })).toBe("stale");
    expect(brakes(s, { ageHours: 48, staleAfterHours: 48 })).toBe("stale");
    expect(brakes(s, { ageHours: 10, staleAfterHours: 48 })).toBe(null);
  });

  it("no-progress brake fires on two identical rounds (stale takes precedence)", () => {
    const s = advance(initState(4), "start");
    expect(brakes(s, { history: [["a"], ["a"]] })).toBe("no-progress");
    // stale wins if both would fire
    expect(
      brakes(s, { ageHours: 100, staleAfterHours: 48, history: [["a"], ["a"]] })
    ).toBe("stale");
  });

  it("returns null on terminals/corrupt (advance() owns those)", () => {
    expect(brakes(terminal("quiet"), { ageHours: 999, staleAfterHours: 1 })).toBe(null);
    expect(brakes(null as any, { history: [["a"], ["a"]] })).toBe(null);
  });

  it("applyBrakes routes a fired brake straight to its terminal", () => {
    const s = advance(initState(4), "start");
    const stale = applyBrakes(s, { ageHours: 100, staleAfterHours: 48 });
    expect(isTerminal(stale)).toBe(true);
    expect(stale.phase).toBe("stale");

    const noprog = applyBrakes(s, { history: [["a", "b"], ["a", "b"]] });
    expect(noprog.phase).toBe("no-progress");

    const keep = applyBrakes(s, { ageHours: 1, staleAfterHours: 48, history: [["a"]] });
    expect(keep).toBe(s); // unchanged when no brake fires
  });
});

describe("applyExitState — a peer CCL-EXIT advances the machine to the matching terminal", () => {
  it("maps each CCL-EXIT vocabulary token onto its sticky terminal from an active state", () => {
    // The peer never emits 'disabled' (local kill-switch only), so it is absent.
    const cases = ["converged", "quiet", "no-progress", "stale", "blocked-needs-human", "max-rounds"];
    for (const exitState of cases) {
      const active = advance(initState(4), "start"); // claude-turn
      const after = applyExitState(active, exitState);
      expect(isTerminal(after), `exit '${exitState}' must reach a terminal`).toBe(true);
      expect(after.phase).toBe(exitState); // terminal phase == the emitted state
      expect(after.reason).toBe(exitState);
    }
  });

  it("routes blocked-needs-human via the 'blocked' event (name differs from the state)", () => {
    const after = applyExitState(advance(initState(4), "start"), "blocked-needs-human");
    expect(after.phase).toBe("blocked-needs-human");
    expect(after.status).toBe("exited");
  });

  it("is STICKY — a later exit never overwrites or revives a finished thread", () => {
    const converged = applyExitState(advance(initState(4), "start"), "converged");
    expect(converged.phase).toBe("converged");
    // A subsequent, different peer exit must NOT change the already-terminal thread.
    const again = applyExitState(converged, "blocked-needs-human");
    expect(again.phase).toBe("converged");
    expect(isTerminal(again)).toBe(true);
  });

  it("a corrupt state fails safe to blocked-needs-human regardless of the exit token", () => {
    for (const exitState of ["converged", "quiet", "max-rounds"]) {
      const after = applyExitState({ nonsense: true } as any, exitState);
      expect(after.phase).toBe("blocked-needs-human");
      expect(isTerminal(after)).toBe(true);
    }
  });

  it("an unknown/absent exit token is a NO-OP on an active state (never a re-arm)", () => {
    const active = advance(initState(4), "start");
    expect(applyExitState(active, "totally-unknown")).toEqual(active);
    expect(applyExitState(active, null as any)).toEqual(active);
    expect(applyExitState(active, undefined as any)).toEqual(active);
  });

  it("does not mutate its input state", () => {
    const active = advance(initState(4), "start");
    const frozen = Object.freeze({ ...active });
    const after = applyExitState(frozen, "converged");
    expect(frozen.phase).toBe("claude-turn"); // unchanged
    expect(after).not.toBe(frozen);
    expect(after.phase).toBe("converged");
  });
});

describe("PURITY — advance never mutates its input", () => {
  it("input state is unchanged after advance", () => {
    const s = initState(4);
    const frozen = Object.freeze({ ...s });
    const after = advance(frozen, "start");
    expect(frozen).toEqual({ status: "active", phase: "idle", round: 0, maxRounds: 4 });
    expect(after).not.toBe(frozen);
    expect(after.phase).toBe("claude-turn");
  });
});
