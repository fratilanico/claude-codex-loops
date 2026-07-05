// INSTALL / UNINSTALL GATE.
//
// Exercises install.sh + uninstall.sh against a throwaway git repo that VENDORS
// the pack inside itself (packages/claude-codex-loops), which is the realistic
// consumer layout and keeps every rendered path repo-relative (no home path
// leaks into the installed tree). Asserts:
//   - `bash -n` parses both scripts;
//   - install into a fresh repo → every artifact present;
//   - the installed tree contains ZERO foreign absolute home paths;
//   - double-run is idempotent (the managed files are byte-identical run-1==run-2);
//   - uninstall reverts to the pre-install hook/AGENTS tree (ccl removed) while
//     KEEPING the state dir and writing the kill switch;
//   - a PRE-SEEDED foreign absolute-path SessionStart hook SURVIVES install AND
//     uninstall untouched, and that path string appears NOWHERE in pack sources;
//   - two clones of the same-basename repo at different abspaths → distinct
//     launchd labels (the label-derivation the plist template uses).
//
// launchd itself is never touched: install runs with --no-launchd so no real
// LaunchAgent is written or loaded, keeping the test hermetic and CI-safe.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  cpSync,
} from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const PACK_SRC = join(__dirname, "..");
const INSTALL = join(PACK_SRC, "install.sh");
const UNINSTALL = join(PACK_SRC, "uninstall.sh");

// A foreign hook path shaped like a real external-tool absolute path. It must
// survive install/uninstall and never be copied into the pack. It intentionally
// does NOT use a home root (so its presence in the installed tree is not itself a
// home-path leak) — the point is a *foreign absolute path we do not own*.
//
// It is ASSEMBLED FROM FRAGMENTS so the contiguous path string never appears in
// this test file: the "absent from pack sources" scan below walks the whole pack
// (this test file included), and a verbatim literal would flag itself.
const FOREIGN_HOOK_PATH = "/opt/" + "example-tools/" + "hooks/" + "foreign-oracle.py";
const FOREIGN_CLAUDE_MARK = "foreign-claude" + "-sentinel-cmd";

// ── helpers ─────────────────────────────────────────────────────────────────
function git(repo: string, args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "core.hooksPath", "/dev/null"]); // no foreign pre-commit
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"], {
    stdio: "ignore",
  });
  return repo;
}

// Vendor the pack sources INSIDE the repo at packages/claude-codex-loops.
function vendorPack(repo: string): string {
  const dest = join(repo, "packages", "claude-codex-loops");
  mkdirSync(dest, { recursive: true });
  cpSync(PACK_SRC, dest, {
    recursive: true,
    filter: (src) => {
      const b = basename(src);
      return b !== "node_modules" && b !== ".agent-loops" && b !== ".git";
    },
  });
  return dest;
}

function seedForeignHooks(repo: string) {
  mkdirSync(join(repo, ".codex"), { recursive: true });
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".codex", "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: `python3 ${FOREIGN_HOOK_PATH}` }] },
          ],
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${FOREIGN_CLAUDE_MARK}` }] }] } },
      null,
      2
    )
  );
}

function runInstall(repo: string, pack: string) {
  return spawnSync("bash", [join(pack, "install.sh"), "--repo", repo, "--no-launchd"], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function runUninstall(repo: string, pack: string) {
  return spawnSync("bash", [join(pack, "uninstall.sh"), "--repo", repo], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

function hasCcl(file: string): boolean {
  if (!existsSync(file)) return false;
  return JSON.stringify(JSON.parse(readFileSync(file, "utf8"))).includes('"_ccl":true');
}

// Recursively collect files under a dir, skipping the vendored pack + node_modules
// (those are pack sources, already hygiene-clean; the check is on GENERATED tree).
function generatedFiles(repo: string): string[] {
  const out: string[] = [];
  const skip = new Set(["packages", "node_modules", ".git"]);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(repo);
  return out;
}

// ── bash -n (no repo needed) ────────────────────────────────────────────────
describe("install/uninstall: scripts parse", () => {
  it("install.sh parses with bash -n", () => {
    const r = spawnSync("bash", ["-n", INSTALL], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
  it("uninstall.sh parses with bash -n", () => {
    const r = spawnSync("bash", ["-n", UNINSTALL], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });
  it("refuses on a non-darwin platform with the v0.2 message", () => {
    // Force the OS check to see a fake `uname` returning Linux by prepending a
    // shim dir to PATH. install.sh calls `uname -s`.
    const shim = mkdtempSync(join(tmpdir(), "ccl-uname-"));
    writeFileSync(join(shim, "uname"), '#!/bin/sh\necho Linux\n');
    execFileSync("chmod", ["+x", join(shim, "uname")]);
    const r = spawnSync("bash", [INSTALL, "--repo", tmpdir(), "--no-launchd"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${shim}${":"}${process.env.PATH}` },
      timeout: 30_000,
    });
    rmSync(shim, { recursive: true, force: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/launchd-only in v0\.1\.0; Linux\/cron is v0\.2/);
  });
});

// ── installer source-structure invariants (ordering / substitution bugs that
//    the --no-launchd hermetic run cannot exercise directly) ─────────────────
describe("install.sh: launchd wiring source invariants", () => {
  const SRC = readFileSync(INSTALL, "utf8");

  it("resolves an ABSOLUTE node interpreter and substitutes it for the NODE_BIN token (finding #1)", () => {
    // command -v node → NODE_ABS, passed into the plist render.
    expect(SRC).toMatch(/NODE_ABS=.*command -v/);
    // the render maps a NODE_BIN key (so the template's NODE_BIN placeholder is filled).
    expect(SRC).toMatch(/NODE_BIN:process\.argv/);
    expect(SRC).toContain("$NODE_ABS");
  });

  it("creates the state dir BEFORE loading the plist (RunAtLoad ordering, finding #9)", () => {
    const OB = "{" + "{";
    const mkStateIdx = SRC.indexOf('mkdir -p "$REPO_ROOT/$STATE_DIR"');
    const renderIdx = SRC.indexOf("launchd.plist.template");
    // the ACTUAL load command (not the prose mention in a comment).
    const loadIdx = SRC.indexOf('launchctl load "$PLIST_DEST"');
    expect(mkStateIdx, "state-dir mkdir present").toBeGreaterThan(-1);
    expect(loadIdx, "launchctl load command present").toBeGreaterThan(-1);
    // it must sit before the plist is rendered AND before it is loaded
    expect(mkStateIdx).toBeLessThan(renderIdx);
    expect(mkStateIdx).toBeLessThan(loadIdx);
    // and it lives inside the launchd block (after the DO_LAUNCHD guard)
    expect(mkStateIdx).toBeGreaterThan(SRC.indexOf('if [ "$DO_LAUNCHD" -eq 1 ]'));
    // sanity: install.sh itself carries no double-brace placeholder residue (a
    // stray token would mean an unsubstituted plist var). OB is the open pair.
    expect(SRC.includes(OB)).toBe(false);
  });

  it("sanitizes the launchd label basename to [A-Za-z0-9._-] (finding #12)", () => {
    // the LABEL derivation strips unsafe chars from basename(r) before use.
    expect(SRC).toMatch(/basename\(r\)\.replace\(\/\[\^A-Za-z0-9\._-\]\/g,\s*"-"\)/);
  });

  it("derives STATUS_FILE with node path.join, not raw shell concat (finding #14)", () => {
    // Matches loop-tick.mjs's join(repoRoot, stateDir, "bridge", ...) so a
    // trailing slash in stateDir can't make the installer assert a different path.
    const statusLine = SRC.split("\n").find((l) => l.startsWith("STATUS_FILE="));
    expect(statusLine, "STATUS_FILE assignment present").toBeTruthy();
    // node:path is required as `p`, so the call reads p.join(...).
    expect(statusLine).toMatch(/\bp\.join\(/);
    expect(statusLine).toContain("node:path");
    // the raw shell-concat form is gone.
    expect(statusLine).not.toMatch(/STATUS_FILE="\$REPO_ROOT\/\$STATE_DIR\/bridge/);
  });

  it("makes the hook backup collision-proof + skips it when already ccl-tagged (finding #15)", () => {
    // A same-second re-run must not clobber a prior backup: the name carries $$
    // (PID). And a re-install of an already-merged file skips the backup entirely.
    expect(SRC).toContain("$target.bak.$TS.$$");
    expect(SRC).toMatch(/grep -qF '"_ccl"' "\$target"/);
  });
});

// ── full install → assert → double-run → uninstall ──────────────────────────
// The full lifecycle runs the real install.sh, which refuses on non-Darwin
// (macOS/launchd-only in v0.1.0). Skip on other platforms so this pack test does
// not fail a Linux host CI; the pack's own ci.yml runs on macos-latest.
describe.skipIf(process.platform !== "darwin")(
  "install/uninstall: full lifecycle on a vendored tmp repo",
  () => {
  let repo: string;
  let pack: string;

  beforeAll(() => {
    repo = makeRepo("ccl-install-");
    seedForeignHooks(repo);
    pack = vendorPack(repo);
    const r = runInstall(repo, pack);
    expect(r.status, `install failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("wrote the config from the example (present, valid JSON, not clobbering)", () => {
    const cfg = join(repo, ".claude-codex-loops.json");
    expect(existsSync(cfg)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    expect(parsed.stateDir).toBe(".agent-loops");
    expect(parsed.pingpong.maxRounds).toBe(4);
  });

  it("appended the state dir to .gitignore", () => {
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gi.split("\n")).toContain(".agent-loops/");
  });

  it("copied ALL FIVE skills into the consumer skills dir (incl the flagship loops)", () => {
    // finding #3: the flagship /research-loop and /ccl-loop were never installed.
    for (const s of ["pingpong", "pingpong-pr", "pingpong-install", "ccl-loop", "research-loop"]) {
      expect(existsSync(join(repo, ".claude", "skills", s, "SKILL.md")), s).toBe(true);
    }
  });

  it("wrote a .ccl-pack-root marker pointing at the vendored pack for every skill with a .mjs", () => {
    // finding #4: a copied skill's two-up PACK_ROOT resolves to <repo>/.claude, so
    // install.sh drops an absolute pack-root marker the skill reads. Only skills
    // that ship a .mjs need it (pingpong-pr is prompt-only).
    const expectedPack = join(repo, "packages", "claude-codex-loops");
    for (const s of ["pingpong", "pingpong-install", "ccl-loop", "research-loop"]) {
      const marker = join(repo, ".claude", "skills", s, ".ccl-pack-root");
      expect(existsSync(marker), `${s} missing .ccl-pack-root`).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe(expectedPack);
    }
  });

  it("merged the ccl hook entry into BOTH Claude and Codex settings", () => {
    expect(hasCcl(join(repo, ".claude", "settings.json"))).toBe(true);
    expect(hasCcl(join(repo, ".codex", "hooks.json"))).toBe(true);
  });

  it("appended the marker-fenced review contract to AGENTS.md exactly once", () => {
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("<!-- ccl:begin -->");
    expect(agents).toContain("<!-- ccl:end -->");
    expect(agents.match(/<!-- ccl:begin -->/g)!.length).toBe(1);
  });

  it("produced the smoke-tick claude-status.json under the state dir", () => {
    expect(existsSync(join(repo, ".agent-loops", "bridge", "claude-status.json"))).toBe(true);
  });

  it("the ccl hook commands are repo-relative to the vendored pack (no ../, no home path)", () => {
    const codex = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
    const cclGroups = codex.hooks.SessionStart.filter((g: { _ccl?: boolean }) => g._ccl);
    expect(cclGroups.length).toBe(1);
    const cmd = cclGroups[0].hooks[0].command as string;
    expect(cmd).toContain("packages/claude-codex-loops/bin/");
    expect(cmd).not.toContain("../");
    expect(cmd).not.toContain("/Us" + "ers/");
  });

  it("the GENERATED tree contains zero foreign absolute home paths", () => {
    const HOMES = ["/Us" + "ers/", "/ho" + "me/"];
    for (const f of generatedFiles(repo)) {
      // skip binary/log noise; only text configs matter
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const h of HOMES) {
        expect(text.includes(h), `${f} leaks ${h}`).toBe(false);
      }
    }
  });

  it("PRE-SEEDED foreign hooks survive install untouched", () => {
    const codex = readFileSync(join(repo, ".codex", "hooks.json"), "utf8");
    const claude = readFileSync(join(repo, ".claude", "settings.json"), "utf8");
    expect(codex).toContain(FOREIGN_HOOK_PATH);
    expect(claude).toContain(FOREIGN_CLAUDE_MARK);
  });

  it("is IDEMPOTENT — a second install leaves the managed files byte-identical", () => {
    const managed = [
      join(repo, ".codex", "hooks.json"),
      join(repo, ".claude", "settings.json"),
      join(repo, "AGENTS.md"),
      join(repo, ".claude-codex-loops.json"),
      join(repo, ".gitignore"),
    ];
    const before = managed.map((f) => readFileSync(f, "utf8"));
    const r = runInstall(repo, pack);
    expect(r.status, `second install failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
    const after = managed.map((f) => readFileSync(f, "utf8"));
    for (let i = 0; i < managed.length; i++) {
      expect(after[i], `${managed[i]} changed on re-install`).toBe(before[i]);
    }
    // still exactly one ccl group + one contract block
    const codex = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.SessionStart.filter((g: { _ccl?: boolean }) => g._ccl).length).toBe(1);
  });

  it("backs up each hook target at most ONCE across re-installs (finding #15: no clobber)", () => {
    // First install backed up the FOREIGN (not-yet-ccl) file; every later install
    // sees an already-ccl-tagged file and SKIPS the backup — so exactly one
    // `.bak.` per hook target, never a same-second clobber, never accumulation.
    for (const [dir, name] of [
      [".codex", "hooks.json"],
      [".claude", "settings.json"],
    ]) {
      const baks = readdirSync(join(repo, dir)).filter((f) => f.startsWith(`${name}.bak.`));
      expect(baks.length, `${dir}/${name} backups: ${JSON.stringify(baks)}`).toBe(1);
      // the single backup is the pre-install FOREIGN state (no ccl marker in it)
      const bakText = readFileSync(join(repo, dir, baks[0]), "utf8");
      expect(bakText).not.toContain('"_ccl"');
    }
  });

  it("uninstall removes the ccl blocks, keeps foreign entries, keeps the state dir, writes the kill switch", () => {
    const r = runUninstall(repo, pack);
    expect(r.status, `uninstall failed:\n${r.stdout}\n${r.stderr}`).toBe(0);

    // ccl gone from both hook targets + AGENTS.md
    expect(hasCcl(join(repo, ".codex", "hooks.json"))).toBe(false);
    expect(hasCcl(join(repo, ".claude", "settings.json"))).toBe(false);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).not.toContain("<!-- ccl:begin -->");

    // FOREIGN entries STILL present, untouched
    expect(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")).toContain(FOREIGN_HOOK_PATH);
    expect(readFileSync(join(repo, ".claude", "settings.json"), "utf8")).toContain(
      FOREIGN_CLAUDE_MARK
    );

    // the codex hook target is back to a single foreign SessionStart group
    const codex = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8"));
    expect(codex.hooks.SessionStart.length).toBe(1);
    expect(codex.hooks.SessionStart[0]._ccl).toBeUndefined();

    // kill switch written + state dir kept
    expect(existsSync(join(repo, ".agent-loops", "DISABLED"))).toBe(true);
    expect(existsSync(join(repo, ".agent-loops"))).toBe(true);
  });
});

// ── the foreign path must never live in pack sources ────────────────────────
describe("install/uninstall: the foreign hook path is absent from pack sources", () => {
  it("no pack source file contains the foreign absolute path", () => {
    const offenders: string[] = [];
    const skip = new Set(["node_modules", ".git", ".agent-loops"]);
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (skip.has(e.name)) continue;
          walk(join(dir, e.name));
        } else if (e.isFile()) {
          let text: string;
          try {
            text = readFileSync(join(dir, e.name), "utf8");
          } catch {
            continue;
          }
          if (text.includes(FOREIGN_HOOK_PATH)) offenders.push(join(dir, e.name));
        }
      }
    };
    walk(PACK_SRC);
    expect(offenders).toEqual([]);
  });
});

// ── two clones → distinct labels ────────────────────────────────────────────
describe("install/uninstall: per-clone launchd label uniqueness", () => {
  function labelFor(abspath: string): string {
    const hash8 = createHash("sha256").update(abspath).digest("hex").slice(0, 8);
    return `com.claude-codex-loops.${basename(abspath)}-${hash8}`;
  }

  it("two same-basename repos at different abspaths get different labels", () => {
    const a = "/srv/one/myrepo";
    const b = "/srv/two/myrepo";
    expect(labelFor(a)).not.toBe(labelFor(b));
    expect(labelFor(a)).toContain(".myrepo-");
    expect(labelFor(b)).toContain(".myrepo-");
  });

  it("the label is deterministic for a given abspath (install + uninstall agree)", () => {
    const p = "/srv/one/myrepo";
    expect(labelFor(p)).toBe(labelFor(p));
    expect(labelFor(p)).toMatch(/-[0-9a-f]{8}$/);
  });
});
