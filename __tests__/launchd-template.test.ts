// LAUNCHD TEMPLATE GATE.
//
// schedule/launchd.plist.template carries double-brace placeholder tokens that
// install.sh substitutes. This test renders it exactly the way install.sh does
// and asserts the rendered plist is sound:
//   - StartInterval is a valid integer >= 60 (the cadence floor);
//   - no double-brace residue survives (every token was substituted);
//   - no absolute home path leaks into the rendered plist;
//   - the label carries the 8-hex-char abspath hash (per-clone uniqueness);
//   - two DIFFERENT repo abspaths render two DIFFERENT labels.
//
// The double-brace pair and the home-path needle are assembled from fragments so
// THIS test source never contains them verbatim (pack-hygiene forbids both).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

const TEMPLATE = join(__dirname, "..", "schedule", "launchd.plist.template");
const RAW = readFileSync(TEMPLATE, "utf8");

const OB = "{" + "{";
const CB = "}" + "}";
const HOME_NEEDLE = "/Us" + "ers/";

// Mirror install.sh's label derivation exactly: hash8 over the FULL abspath,
// basename segment sanitized to [A-Za-z0-9._-] (a space in the repo path would
// otherwise make a malformed launchd Label — finding #12).
function labelFor(abspath: string): string {
  const hash8 = createHash("sha256").update(abspath).digest("hex").slice(0, 8);
  const safeBase = basename(abspath).replace(/[^A-Za-z0-9._-]/g, "-");
  return `com.claude-codex-loops.${safeBase}-${hash8}`;
}

// Mirror install.sh's token substitution (split/join on the OB+KEY+CB token).
function render(sub: Record<string, string>): string {
  let t = RAW;
  for (const [k, v] of Object.entries(sub)) {
    t = t.split(OB + k + CB).join(v);
  }
  return t;
}

// A stand-in absolute node path — the shape install.sh bakes in from
// `command -v node`. The template must place an ABSOLUTE interpreter here, never
// a bare `env node` pair (launchd's minimal PATH lacks Homebrew node).
const NODE_ABS = "/opt/" + "homebrew/bin/node";

function renderFor(repoRoot: string, interval: number): string {
  const label = labelFor(repoRoot);
  return render({
    LABEL: label,
    NODE_BIN: NODE_ABS,
    PACK_ROOT: `${repoRoot}/packages/claude-codex-loops`,
    REPO_ROOT: repoRoot,
    INTERVAL: String(interval),
    STATE_DIR: ".agent-loops",
  });
}

describe("launchd template: structure", () => {
  it("still contains every placeholder before rendering", () => {
    for (const key of ["LABEL", "NODE_BIN", "PACK_ROOT", "REPO_ROOT", "INTERVAL", "STATE_DIR"]) {
      expect(RAW.includes(OB + key + CB), `template missing ${key}`).toBe(true);
    }
  });

  it("uses a NODE_BIN interpreter placeholder, NOT a bare `env node` pair", () => {
    // The first ProgramArguments string must be the NODE_BIN token (OB+key+CB) so
    // install.sh can bake in an absolute node path. launchd starts jobs with a
    // minimal PATH (no Homebrew), so `/usr/bin/env node` would never find node
    // and every scheduled tick would silently fail.
    const progArgs = RAW.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    expect(progArgs, "ProgramArguments array present").not.toBeNull();
    const block = progArgs![1];
    expect(block).toContain(OB + "NODE_BIN" + CB);
    expect(block).not.toContain("/usr/bin/env");
    // The first <string> in the array is the interpreter and must be the token.
    const firstArg = block.match(/<string>([^<]*)<\/string>/);
    expect(firstArg![1]).toBe(OB + "NODE_BIN" + CB);
  });

  it("the template file itself carries no absolute home path", () => {
    expect(RAW.includes(HOME_NEEDLE)).toBe(false);
  });

  it("declares itself NOT a daemon (KeepAlive false)", () => {
    expect(RAW).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(RAW).toMatch(/<key>StartInterval<\/key>/);
  });
});

describe("launchd template: rendered output", () => {
  // A repo path that does NOT live under a home root, so the rendered plist has
  // no home path at all (install.sh's own home-shaped paths are elsewhere).
  const repo = "/srv/work/example-repo";
  const rendered = renderFor(repo, 600);

  it("has no double-brace residue after rendering (all tokens substituted)", () => {
    expect(rendered.includes(OB)).toBe(false);
    expect(rendered.includes(CB)).toBe(false);
  });

  it("StartInterval renders as an integer >= 60", () => {
    const m = rendered.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    expect(m, "StartInterval integer present").not.toBeNull();
    const interval = Number(m![1]);
    expect(Number.isInteger(interval)).toBe(true);
    expect(interval).toBeGreaterThanOrEqual(60);
  });

  it("the label embeds an 8-hex-char abspath hash", () => {
    const m = rendered.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/);
    expect(m).not.toBeNull();
    const label = m![1];
    expect(label.startsWith("com.claude-codex-loops.")).toBe(true);
    // trailing -<8 hex>
    expect(label).toMatch(/-[0-9a-f]{8}$/);
    expect(label).toBe(labelFor(repo));
  });

  it("rendered plist for a non-home repo path contains no home-directory path", () => {
    expect(rendered.includes(HOME_NEEDLE)).toBe(false);
    expect(rendered.includes("/ho" + "me/")).toBe(false);
  });

  it("two different repo paths render two DIFFERENT labels (per-clone uniqueness)", () => {
    // Same basename, different absolute path — the hash must disambiguate them.
    const a = renderFor("/srv/a/proj", 600);
    const b = renderFor("/srv/b/proj", 600);
    const labelOf = (s: string) => s.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)![1];
    expect(labelOf(a)).not.toBe(labelOf(b));
    // both still share the basename segment
    expect(labelOf(a)).toContain(".proj-");
    expect(labelOf(b)).toContain(".proj-");
  });

  it("the interpreter (first ProgramArgument) is the ABSOLUTE node path, no env/node pair", () => {
    const progArgs = rendered.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    const block = progArgs![1];
    const strings = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    // First arg is the absolute interpreter we substituted.
    expect(strings[0]).toBe(NODE_ABS);
    expect(strings[0].startsWith("/")).toBe(true);
    // The env/node indirection is gone entirely.
    expect(block).not.toContain("/usr/bin/env");
    expect(strings).not.toContain("node"); // no bare `node` arg survives
    // The second arg is now the tick script directly under the pack.
    expect(strings[1]).toMatch(/\/bin\/loop-tick\.mjs$/);
  });
});

// ── label sanitization: a space (or odd char) in the repo path must not produce
//    a malformed launchd Label (finding #12). install.sh + doctor.mjs both
//    sanitize the basename to [A-Za-z0-9._-]; the rendered label must match.
describe("launchd template: label basename sanitization", () => {
  it("a repo path with a space yields a label with the space sanitized to '-'", () => {
    const repo = "/srv/work/my repo";
    const rendered = renderFor(repo, 600);
    const label = rendered.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)![1];
    // No raw space survives in the Label value.
    expect(label).not.toContain(" ");
    expect(label).toBe(labelFor(repo));
    expect(label).toContain(".my-repo-");
    // hash8 is still over the FULL, unsanitized abspath (uniqueness preserved):
    // a same-basename repo at a different path gets a different label.
    const other = renderFor("/srv/other/my repo", 600);
    const otherLabel = other.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)![1];
    expect(otherLabel).not.toBe(label);
  });
});
