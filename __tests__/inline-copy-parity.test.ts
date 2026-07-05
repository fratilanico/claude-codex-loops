// INLINE-COPY PARITY GATE (ships with the pack, runs in the split repo's CI and,
// via the host repo root include glob, in the host CI too).
//
// pr-review-triage.js runs inside the Claude Code Workflow harness, whose eval
// context CANNOT statically `import` sibling modules. So the workflow carries
// CONTRACT-IDENTICAL INLINE COPIES of three canonical core modules
// (parse-agent-json / collect-round / untrusted-body). This gate proves the
// inline copies have not drifted from core by sha256-comparing the NORMALIZED
// code of each inline block against the same declarations in its core module.
// ANY difference fails — a downstream fork cannot silently diverge.
//
// Normalization (applied identically to both sides) makes the compare robust to
// the two LEGITIMATE differences between a core module and its inline copy:
//   • the `export ` keyword (core exports; the inline copy does not);
//   • the `import { … } from './…'` line (core imports a sibling; the inline
//     copy relies on an earlier inline block instead).
// It also strips comment-only lines and blank lines so a comment reword does not
// fail the gate — the CODE is what must stay byte-identical. Everything else
// (identifiers, string literals, operators, whitespace within a code line) is
// compared verbatim.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PACK_DIR = join(__dirname, "..");
const WORKFLOW = join(PACK_DIR, "workflows", "pr-review-triage.js");
const CORE_DIR = join(PACK_DIR, "core");

// The inline blocks the workflow declares, keyed by the core module they mirror.
// Each block in the workflow is delimited by:
//   // … ccl:inline-copy <module>
//   … code …
//   // ccl:inline-copy-end <module>
const INLINE_MODULES = [
  "parse-agent-json.mjs",
  "collect-round.mjs",
  "untrusted-body.mjs",
];

/** Strip the two legitimate deltas + comments/blank lines, then join. */
function normalizeCode(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/^\s*export\s+/, "")) // core exports; inline does not
    .filter((line) => {
      const t = line.trim();
      if (t === "") return false; // blank line
      if (t.startsWith("//")) return false; // comment-only line
      if (/^import\s.*\sfrom\s+['"`]\.\/.*['"`];?$/.test(t)) return false; // sibling import
      return true;
    })
    .join("\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Extract the fenced inline block for a module from the workflow source. */
function extractInlineBlock(workflowSrc: string, moduleName: string): string {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `ccl:inline-copy ${escaped}\\s*\\n([\\s\\S]*?)\\n[^\\n]*ccl:inline-copy-end ${escaped}`,
  );
  const m = workflowSrc.match(re);
  if (!m) throw new Error(`inline block for ${moduleName} not found in workflow`);
  return m[1];
}

describe("inline-copy parity: workflow inline copies == core modules (sha256)", () => {
  const workflowSrc = readFileSync(WORKFLOW, "utf8");

  it("asserts the workflow DOES inline core helpers (so this gate is load-bearing)", () => {
    // If a future refactor removes the inline mechanic entirely, this gate would
    // be vacuous — assert the copies exist so their absence is a deliberate,
    // visible change, not silent.
    for (const mod of INLINE_MODULES) {
      expect(workflowSrc, `workflow must inline ${mod}`).toContain(`ccl:inline-copy ${mod}`);
    }
  });

  for (const mod of INLINE_MODULES) {
    it(`inline copy of ${mod} is byte-identical (normalized sha256) to core/${mod}`, () => {
      const inline = extractInlineBlock(workflowSrc, mod);
      const core = readFileSync(join(CORE_DIR, mod), "utf8");

      const inlineHash = sha256(normalizeCode(inline));
      const coreHash = sha256(normalizeCode(core));

      // Attach the normalized code to the failure so a drift is diffable in CI.
      expect(
        inlineHash,
        `inline copy of ${mod} drifted from core.\n--- inline (normalized) ---\n${normalizeCode(inline)}\n--- core (normalized) ---\n${normalizeCode(core)}`,
      ).toBe(coreHash);
    });
  }
});
