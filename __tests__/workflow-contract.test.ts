// WORKFLOW CONTRACT GATE (ships with the pack).
//
// The two files under workflows/ run ONLY inside the Claude Code Workflow
// harness (globals agent()/parallel()/pipeline()/phase()/log() + an injected
// `args` binding). They are NOT node stdlib and CANNOT be executed under bare
// `npm test`. This is their automated coverage: parse each workflow AS TEXT and
// assert
//   (1) the required phases are declared;
//   (2) the config keys the wave requires are wired (from config/env, not a
//       hardcoded literal — in particular NO hardcoded repo);
//   (3) the ONLY imports are node:* + the harness globals — nothing else
//       (no provider SDK, no npm dep, no fetch/network import).
//
// dev-wave.js in particular has NO other automated coverage — this contract test
// is it (documented in the workflow header + the pack README).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const WF_DIR = join(PACK_DIR, "workflows");

const TRIAGE = readFileSync(join(WF_DIR, "pr-review-triage.js"), "utf8");
const DEVWAVE = readFileSync(join(WF_DIR, "dev-wave.js"), "utf8");

// Harness-provided globals a workflow may reference (these are NOT imports).
const HARNESS_GLOBALS = ["agent", "parallel", "pipeline", "phase", "log"];

/**
 * Collect every module specifier imported by a source file, static or dynamic:
 *   import … from '<spec>'   |   import '<spec>'   |   import('<spec>')
 * A workflow that is harness-only should have ZERO import specifiers (it uses
 * globals, not imports). Any specifier that is not a node: builtin is a leak.
 */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bimport\s+[^'"`]*?\bfrom\s+['"`]([^'"`]+)['"`]/g, // import … from '…'
    /\bimport\s+['"`]([^'"`]+)['"`]/g, // bare import '…'
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // dynamic import('…')
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // require('…')
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

function assertOnlyNodeBuiltins(src: string, name: string) {
  const specs = importSpecifiers(src);
  const nonBuiltin = specs.filter((s) => !s.startsWith("node:"));
  expect(nonBuiltin, `${name} imports non-node: specifiers: ${JSON.stringify(nonBuiltin)}`).toEqual([]);
}

describe("workflow-contract: pr-review-triage.js", () => {
  it("declares the four required phases", () => {
    for (const p of ["Collect", "Triage", "Re-gate", "Ledger"]) {
      expect(TRIAGE).toContain(`phase('${p}')`);
    }
  });

  it("resolves REPO from `gh repo view` — NO hardcoded repo literal", () => {
    expect(TRIAGE).toContain("gh repo view");
    // The old hardcoded origin repo must be entirely absent from the pack copy.
    // Needle assembled from fragments so this assertion does not itself trip the
    // fleet-hygiene scanner (same self-exemption trick pack-hygiene uses).
    // Split the owner token itself so the denylisted owner name never appears
    // verbatim in this file (which would itself trip the fleet-hygiene scanner).
    const OLD_REPO_LITERAL = ["fratil", "anico"].join("") + "/quotic-AI-Agents";
    expect(TRIAGE).not.toContain(OLD_REPO_LITERAL);
    expect(TRIAGE).not.toMatch(/args\?\.repo\s*\|\|\s*['"`][\w.-]+\/[\w.-]+['"`]/);
  });

  it("reads models, ledgerDir, bots, and the whole-sweep maxRounds cap from config/env", () => {
    expect(TRIAGE).toMatch(/CCL_LEDGER_DIR|ledgerDir/);
    expect(TRIAGE).toMatch(/CCL_TRIAGE_MAX_ROUNDS|maxRounds/);
    expect(TRIAGE).toMatch(/CCL_PR_BOTS|\bbots\b/);
    expect(TRIAGE).toMatch(/CCL_VERIFY_MODEL|models\?\.verify/);
    expect(TRIAGE).toMatch(/CCL_REGATE_MODEL|models\?\.regate/);
  });

  it("keeps the evaluator-first gate, terminal-verdict ledger rule, and exit states", () => {
    expect(TRIAGE).toContain("EVALUATOR-FIRST");
    expect(TRIAGE).toContain("TERMINAL_VERDICTS");
    expect(TRIAGE).toContain("blocked-needs-human"); // documented exit state
    expect(TRIAGE).toMatch(/quiet: true/);
    expect(TRIAGE).toMatch(/needsHuman/);
  });

  it("adds a whole-sweep round cap ATOP the per-fingerprint reflagged brake", () => {
    expect(TRIAGE).toMatch(/sweepRound/);
    expect(TRIAGE).toMatch(/capReached|>= MAX_ROUNDS|maxRounds/);
    expect(TRIAGE).toContain("reflagged"); // per-fingerprint 2-pass brake preserved
  });

  it("the whole-sweep cap is SELF-ENFORCING: reads+writes the sweep ledger, not just the arg (finding #6)", () => {
    // The sweep-round ledger must be BOTH read (to recover the prior count) and
    // written back (to persist the increment / quiet-reset), so the cap holds even
    // when the caller never passes --sweepRound.
    expect(TRIAGE).toContain("SWEEP_LEDGER");
    // A read of the ledger file up front (recover prior count).
    expect(TRIAGE).toMatch(/priorSweepRound/);
    expect(TRIAGE).toMatch(/Read the file \$\{SWEEP_LEDGER\}/);
    // A write-back helper that persists the counter.
    expect(TRIAGE).toMatch(/writeSweepRound/);
    expect(TRIAGE).toMatch(/Write the file \$\{SWEEP_LEDGER\}/);
    // The new count is derived from the PERSISTED prior, NOT from a trusted
    // caller-supplied round: the old `Number(args?.sweepRound ?? 0) + 1` form
    // (which looped unbounded when the arg was omitted) must be gone.
    expect(TRIAGE).toMatch(/Number\(priorSweepRound\)\s*\+\s*1/);
    expect(TRIAGE).not.toMatch(/Number\(args\?\.sweepRound\s*\?\?\s*0\)\s*\+\s*1/);
    // A quiet round resets the persisted counter to 0.
    expect(TRIAGE).toMatch(/writeSweepRound\(0\)/);
  });

  it("imports nothing outside node:* (uses harness globals only)", () => {
    assertOnlyNodeBuiltins(TRIAGE, "pr-review-triage.js");
  });

  it("references the harness globals it depends on", () => {
    for (const g of ["agent", "phase", "pipeline"]) {
      expect(TRIAGE).toContain(`${g}(`);
    }
  });

  it("carries the harness-only execution header", () => {
    expect(TRIAGE.toUpperCase()).toContain("HARNESS-ONLY EXECUTION");
    // Strip comment prefixes + collapse whitespace so a legitimately line-wrapped
    // header phrase (the meaning is contiguous) still matches.
    const norm = TRIAGE.replace(/\/\//g, " ").replace(/\s+/g, " ");
    expect(norm).toMatch(/not runnable under bare `npm test`/i);
  });
});

describe("workflow-contract: dev-wave.js", () => {
  it("declares the four required phases", () => {
    for (const p of ["TDD-red", "Implement", "Verify", "Review"]) {
      expect(DEVWAVE).toContain(`phase('${p}')`);
    }
  });

  it("keeps the 3-lens checker (safety / silent-failure / correctness), generically worded", () => {
    expect(DEVWAVE).toMatch(/silent-failure/);
    expect(DEVWAVE).toMatch(/correctness/);
    expect(DEVWAVE).toMatch(/safety-guard|safetyLens|SAFETY_LENS/);
    // Vertical/product specifics must be stripped from the generic pack.
    expect(DEVWAVE).not.toMatch(/Lianta/i);
    expect(DEVWAVE).not.toMatch(/112\/emergency/);
    expect(DEVWAVE).not.toMatch(/DAL chokepoint/i);
    expect(DEVWAVE).not.toMatch(/__tests__\/voice/);
  });

  it("reads checks / lenses / models from config", () => {
    expect(DEVWAVE).toMatch(/cfg\.checks|a\.checks/);
    expect(DEVWAVE).toMatch(/cfg\.lenses|a\.lenses/);
    expect(DEVWAVE).toMatch(/implementHard/);
    expect(DEVWAVE).toMatch(/implementStd/);
  });

  it("preserves maker/checker separation and never commits", () => {
    expect(DEVWAVE.toUpperCase()).toContain("MAKER/CHECKER");
    expect(DEVWAVE).toContain("Never commit");
  });

  it("imports nothing outside node:* (uses harness globals only)", () => {
    assertOnlyNodeBuiltins(DEVWAVE, "dev-wave.js");
  });

  it("references the harness globals it depends on", () => {
    for (const g of ["agent", "phase", "parallel"]) {
      expect(DEVWAVE).toContain(`${g}(`);
    }
  });

  it("carries the harness-only execution header naming its contract-test coverage", () => {
    expect(DEVWAVE.toUpperCase()).toContain("HARNESS-ONLY EXECUTION");
    expect(DEVWAVE).toContain("workflow-contract.test.ts");
  });
});

describe("workflow-contract: harness globals are not shadowed by an import", () => {
  it("neither workflow imports a name that collides with a harness global", () => {
    for (const [name, src] of [["triage", TRIAGE], ["dev-wave", DEVWAVE]] as const) {
      for (const g of HARNESS_GLOBALS) {
        // A harness global must never be provided by an import (which the harness
        // eval context cannot satisfy anyway) — assert none is imported.
        const re = new RegExp(`import\\s+(?:\\{[^}]*\\b${g}\\b[^}]*\\}|${g})\\s+from`);
        expect(src, `${name} must not import harness global ${g}`).not.toMatch(re);
      }
    }
  });
});
