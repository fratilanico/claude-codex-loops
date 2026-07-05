// CODEX REVIEW-CONTRACT GATE (W7).
//
// The Codex -> Claude direction ships as a documented contract + a merge-safe
// SessionStart hook fragment (v0.1.0: no prompts/ or automations/). This test
// locks the two things that would silently break the loop if they drifted:
//
//   1. codex/AGENTS.review-contract.md must carry all SIX mandatory sections
//      (ack-read, scope-since-lastAckSha, CCL-FINDING output, redaction mirror,
//      bounded-one-pass exits, never-force-push/never-main) plus the bounded
//      exit-state vocabulary.
//   2. The CCL-FINDING / CCL-EXIT marker format the contract tells the Codex
//      peer to EMIT must MATCH what bin/watch-codex.mjs actually GREPS for. This
//      is a real cross-check: we lift the two regexes out of the parser source
//      and lift the example marker lines out of the contract, then run one
//      against the other. A drift in either file fails the test — they cannot
//      diverge by construction.
//   3. hooks/codex.hooks.fragment.json is valid JSON, marker-tagged for
//      selective uninstall, references NO absolute path, and never targets the
//      global ~/.codex/AGENTS.md.
//
// Home-path / global-agents needles are assembled from fragments so THIS test
// source never contains the literals it forbids.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const CONTRACT_PATH = join(PACK_DIR, "codex", "AGENTS.review-contract.md");
const FRAGMENT_PATH = join(PACK_DIR, "hooks", "codex.hooks.fragment.json");
const WATCH_PATH = join(PACK_DIR, "bin", "watch-codex.mjs");

const CONTRACT = readFileSync(CONTRACT_PATH, "utf8");
const FRAGMENT_RAW = readFileSync(FRAGMENT_PATH, "utf8");
const WATCH_SRC = readFileSync(WATCH_PATH, "utf8");

// Assembled so this source never contains the forbidden literal verbatim.
const HOME_PATH = "/Us" + "ers/";
const GLOBAL_AGENTS = "~/.co" + "dex/AGENTS.md";

// The bounded exit-state vocabulary the peer may emit. Mirrors the first five
// EXIT_STATES + blocked-needs-human (core/pingpong-state.mjs); `disabled` is a
// local-only terminal the peer never emits.
const EXIT_VOCAB = [
  "converged",
  "quiet",
  "max-rounds",
  "no-progress",
  "stale",
  "blocked-needs-human",
];

// ── helpers ───────────────────────────────────────────────────────────────────

// Extract the exact fenced block install.sh manages.
function fencedBlock(md: string): string {
  const begin = md.indexOf("<!-- ccl:begin -->");
  const end = md.indexOf("<!-- ccl:end -->");
  if (begin === -1 || end === -1 || end < begin) return "";
  return md.slice(begin, end + "<!-- ccl:end -->".length);
}

// Lift a named RegExp literal out of the watch-codex source and rebuild it, so
// the cross-check uses the parser's REAL pattern, not a copy.
function liftRegex(src: string, name: string): RegExp {
  // Match e.g.  const CCL_FINDING_RE = /.../;
  const re = new RegExp("const\\s+" + name + "\\s*=\\s*(/(?:\\\\.|[^/\\\\])+/[a-z]*)\\s*;");
  const m = src.match(re);
  if (!m) throw new Error(`could not lift ${name} from watch-codex.mjs`);
  const body = m[1];
  const lastSlash = body.lastIndexOf("/");
  const pattern = body.slice(1, lastSlash);
  const flags = body.slice(lastSlash + 1);
  return new RegExp(pattern, flags);
}

// Lift the example marker lines the contract tells the peer to emit (from inside
// fenced ``` code blocks in the contract).
function contractExampleLines(md: string, prefix: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t.startsWith(prefix)) out.push(t);
  }
  return out;
}

// ── (1) six mandatory sections ────────────────────────────────────────────────

describe("codex review-contract: six mandatory sections", () => {
  const SECTIONS: Array<[string, RegExp]> = [
    ["(a) ack-read latest Claude packet", /\(a\)[^\n]*ack-read/i],
    ["(b) scope since lastAckSha", /\(b\)[^\n]*since\s+`?lastAckSha`?/i],
    ["(c) emit on CCL-FINDING channel", /\(c\)[^\n]*CCL-FINDING/],
    ["(d) mirror redaction rules", /\(d\)[^\n]*redact/i],
    ["(e) bounded exits, one pass per tick", /\(e\)[^\n]*(one pass|bounded)/i],
    ["(f) never force-push / never main", /\(f\)[^\n]*(force-?push|main)/i],
  ];

  for (const [label, re] of SECTIONS) {
    it(`has section ${label}`, () => {
      expect(re.test(CONTRACT)).toBe(true);
    });
  }

  it("names lastAckSha as the scope anchor", () => {
    expect(CONTRACT).toMatch(/lastAckSha/);
  });

  it("mirrors the redact module by name", () => {
    expect(CONTRACT).toMatch(/redact\.mjs/);
  });

  it("forbids force-push and pushing to main/master", () => {
    expect(CONTRACT).toMatch(/force/i);
    expect(CONTRACT).toMatch(/\bmain\b/);
    expect(CONTRACT).toMatch(/\bmaster\b/);
  });

  it("requires exactly one pass per tick (no self-loop)", () => {
    expect(CONTRACT).toMatch(/one\s+(review\s+)?pass/i);
    expect(CONTRACT).toMatch(/never\s+re-?arm|do not (start|spawn|schedule)/i);
  });
});

// ── (2) ack-read + bounded exit vocabulary present ────────────────────────────

describe("codex review-contract: ack-read and exit vocabulary", () => {
  it("instructs the peer to ack-read before working", () => {
    expect(CONTRACT).toMatch(/ack-read/i);
    expect(CONTRACT).toMatch(/before doing anything else/i);
  });

  for (const state of EXIT_VOCAB) {
    it(`documents the bounded exit state '${state}'`, () => {
      // Appears in the fenced managed block, not just the preamble.
      expect(fencedBlock(CONTRACT)).toContain(state);
    });
  }

  it("does not tell the peer to emit the local-only 'disabled' terminal", () => {
    // 'disabled' is the local kill-switch terminal; the peer never emits it.
    const block = fencedBlock(CONTRACT);
    // The CCL-EXIT vocabulary listing must not include the word disabled.
    const vocabLine = block
      .split("\n")
      .find((l) => /one of:/i.test(l) && /converged/.test(l));
    expect(vocabLine).toBeTruthy();
    expect(/\bdisabled\b/.test(vocabLine!)).toBe(false);
  });
});

// ── (3) marker cross-check: contract examples MATCH the parser regexes ─────────

describe("codex review-contract: CCL markers match the watch-codex parser", () => {
  const FINDING_RE = liftRegex(WATCH_SRC, "CCL_FINDING_RE");
  const EXIT_RE = liftRegex(WATCH_SRC, "CCL_EXIT_RE");

  it("lifts real regexes from watch-codex.mjs", () => {
    expect(FINDING_RE).toBeInstanceOf(RegExp);
    expect(EXIT_RE).toBeInstanceOf(RegExp);
  });

  it("every CCL-FINDING example line in the contract is parsed by the watcher", () => {
    const examples = contractExampleLines(CONTRACT, "CCL-FINDING");
    expect(examples.length).toBeGreaterThan(0);
    for (const line of examples) {
      const m = line.match(FINDING_RE);
      expect(m, `parser did not match contract example: ${line}`).toBeTruthy();
      // Priority group must be one the parser recognizes.
      expect(["HIGH", "NORMAL"]).toContain(m![1].toUpperCase());
      // Summary group must be non-empty.
      expect(m![2].trim().length).toBeGreaterThan(0);
    }
  });

  it("the contract's exit-state vocabulary is all parseable by the watcher", () => {
    // Build a CCL-EXIT line per documented state and confirm the parser accepts
    // it and recovers the exact state token.
    for (const state of EXIT_VOCAB) {
      const line = `CCL-EXIT ${state}`;
      const m = line.match(EXIT_RE);
      expect(m, `parser rejected exit state: ${state}`).toBeTruthy();
      expect(m![1]).toBe(state);
    }
  });

  it("both priority tags the contract offers are accepted by the parser", () => {
    for (const pri of ["HIGH", "NORMAL"]) {
      const line = `CCL-FINDING [${pri}] example summary text`;
      const m = line.match(FINDING_RE);
      expect(m, `parser rejected priority ${pri}`).toBeTruthy();
      expect(m![1]).toBe(pri);
    }
  });

  it("the contract offers exactly the priority tags the parser recognizes", () => {
    // Parser recognizes HIGH|NORMAL. The contract must not instruct a tag the
    // watcher would silently drop.
    const finding = contractExampleLines(CONTRACT, "CCL-FINDING");
    const tags = new Set(
      finding.map((l) => (l.match(/\[([A-Z]+)\]/) || [])[1]).filter(Boolean)
    );
    for (const tag of tags) {
      expect(["HIGH", "NORMAL"]).toContain(tag);
    }
    // And both recognized tags are actually demonstrated.
    expect(tags.has("HIGH")).toBe(true);
    expect(tags.has("NORMAL")).toBe(true);
  });
});

// ── (4) hooks fragment ────────────────────────────────────────────────────────

describe("codex hooks fragment", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(FRAGMENT_RAW)).not.toThrow();
  });

  const fragment = JSON.parse(FRAGMENT_RAW);

  it("has a SessionStart hook group", () => {
    expect(Array.isArray(fragment.hooks?.SessionStart)).toBe(true);
    expect(fragment.hooks.SessionStart.length).toBeGreaterThan(0);
  });

  it("every group is tagged _ccl for selective uninstall (merge-safe)", () => {
    for (const g of fragment.hooks.SessionStart) {
      expect(g._ccl).toBe(true);
    }
  });

  it("the probe command is repo-relative and bounded (|| true + timeout)", () => {
    const cmds = fragment.hooks.SessionStart.flatMap(
      (g: { hooks?: Array<{ command?: string; timeout?: number }> }) => g.hooks ?? []
    );
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(typeof c.command).toBe("string");
      expect(c.command.trim().endsWith("|| true")).toBe(true);
      expect(c.command).toContain("./packages/claude-codex-loops/bin/");
      expect(typeof c.timeout).toBe("number");
      expect(c.timeout).toBeGreaterThan(0);
      expect(c.timeout).toBeLessThanOrEqual(8);
    }
  });

  it("references no absolute home path", () => {
    expect(FRAGMENT_RAW.includes(HOME_PATH)).toBe(false);
  });

  it("the fragment never targets the global ~/.codex/AGENTS.md", () => {
    expect(FRAGMENT_RAW.includes(GLOBAL_AGENTS)).toBe(false);
  });

  it("the contract references the global agents file ONLY to forbid writing to it", () => {
    // The contract's whole point is to say the block goes into the CONSUMER
    // repo's AGENTS.md and NEVER into the global ~/.codex/AGENTS.md — so it may
    // name the global path, but only inside a 'never'/'not' negation.
    const idx = CONTRACT.indexOf(GLOBAL_AGENTS);
    if (idx === -1) return; // not naming it at all is also fine
    const around = CONTRACT.slice(Math.max(0, idx - 80), idx).toLowerCase();
    expect(/never|not\b/.test(around)).toBe(true);
  });
});

// ── (5) contract self-hygiene: appends to repo AGENTS.md, not global ──────────

describe("codex review-contract: install target and marker fence", () => {
  it("is fenced with ccl:begin / ccl:end markers", () => {
    expect(CONTRACT).toContain("<!-- ccl:begin -->");
    expect(CONTRACT).toContain("<!-- ccl:end -->");
    const begin = CONTRACT.indexOf("<!-- ccl:begin -->");
    const end = CONTRACT.indexOf("<!-- ccl:end -->");
    expect(end).toBeGreaterThan(begin);
  });

  it("states the block appends into the consumer repo's AGENTS.md", () => {
    expect(CONTRACT).toMatch(/consumer repo'?s?\s+`?AGENTS\.md`?/i);
  });
});
