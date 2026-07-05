// DOCS ENV-TABLE PARITY + DOC-HYGIENE GATE (ships in the pack, runs in split CI).
//
// Two jobs:
//  1. ENV-TABLE PARITY. Grep every environment variable the pack actually READS
//     (a `process.env.NAME` or `env.NAME` reference where NAME is a CCL_* /
//     CODEX_* var) across core/ + bin/ + workflows/, and diff that set against
//     the rows of the README "Environment variables" table. FAIL on any
//     documented-but-absent (a README row for a var no code reads) or
//     present-but-undocumented (a var the code reads with no README row) key.
//     This keeps the README env table honest as the code evolves.
//
//  2. DOC HYGIENE. No shipped doc may reference a path / branch / repo that lives
//     OUTSIDE the pack. The upstream fleet-hygiene gate covers infrastructure
//     secrets; here we add a generic macOS home-path check plus an
//     owner-name absence check for the four docs (assembled from fragments so the
//     forbidden literal never appears verbatim in this shipped test).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const README = join(PACK_DIR, "README.md");

// Directories whose source we scan for env-var reads.
const CODE_DIRS = ["core", "bin", "workflows"];

// Recursively collect *.mjs / *.js files under a dir (skip node_modules).
function walkCode(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkCode(p));
    else if (e.isFile() && (p.endsWith(".mjs") || p.endsWith(".js"))) out.push(p);
  }
  return out;
}

// Every env var the pack READS: a `process.env.NAME` or `env.NAME` where NAME is
// a CCL_ / CODEX_ variable. This precise form deliberately EXCLUDES:
//   - local regex/const identifiers that merely start with CCL_ (e.g. CCL_EXIT_RE)
//     because those are `const CCL_EXIT_RE = ...`, never `env.CCL_EXIT_RE`;
//   - object-literal KEYS passed to a subprocess env (e.g. `CODEX_WATCH_WINDOW_HOURS:`)
//     because those are not read via `env.`/`process.env.`;
//   - the fragment-assembled provider-key var names in doctor (never contiguous).
const ENV_READ_RE = /(?:process\.)?env\.((?:CCL|CODEX)_[A-Z0-9_]+)/g;

function envVarsReadInCode(): Set<string> {
  const found = new Set<string>();
  for (const base of CODE_DIRS) {
    for (const file of walkCode(join(PACK_DIR, base))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(ENV_READ_RE)) found.add(m[1]);
    }
  }
  return found;
}

// Parse the env-var names documented in the README env-table. Every env var is
// rendered in the table as an inline-code cell `| \`ENV_NAME\` | ... |`, so we
// pull the first backticked token of each table row whose token looks like a
// CCL_/CODEX_ env var.
function envVarsDocumentedInReadme(): Set<string> {
  const text = readFileSync(README, "utf8");
  const documented = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const m = line.match(/\|\s*`((?:CCL|CODEX)_[A-Z0-9_]+)`\s*\|/);
    if (m) documented.add(m[1]);
  }
  return documented;
}

describe("docs-env-table: README documents exactly the env vars the pack reads", () => {
  it("has at least the known core env vars (sanity: the scan found something)", () => {
    const read = envVarsReadInCode();
    expect(read.size).toBeGreaterThan(10);
    expect(read.has("CCL_STATE_DIR")).toBe(true);
    expect(read.has("CODEX_LOOP_INTERVAL")).toBe(true);
  });

  it("documents every env var the code reads (no present-but-undocumented key)", () => {
    const read = [...envVarsReadInCode()].sort();
    const documented = envVarsDocumentedInReadme();
    const undocumented = read.filter((k) => !documented.has(k));
    // Surface the offending keys so a CI failure is self-explaining.
    expect(undocumented).toEqual([]);
  });

  it("reads every env var the README documents (no documented-but-absent key)", () => {
    const read = envVarsReadInCode();
    const documented = [...envVarsDocumentedInReadme()].sort();
    const stale = documented.filter((k) => !read.has(k));
    expect(stale).toEqual([]);
  });
});

// ── Doc hygiene ────────────────────────────────────────────────────────────────

const DOCS = [
  join(PACK_DIR, "README.md"),
  join(PACK_DIR, "docs", "ARCHITECTURE.md"),
  join(PACK_DIR, "docs", "SAFETY.md"),
  join(PACK_DIR, "docs", "PR-REVIEW-LOOP.md"),
];

// The macOS home-path root, assembled from fragments so THIS shipped test source
// never contains the contiguous string (the pack-hygiene gate forbids it).
const HOME_ROOT = "/Us" + "ers/";

describe("docs-env-table: docs reference nothing outside the pack", () => {
  it("contains no absolute home path in any shipped doc", () => {
    for (const doc of DOCS) {
      const text = readFileSync(doc, "utf8");
      // A macOS home path root leaks a machine-specific absolute path.
      expect(text.includes(HOME_ROOT)).toBe(false);
    }
  });

  it("contains no owner-name literal in any shipped doc", () => {
    // Assembled from fragments so the forbidden owner literal never appears
    // verbatim in this shipped source (the upstream fleet-hygiene gate forbids
    // it). Two shapes: the GitHub owner slug and the home-dir owner segment.
    const ownerSlug = "frat" + "ila" + "nico";
    const ownerHome = HOME_ROOT + "nico";
    for (const doc of DOCS) {
      const text = readFileSync(doc, "utf8");
      expect(text.includes(ownerSlug)).toBe(false);
      expect(text.includes(ownerHome)).toBe(false);
    }
  });

  it("does not reference the upstream monorepo's internal loop-doc paths", () => {
    // The promoted PR-REVIEW-LOOP.md must be de-branded: no reference to the
    // upstream docs/loops/ tree or the old .claude/workflows/ path that only
    // exists in the source monorepo.
    for (const doc of DOCS) {
      const text = readFileSync(doc, "utf8");
      expect(text.includes("docs/loops/")).toBe(false);
      expect(text.includes(".claude/workflows/")).toBe(false);
    }
  });
});
