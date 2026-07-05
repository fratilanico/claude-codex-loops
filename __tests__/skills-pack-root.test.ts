// SKILL PACK-ROOT RESOLUTION GATE (finding #4).
//
// Every skill .mjs must resolve the REAL installed pack root. When install.sh
// copies a skill into <consumer>/.claude/skills/<name>/, the file's two-up path
// resolves to <consumer>/.claude — NOT the pack — so BIN()/core imports would
// break with MODULE_NOT_FOUND. The skills therefore resolve, in order:
//   1. CCL_PACK_ROOT env;
//   2. a `.ccl-pack-root` marker file install.sh writes next to the copied skill;
//   3. two levels up (the pack-resident layout — the ONLY case that works with a
//      bare two-up).
//
// This test proves all three legs on the two skills that STATICALLY imported
// core (research-loop, ccl-loop — those fail hardest when relocated) and the two
// wrapper skills (pingpong, pingpong-install — PACK_ROOT feeds BIN()/DOCTOR):
//   - pack-resident invocation loads core fine (two-up);
//   - a copy WITHOUT a marker fails to resolve the pack (bug reproduced);
//   - the SAME copy WITH a marker file resolves and runs;
//   - the SAME copy WITH CCL_PACK_ROOT env resolves and runs.
//
// The pack itself is a git repo, so we pass it as --repo to satisfy the skills'
// repo-root resolution; the only thing under test is where they load core from.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PACK_DIR = join(__dirname, "..");
// The pack sits inside a git worktree, so `--repo PACK_DIR` resolves cleanly.
const REPO = PACK_DIR;

type SkillCase = {
  dir: string;
  file: string;
  args: string[];
  // Returns true when the run shows the skill RESOLVED THE WRONG (or no) pack —
  // i.e. the finding-#4 break. Its negation means core/BIN resolved correctly.
  broke: (out: string) => boolean;
};

// research-loop / ccl-loop STATICALLY import core, so a wrong pack root is a hard
// ESM MODULE_NOT_FOUND. pingpong spawns bin/loop.mjs, so a wrong root is a
// "Cannot find module .../.claude/bin/loop.mjs". install-check checks for
// bin/doctor.mjs and, on a wrong root, prints "skipping preflight" instead of
// actually running the doctor — so its break signal is that skip message and its
// success signal is the real doctor preamble.
const MODULE_MISS = /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/;
const SKILLS: SkillCase[] = [
  { dir: "research-loop", file: "research-loop.mjs", args: ["status", "probe"], broke: (o) => MODULE_MISS.test(o) },
  { dir: "ccl-loop", file: "loop.mjs", args: ["status", "probe"], broke: (o) => MODULE_MISS.test(o) },
  { dir: "pingpong", file: "pingpong.mjs", args: ["status"], broke: (o) => MODULE_MISS.test(o) },
  {
    dir: "pingpong-install",
    file: "install-check.mjs",
    args: [],
    // Wrong root → doctor absent → "skipping preflight". Correct root → the real
    // doctor runs and prints its "doctor: preflight for …" preamble.
    broke: (o) => /skipping preflight/.test(o) && !/doctor: preflight for/.test(o),
  },
];

let consumer: string; // a throwaway "installed" consumer tree

function runMjs(mjsPath: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [mjsPath, ...args, "--repo", REPO], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function outOf(r: { stderr: string | null; stdout: string | null }): string {
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), "ccl-skill-packroot-"));
  // Copy ONLY each skill's .mjs into <consumer>/.claude/skills/<name>/ — exactly
  // what install.sh does, but WITHOUT the marker yet (so the bug is reproducible).
  for (const s of SKILLS) {
    const destDir = join(consumer, ".claude", "skills", s.dir);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(PACK_DIR, "skills", s.dir, s.file), join(destDir, s.file));
  }
});

afterAll(() => {
  rmSync(consumer, { recursive: true, force: true });
});

describe("skill pack-root: pack-resident invocation loads core (two-up fallback)", () => {
  for (const s of SKILLS) {
    it(`${s.dir}/${s.file} runs from the pack without a marker or env`, () => {
      const r = runMjs(join(PACK_DIR, "skills", s.dir, s.file), s.args);
      const out = outOf(r);
      expect(s.broke(out), `${s.dir} failed to resolve core in-pack:\n${out}`).toBe(false);
    });
  }
});

describe("skill pack-root: a bare copy into .claude/skills reproduces the break", () => {
  for (const s of SKILLS) {
    it(`${s.dir}/${s.file} copied out-of-tree CANNOT resolve the pack via two-up`, () => {
      const copied = join(consumer, ".claude", "skills", s.dir, s.file);
      // Ensure no marker + no env leaks in.
      const marker = join(consumer, ".claude", "skills", s.dir, ".ccl-pack-root");
      if (existsSync(marker)) rmSync(marker);
      const r = runMjs(copied, s.args, { CCL_PACK_ROOT: "" });
      const out = outOf(r);
      expect(s.broke(out), `${s.dir} unexpectedly resolved core with no marker/env:\n${out}`).toBe(
        true
      );
    });
  }
});

describe("skill pack-root: a .ccl-pack-root marker file resolves the real pack", () => {
  for (const s of SKILLS) {
    it(`${s.dir}/${s.file} loads core once the marker points at the pack`, () => {
      const skillDir = join(consumer, ".claude", "skills", s.dir);
      writeFileSync(join(skillDir, ".ccl-pack-root"), PACK_DIR + "\n");
      const r = runMjs(join(skillDir, s.file), s.args, { CCL_PACK_ROOT: "" });
      const out = outOf(r);
      expect(s.broke(out), `${s.dir} failed to resolve core via marker:\n${out}`).toBe(false);
      // cleanup so the next describe starts marker-free
      rmSync(join(skillDir, ".ccl-pack-root"));
    });
  }
});

describe("skill pack-root: CCL_PACK_ROOT env overrides (no marker needed)", () => {
  for (const s of SKILLS) {
    it(`${s.dir}/${s.file} loads core with CCL_PACK_ROOT set`, () => {
      const copied = join(consumer, ".claude", "skills", s.dir, s.file);
      const r = runMjs(copied, s.args, { CCL_PACK_ROOT: PACK_DIR });
      const out = outOf(r);
      expect(s.broke(out), `${s.dir} failed to resolve core via env:\n${out}`).toBe(false);
    });
  }
});
