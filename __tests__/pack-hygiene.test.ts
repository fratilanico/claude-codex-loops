// PACK-INTERNAL HYGIENE GATE (generic, ships with the pack, runs in the split
// repo's CI and — via the host repo's root include glob — in the host CI too).
//
// This is the pack's OWN, self-contained source-hygiene defense. It does NOT
// know about the host fleet (that denylist stays origin-side ON PURPOSE — see
// the host repo fleet-hygiene test). Instead it enforces generic rules
// that any downstream fork should keep true:
//   1. no import/path escapes the pack root (`../` reaching above the pack);
//   2. no absolute home-directory paths (macOS /Users and Linux /home roots);
//   3. no secret token shapes (private-key / GitHub-PAT / JWT prefixes);
//   4. no double-brace template residue in files that are not templates.
//
// NOTE: core/redact.mjs is a RUNTIME OUTPUT filter for loop packets — it is NOT
// relied on for source hygiene, and this gate does not defer to it.
//
// This test's own source must not contain the literals it hunts for, or it
// would flag itself. Token-shape needles AND the double-brace marker are
// therefore assembled from fragments at runtime so the contiguous string never
// appears in this file.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const PACK_DIR = join(__dirname, "..");
// .claude/.codex are install.sh OUTPUT (skill copies + .ccl-pack-root pointer
// files carrying machine-local absolute paths) — runtime artifacts, not pack
// source, so a self-installed clone must not fail its own hygiene gate.
const SKIP_DIRS = new Set([".git", "node_modules", ".agent-loops", ".claude", ".codex"]);
// Generated lockfiles are third-party integrity hashes (high-entropy base64
// that trivially collides with the JWT/token-shape needles). They are not pack
// source, so they are out of scope for source hygiene.
const SKIP_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

// Template files legitimately contain double-brace placeholders and
// home-shaped example paths.
const TEMPLATE_SUFFIXES = [".template", ".plist.template"];

// Double-brace open/close, assembled from fragments so THIS source never
// contains a literal double-brace pair that its own residue rule would flag.
const OB = "{" + "{";
const CB = "}" + "}";

// Secret-token-shape needles, assembled so this source file does not itself
// contain any of them contiguously.
const TOKEN_SHAPES = [
  "s" + "k-", // provider private key prefix
  "gh" + "p_", // GitHub personal access token prefix
  "ey" + "J", // JWT (base64 of {"…) prefix
];

// Home-directory path shapes.
const HOME_PATHS = ["/Us" + "ers/", "/ho" + "me/"];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkFiles(join(dir, entry.name)));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function isTemplate(file: string): boolean {
  return TEMPLATE_SUFFIXES.some((s) => file.endsWith(s));
}

type Hit = { file: string; kind: string; detail: string; line: number };

// Detect an import/path that escapes the pack root: a `../` segment at or above
// the pack root. Any relative specifier whose resolved depth goes negative
// relative to its own file escapes. We approximate structurally: flag any
// occurrence of a relative specifier that starts the traversal from the pack
// root and climbs out (path begins with `../` and the file sits directly under
// the pack root or a lone `../..` chain reaching above pack top).
function scanFile(file: string, rootForRelative: string): Hit[] {
  const hits: Hit[] = [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return hits;
  }
  const relPath = relative(rootForRelative, file);
  // Depth of the file within the pack (number of path segments below root).
  const depth = relPath.split("/").length - 1; // 0 = top-level file
  const template = isTemplate(file);
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // (1) escaping import/path specifiers. Match quoted specifiers with `../`.
    for (const m of line.matchAll(/["'`](\.\.\/[^"'`]*)["'`]/g)) {
      const spec = m[1];
      // Count leading `../` hops.
      let hops = 0;
      let rest = spec;
      while (rest.startsWith("../")) {
        hops += 1;
        rest = rest.slice(3);
      }
      // A specifier climbs OUT of the pack when its hop count exceeds the file's
      // own depth below the pack root.
      if (hops > depth) {
        hits.push({ file: relPath, kind: "escapes-pack-root", detail: spec, line: lineNo });
      }
    }

    // (2) home-directory paths (skip templates — they use example paths).
    if (!template) {
      for (const home of HOME_PATHS) {
        if (line.includes(home)) {
          hits.push({ file: relPath, kind: "home-path", detail: home, line: lineNo });
        }
      }
    }

    // (3) secret token shapes (everywhere, including templates).
    for (const shape of TOKEN_SHAPES) {
      if (line.includes(shape)) {
        hits.push({ file: relPath, kind: "token-shape", detail: shape, line: lineNo });
      }
    }

    // (4) double-brace template residue in non-template files.
    if (!template && /\{\{[^}]*\}\}/.test(line)) {
      hits.push({ file: relPath, kind: "template-residue", detail: "double-brace", line: lineNo });
    }
  }
  return hits;
}

function scanTree(dir: string, rootForRelative: string): Hit[] {
  return walkFiles(dir).flatMap((f) => scanFile(f, rootForRelative));
}

describe("pack-hygiene: the pack directory is clean", () => {
  it("has files to scan (wave scaffolds the pack)", () => {
    expect(walkFiles(PACK_DIR).length).toBeGreaterThan(0);
  });

  it("finds no escaping paths, home paths, token shapes, or template residue", () => {
    const hits = scanTree(PACK_DIR, PACK_DIR);
    expect(hits).toEqual([]);
  });
});

describe("pack-hygiene: planted-secret self-test (each rule actually fires)", () => {
  it("flags a home path, a token shape, an escaping import, and template residue", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-hygiene-"));
    try {
      // Build the planted needles from fragments so they never appear
      // contiguously in THIS test source.
      const homePath = "/ho" + "me/someone/secret";
      const tokenShape = "s" + "k-abcdefghijklmnop";
      const badImport = "../".repeat(4) + "outside/thing.mjs";
      const planted = join(dir, "planted.mjs"); // depth 0 → any `../` escapes
      writeFileSync(
        planted,
        [
          `const p = '${homePath}';`,
          `const t = '${tokenShape}';`,
          `import x from '${badImport}';`,
          "const tpl = `value " + OB + "PLACEHOLDER" + CB + " here`;",
        ].join("\n"),
        "utf8"
      );
      const hits = scanFile(planted, dir);
      const kinds = new Set(hits.map((h) => h.kind));
      expect(kinds.has("home-path")).toBe(true);
      expect(kinds.has("token-shape")).toBe(true);
      expect(kinds.has("escapes-pack-root")).toBe(true);
      expect(kinds.has("template-residue")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT flag double-brace residue inside a .template file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-hygiene-tpl-"));
    try {
      const tpl = join(dir, "thing.plist.template");
      writeFileSync(tpl, "<string>" + OB + "LABEL" + CB + "</string>\n", "utf8");
      const hits = scanFile(tpl, dir);
      expect(hits.filter((h) => h.kind === "template-residue")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT flag a legal in-pack relative import", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-hygiene-imp-"));
    try {
      // A nested file (depth 1) importing one level up stays inside the pack.
      const sub = join(dir, "bin");
      mkdirSync(sub, { recursive: true });
      const nested = join(sub, "tick.mjs");
      writeFileSync(nested, "import { x } from '../core/thing.mjs';\n", "utf8");
      const hits = scanFile(nested, dir);
      expect(hits.filter((h) => h.kind === "escapes-pack-root")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
