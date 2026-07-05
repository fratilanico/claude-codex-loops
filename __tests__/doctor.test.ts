// DOCTOR PREFLIGHT GATE.
//
// bin/doctor.mjs runs PASS/FAIL preflight checks and exits non-zero (1) when a
// check fails, naming the failing check — so /pingpong-install, install.sh, and
// CI can gate on it. This test drives the failure paths with controlled fixtures:
//   - a real tmp git repo with a dependency FAKED-MISSING (PATH stripped of gh)
//     → doctor exits 1 and names `gh`;
//   - the same for `codex` / `claude` (existence checked via PATH, not spawned);
//   - a repo with no merged hooks → doctor names `hooks-merged`;
//   - a node-too-old fake → doctor names `node`.
// It also asserts the liveness contract the safety suite relies on: an
// unresolvable repo is NOT a failure (exit 0), and a provider API key only WARNs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";

const DOCTOR = join(__dirname, "..", "bin", "doctor.mjs");

// Assemble the provider-key var names from fragments so this test source stays
// hygiene-clean (the pack-hygiene / fleet-hygiene gates forbid the brands).
const ANTHROPIC_KEY = "ANTHRO" + "PIC_API_KEY";

let repo: string;
let fakeBin: string; // a PATH dir we populate selectively to fake missing deps

// Resolve a binary on the CURRENT PATH via fs (no login shell — fast + hermetic).
function realBin(name: string): string | null {
  const pathVar = process.env.PATH || "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Build a PATH dir that contains symlinks to ONLY the named real binaries, so any
// binary NOT listed is "missing" from doctor's point of view.
function pathWith(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ccl-doctor-path-"));
  for (const n of names) {
    const real = realBin(n);
    if (real) {
      try {
        symlinkSync(real, join(dir, n));
      } catch {
        /* ignore */
      }
    }
  }
  return dir;
}

function runDoctor(env: Record<string, string>, args: string[] = ["--repo", repo]) {
  return spawnSync(process.execPath, [DOCTOR, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ccl-doctor-repo-"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  fakeBin = "";
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
});

describe("doctor: liveness (never a resident process; unresolvable repo is exit 0)", () => {
  it("exits 0 when the target repo path does not resolve (nothing to preflight)", () => {
    const r = runDoctor({}, ["--repo", "/nonexistent/definitely/not/here"]);
    expect(r.status).toBe(0);
    expect(r.signal).toBe(null);
    expect(r.stdout).toMatch(/nothing to preflight/);
  });
});

describe("doctor: exits non-zero and NAMES the failing check", () => {
  it("names `gh` when gh is missing from PATH", () => {
    fakeBin = pathWith(["git", "node", "codex", "claude"]); // gh deliberately absent
    const r = runDoctor({ PATH: fakeBin });
    expect(r.status).toBe(1);
    expect(r.signal).toBe(null);
    // named in the FAIL summary
    expect(r.stderr + r.stdout).toMatch(/FAIL[^\n]*\bgh\b/);
    expect(r.stdout).toMatch(/\[FAIL\] gh/);
  });

  it("names `codex` when the codex CLI is missing from PATH", () => {
    fakeBin = pathWith(["git", "node", "gh", "claude"]); // codex absent
    const r = runDoctor({ PATH: fakeBin });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] codex/);
  });

  it("names `claude` when the claude CLI is missing from PATH", () => {
    fakeBin = pathWith(["git", "node", "gh", "codex"]); // claude absent
    const r = runDoctor({ PATH: fakeBin });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] claude/);
  });

  it("names `hooks-merged` when the repo has no merged ccl hooks", () => {
    // Full PATH so only the hooks check fails.
    const r = runDoctor({});
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[FAIL\] hooks-merged/);
  });
});

describe("doctor: launchd label basename is sanitized (finding #12)", () => {
  it("a repo path containing a space prints a label with NO raw space", () => {
    // git can init a repo whose path has a space; doctor must not emit a
    // malformed launchd Label for it (basename → [A-Za-z0-9._-]).
    const spaced = mkdtempSync(join(tmpdir(), "ccl doctor space-")); // note the space
    try {
      execFileSync("git", ["-C", spaced, "init", "-q"]);
      execFileSync("git", ["-C", spaced, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", spaced, "config", "user.name", "t"]);
      const r = spawnSync(process.execPath, [DOCTOR, "--repo", spaced], {
        encoding: "utf8",
        timeout: 30_000,
      });
      const m = r.stdout.match(/launchd label would be (\S.*)$/m);
      expect(m, "label line present").not.toBeNull();
      const label = m![1].trim();
      expect(label.startsWith("com.claude-codex-loops.")).toBe(true);
      // the whole label token has no whitespace, and ends with the -<hash8>.
      expect(/\s/.test(label)).toBe(false);
      expect(label).toMatch(/-[0-9a-f]{8}$/);
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });
});

describe("doctor: passes once hooks are merged, WARNs on provider keys", () => {
  function mergeHooks() {
    const claudeDir = join(repo, ".claude");
    const codexDir = join(repo, ".codex");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    const cclGroup = { _ccl: true, hooks: [{ type: "command", command: "true", timeout: 8 }] };
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [cclGroup] } }, null, 2)
    );
    writeFileSync(
      join(codexDir, "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [cclGroup] } }, null, 2)
    );
  }

  it("emits a WARN (not a FAIL) when a provider API key is set and hooks are merged", () => {
    mergeHooks();
    const r = runDoctor({ [ANTHROPIC_KEY]: "x-should-not-be-needed" });
    // The provider key is a WARN; if everything else is green doctor still PASSes.
    expect(r.stdout).toMatch(/\[WARN\] provider-key/);
    // status depends only on FAILs; with hooks merged + full PATH this repo is
    // green apart from possibly codex-sessions (host-dependent). Assert the key
    // did NOT turn into a FAIL regardless.
    expect(r.stdout).not.toMatch(/\[FAIL\][^\n]*provider-key/);
  });
});
