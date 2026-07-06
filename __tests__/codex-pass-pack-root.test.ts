// CODEX-PASS SKILL PACK-ROOT RESOLUTION GATE (finding #4 parity).
//
// install.sh copies ONLY the skill files + a `.ccl-pack-root` marker into
// <consumer>/.claude/skills/pingpong/ — there is NO <consumer>/.claude/core/.
// codex-pass.mjs pulls its builders (and loop-config) from core/, so
// a static two-up core import would resolve to the non-existent
// <consumer>/.claude/core/codex-pass.mjs and throw ERR_MODULE_NOT_FOUND at
// module load — BEFORE even the kill switch runs. It must instead resolve core
// via the pack root (CCL_PACK_ROOT env > marker > two-up), exactly like
// pingpong.mjs. This proves the relocated copy loads core and reaches its
// runtime brakes instead of hard-crashing on import.
//
// codex is force-absent (PATH=/usr/bin:/bin) so no real pass is ever spawned;
// the success signal is the "codex CLI not found" fail-fast, and the failure
// signal is any ESM relocation break.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACK_DIR = join(__dirname, "..");
const SKILL_MJS = join(PACK_DIR, "skills", "pingpong", "codex-pass.mjs");
const MODULE_MISS = /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/;

let consumer: string;
let installedSkillDir: string;

function runInstalled(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [join(installedSkillDir, "codex-pass.mjs"), "--repo", consumer],
    {
      encoding: "utf8",
      // Strip codex from PATH so no real pass is ever spawned; only module
      // resolution + the codex-absent fail-fast are exercised.
      env: { ...process.env, PATH: "/usr/bin:/bin", ...env },
      timeout: 15_000,
    }
  );
}

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), "ccl-codexpass-packroot-"));
  installedSkillDir = join(consumer, ".claude", "skills", "pingpong");
  mkdirSync(installedSkillDir, { recursive: true });
  // Exactly what install.sh copies: ONLY the skill .mjs (no core/ alongside it).
  copyFileSync(SKILL_MJS, join(installedSkillDir, "codex-pass.mjs"));
  execFileSync("git", ["-C", consumer, "init", "-q"]);
});

afterAll(() => {
  rmSync(consumer, { recursive: true, force: true });
});

describe("codex-pass installed copy: pack-root resolution (no static-import break)", () => {
  it("a bare copy with NO marker and NO env resolves core via two-up? — reproduces the break", () => {
    // Without any marker or env, two-up from <consumer>/.claude/skills/pingpong
    // points at <consumer>/.claude, which has no core/ — the finding-#4 break.
    const r = runInstalled({ CCL_PACK_ROOT: "" });
    expect(MODULE_MISS.test(r.stdout + r.stderr)).toBe(true);
  });

  it("resolves core via the .ccl-pack-root marker and reaches the codex-absent fail-fast", () => {
    writeFileSync(join(installedSkillDir, ".ccl-pack-root"), PACK_DIR + "\n");
    try {
      const out = ((r) => r.stdout + r.stderr)(runInstalled({ CCL_PACK_ROOT: "" }));
      expect(out).not.toMatch(MODULE_MISS);
      expect(out).toMatch(/codex CLI not found/i);
    } finally {
      rmSync(join(installedSkillDir, ".ccl-pack-root"), { force: true });
    }
  });

  it("resolves core via CCL_PACK_ROOT env (no marker needed)", () => {
    const out = ((r) => r.stdout + r.stderr)(runInstalled({ CCL_PACK_ROOT: PACK_DIR }));
    expect(out).not.toMatch(MODULE_MISS);
    expect(out).toMatch(/codex CLI not found/i);
  });
});
