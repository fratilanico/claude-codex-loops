// SKILLS-LOCK GATE (ships with the pack).
//
// skills-lock.json is the portable evidence for the pack's skills. Each entry's
// computedHash must equal the sha256 of its SKILL.md as it sits on disk. This
// test recomputes every hash and fails on ANY drift, so a SKILL.md edit that
// forgets to refresh the lock is caught.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const LOCK = JSON.parse(readFileSync(join(PACK_DIR, "skills-lock.json"), "utf8"));

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("skills-lock: hashes match the on-disk SKILL.md files", () => {
  it("declares sourceType subtree", () => {
    expect(LOCK.sourceType).toBe("subtree");
  });

  it("locks exactly the five pack skills", () => {
    const names = LOCK.skills.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual([
      "ccl-loop",
      "pingpong",
      "pingpong-install",
      "pingpong-pr",
      "research-loop",
    ]);
  });

  for (const entry of LOCK.skills as Array<{
    name: string;
    sourceType: string;
    source: string;
    skillPath: string;
    computedHash: string;
  }>) {
    it(`${entry.name}: entry carries source, sourceType, skillPath, computedHash`, () => {
      expect(entry.sourceType).toBe("subtree");
      expect(typeof entry.source).toBe("string");
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.skillPath).toBe(`skills/${entry.name}/SKILL.md`);
      expect(entry.computedHash.startsWith("sha256:")).toBe(true);
    });

    it(`${entry.name}: computedHash == sha256 of ${entry.skillPath}`, () => {
      const actual = "sha256:" + sha256(join(PACK_DIR, entry.skillPath));
      expect(entry.computedHash).toBe(actual);
    });
  }
});
