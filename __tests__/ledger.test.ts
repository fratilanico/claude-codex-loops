// LEDGER — pure fingerprint + JSONL trace-line tests.
//
// The fingerprint format is LOAD-BEARING: it must match pr-review-triage.js so
// the shipped ledgers (docs/reviews/pr-*.json) still parse and dedupe. The
// golden trace-line snapshot pins the JSONL line bytes (fixed key order) so a
// fork cannot silently reshape the trace.

import { describe, it, expect } from "vitest";
import {
  fingerprint,
  traceLine,
  passCount,
  rotationDecision,
  BRAKE_TERMINALS,
  DEFAULT_MAX_BYTES,
  DEFAULT_KEEP,
} from "../core/ledger.mjs";

describe("fingerprint — triage-format compatibility", () => {
  it("builds <surface>|<path>|<first 120 chars, whitespace-collapsed>", () => {
    expect(
      fingerprint({
        surface: "inline",
        path: "src/lib/data-access.ts",
        body: "auth check missing on the admin route",
      })
    ).toBe("inline|src/lib/data-access.ts|auth check missing on the admin route");
  });

  it("collapses every run of whitespace (newlines, tabs, doubles) to a single space", () => {
    const fp = fingerprint({
      surface: "review",
      path: "a.ts",
      body: "line one\n   line   two\t\tline three",
    });
    expect(fp).toBe("review|a.ts|line one line two line three");
  });

  it("truncates the body to the first 120 chars AFTER collapsing", () => {
    const body = "x ".repeat(200); // 400 chars pre-collapse → "x x x …"
    const fp = fingerprint({ surface: "issue", path: "-", body });
    const bodyPart = fp.split("|")[2];
    expect(bodyPart.length).toBe(120);
    expect(bodyPart).toBe("x ".repeat(60).slice(0, 120));
  });

  it("missing surface/path become '-' (matches the triage '-' sentinel)", () => {
    expect(fingerprint({ body: "orphan finding" })).toBe("-|-|orphan finding");
    expect(fingerprint({ surface: "inline", body: "no path" })).toBe("inline|-|no path");
    expect(fingerprint({})).toBe("-|-|");
  });

  it("reproduces a fingerprint byte-identical to a shipped triage ledger entry", () => {
    // From docs/reviews/pr-164-triage.json (a real shipped ledger). The workflow
    // built it as surface|path|first-120-collapsed. Rebuilding from the parts must
    // yield the SAME string, proving the ledger still dedupes against our output.
    const shipped =
      "paste|__tests__/plan/enterprise-delivery-plan.test.ts|resolving the YAML path from process.cwd() makes it dependent on where Vitest is launched";
    const [surface, path, body] = splitFp(shipped);
    // The shipped body is already ≤120 and single-spaced, so a round-trip is exact.
    expect(fingerprint({ surface, path, body })).toBe(shipped);
    expect(body.length).toBeLessThanOrEqual(120);
  });

  it("is deterministic and order-stable for the same finding", () => {
    const f = { surface: "inline", path: "x.ts", body: "  a   b  " };
    expect(fingerprint(f)).toBe(fingerprint({ ...f }));
    expect(fingerprint(f)).toBe("inline|x.ts|a b");
  });
});

// Split a fingerprint into its 3 parts (surface | path | body) — the body may
// itself be empty but never contains a pipe in these fixtures.
function splitFp(fp: string): [string, string, string] {
  const i1 = fp.indexOf("|");
  const i2 = fp.indexOf("|", i1 + 1);
  return [fp.slice(0, i1), fp.slice(i1 + 1, i2), fp.slice(i2 + 1)];
}

describe("traceLine — golden JSONL snapshot", () => {
  it("renders a fixed-key-order JSONL line for a turn flip", () => {
    const line = traceLine({
      ts: "2026-07-04T00:00:00.000Z",
      thread: "pr-200",
      event: "turn-complete",
      from: "claude-turn",
      to: "codex-turn",
      round: 0,
      maxRounds: 4,
    });
    // Golden: exact byte string, fixed key order, brakeFired=false (clean flip).
    expect(line).toBe(
      '{"ts":"2026-07-04T00:00:00.000Z","thread":"pr-200","event":"turn-complete","from":"claude-turn","to":"codex-turn","round":0,"maxRounds":4,"brakeFired":false,"reason":null,"detail":null}'
    );
    // It is valid JSON.
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("marks brakeFired=true when transitioning INTO a brake terminal", () => {
    const line = traceLine({
      ts: "2026-07-04T01:02:03.000Z",
      thread: "pr-200",
      event: "no-progress",
      from: "codex-turn",
      to: "no-progress",
      round: 2,
      maxRounds: 4,
      reason: "same findings survived a full round",
    });
    expect(line).toBe(
      '{"ts":"2026-07-04T01:02:03.000Z","thread":"pr-200","event":"no-progress","from":"codex-turn","to":"no-progress","round":2,"maxRounds":4,"brakeFired":true,"reason":"same findings survived a full round","detail":null}'
    );
    expect(JSON.parse(line).brakeFired).toBe(true);
  });

  it("clean exits (converged/quiet) are NOT brake-fired", () => {
    for (const to of ["converged", "quiet"]) {
      const rec = JSON.parse(traceLine({ ts: "t", thread: "x", event: to, to }));
      expect(rec.brakeFired).toBe(false);
    }
    // max-rounds / stale / no-progress / blocked-needs-human / disabled ARE brakes.
    for (const to of BRAKE_TERMINALS) {
      const rec = JSON.parse(traceLine({ ts: "t", thread: "x", event: to as string, to: to as string }));
      expect(rec.brakeFired).toBe(true);
    }
  });

  it("brakeFired is DERIVED from `to`, never trusted from the input", () => {
    // Caller lies (brakeFired:false on a stale exit) — traceLine overrides it.
    const rec = JSON.parse(
      traceLine({ ts: "t", thread: "x", event: "stale", to: "stale", brakeFired: false } as any)
    );
    expect(rec.brakeFired).toBe(true);
  });

  it("emits keys in the fixed canonical order even when fields are omitted", () => {
    const rec = JSON.parse(traceLine({ event: "start" }));
    expect(Object.keys(rec)).toEqual([
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
  });
});

describe("passCount — per-fingerprint repair passes from the trace", () => {
  const fp = "inline|a.ts|finding one";
  const trace = [
    traceLine({ ts: "1", thread: "t", event: "turn-complete", detail: fp, to: "codex-turn" }),
    traceLine({ ts: "2", thread: "t", event: "turn-complete", detail: fp, to: "claude-turn" }),
    traceLine({ ts: "3", thread: "t", event: "turn-complete", detail: "inline|b.ts|other", to: "codex-turn" }),
    traceLine({ ts: "4", thread: "t", event: "converged", detail: fp, to: "converged" }), // not a turn-complete
    "this is a corrupt line {not json",
    "",
  ].join("\n");

  it("counts only turn-complete lines whose detail names the fingerprint", () => {
    expect(passCount(trace, fp)).toBe(2);
    expect(passCount(trace, "inline|b.ts|other")).toBe(1);
    expect(passCount(trace, "inline|z.ts|never")).toBe(0);
  });

  it("fail-soft: corrupt JSONL lines are skipped, never throw", () => {
    expect(() => passCount(trace, fp)).not.toThrow();
    expect(passCount("", fp)).toBe(0);
    expect(passCount(null as any, fp)).toBe(0);
    expect(passCount(trace, "")).toBe(0);
  });
});

describe("rotationDecision — 1MB / keep-2 policy (pure)", () => {
  it("defaults are 1 MB and keep 2", () => {
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024);
    expect(DEFAULT_KEEP).toBe(2);
  });

  it("does not rotate an empty/new file", () => {
    expect(rotationDecision(0, 5000)).toMatchObject({ rotate: false });
  });

  it("rotates when the append would push past maxBytes", () => {
    expect(rotationDecision(DEFAULT_MAX_BYTES - 10, 100).rotate).toBe(true);
    expect(rotationDecision(DEFAULT_MAX_BYTES - 10, 5).rotate).toBe(false); // still fits
  });

  it("honors custom maxBytes/keep and clamps junk", () => {
    expect(rotationDecision(200, 100, { maxBytes: 250, keep: 3 })).toEqual({
      rotate: true,
      keep: 3,
      maxBytes: 250,
    });
    expect(rotationDecision(10, 10, { maxBytes: -1, keep: -1 })).toMatchObject({
      keep: DEFAULT_KEEP,
      maxBytes: DEFAULT_MAX_BYTES,
    });
  });
});
