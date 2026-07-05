// PACK-SIDE SHIM CONTRACT — the pack core must export the exact public surface
// that downstream re-export shims (e.g. a host-side
// re-export shim) depend on.
//
// This test is PACK-INTERNAL and imports ONLY the pack core — it never reaches
// into any consumer repo, so the pack stays self-contained (no pack → consumer
// dependency). The consumer-side parity assertion (shim actually re-exports
// these same objects) lives in the consumer repo, as a consumer → pack test.
//
// Together the two guarantee: the pack promises a stable surface here, and each
// consumer proves its shim honors it there.

import { describe, it, expect } from "vitest";
import * as coreNs from "../core/codex-bridge.mjs";

// Module namespaces aren't string-indexable under noImplicitAny; view as a record.
const core = coreNs as unknown as Record<string, unknown>;

const EXPECTED = [
  "buildClaudeStatus",
  "classifyBranchSync",
  "newKeys",
  "parseRevListCount",
  "porcelainDirtyPaths",
  "redact",
  "rootCheckoutQuestions",
  "summarizeTick",
];

describe("pack core exposes the shimmable public surface", () => {
  it("exports exactly the expected set of functions", () => {
    const fns = Object.keys(core)
      .filter((k) => typeof core[k] === "function")
      .sort();
    expect(fns).toEqual(EXPECTED);
  });

  it("every promised symbol is callable", () => {
    for (const name of EXPECTED) {
      expect(typeof core[name]).toBe("function");
    }
  });
});
