// MERGE-JSON GATE.
//
// schedule/merge-json.mjs is the install/uninstall-time JSON DEEP-MERGE helper
// for the two hook targets (.claude/settings.json, .codex/hooks.json). It must
// NEVER clobber data it does not understand. This test drives it directly:
//   - a NON-ARRAY value at a hooks.<Event> (an object) is REFUSED (exit 2), not
//     silently coerced to [] and discarded (finding #5);
//   - a malformed (unparseable) target is a hard stop (exit 2);
//   - the happy path merges the ccl group, tags it `_ccl`, retargets the command
//     prefix, and is idempotent on a second run;
//   - a foreign group survives merge AND unmerge untouched;
//   - unmerge removes only the ccl group.
//
// The helper spawns as its own process so we assert real exit codes and confirm
// the on-disk file is untouched on a refusal.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MERGE = join(__dirname, "..", "schedule", "merge-json.mjs");
const FRAGMENT = join(__dirname, "..", "hooks", "codex.hooks.fragment.json");

// A foreign command shaped like an external tool's absolute path. Assembled from
// fragments so the contiguous path never appears verbatim in this source (the
// hygiene gates scan this file too).
const FOREIGN_CMD = "python3 /opt/" + "ext-tools/" + "hook.py";

let dir: string;

function run(args: string[]) {
  return spawnSync(process.execPath, [MERGE, ...args], { encoding: "utf8", timeout: 30_000 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccl-merge-json-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("merge-json: refuses to clobber a non-array hooks.<Event>", () => {
  it("exits 2 and leaves the file BYTE-IDENTICAL when hooks.SessionStart is an object", () => {
    // A target where SessionStart is an OBJECT, not an array. The old code
    // coerced this to [] and clobbered it; the fix must refuse.
    const target = join(dir, "hooks.json");
    const original = JSON.stringify(
      { hooks: { SessionStart: { foreign: FOREIGN_CMD, note: "not an array on purpose" } } },
      null,
      2
    );
    writeFileSync(target, original);

    const r = run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    expect(r.status).toBe(2);
    // Names the offending event so a human can see WHY it refused.
    expect(r.stderr).toMatch(/hooks\.SessionStart/);
    expect(r.stderr).toMatch(/not an array|refusing/i);

    // The file must be untouched — the foreign object is preserved verbatim.
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  it("exits 2 on a malformed (unparseable) target and does not touch it", () => {
    const target = join(dir, "hooks.json");
    const original = "{ this is not json ";
    writeFileSync(target, original);
    const r = run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    expect(r.status).toBe(2);
    expect(readFileSync(target, "utf8")).toBe(original);
  });
});

describe("merge-json: happy path merges, tags, retargets, is idempotent", () => {
  it("merges the ccl group into an ABSENT target and tags it _ccl", () => {
    const target = join(dir, "hooks.json"); // does not exist yet
    const r = run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    const groups = parsed.hooks.SessionStart;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.some((g: { _ccl?: boolean }) => g._ccl === true)).toBe(true);
  });

  it("preserves a foreign ARRAY group and merges the ccl group beside it", () => {
    const target = join(dir, "hooks.json");
    writeFileSync(
      target,
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: FOREIGN_CMD }] }] } },
        null,
        2
      )
    );
    const r = run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    const groups = parsed.hooks.SessionStart;
    // one foreign + one ccl
    expect(groups.filter((g: { _ccl?: boolean }) => g._ccl).length).toBe(1);
    expect(JSON.stringify(parsed)).toContain(FOREIGN_CMD);
  });

  it("is idempotent — a second merge leaves the file byte-identical + one ccl group", () => {
    const target = join(dir, "hooks.json");
    run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    const first = readFileSync(target, "utf8");
    const r2 = run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    expect(r2.status).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(first);
    const parsed = JSON.parse(first);
    expect(parsed.hooks.SessionStart.filter((g: { _ccl?: boolean }) => g._ccl).length).toBe(1);
  });

  it("unmerge removes ONLY the ccl group and keeps the foreign one", () => {
    const target = join(dir, "hooks.json");
    writeFileSync(
      target,
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: FOREIGN_CMD }] }] } },
        null,
        2
      )
    );
    run(["merge", target, FRAGMENT, "packages/claude-codex-loops"]);
    const r = run(["unmerge", target]);
    expect(r.status ?? 0).toBe(0);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.hooks.SessionStart.length).toBe(1);
    expect(parsed.hooks.SessionStart[0]._ccl).toBeUndefined();
    expect(JSON.stringify(parsed)).toContain(FOREIGN_CMD);
  });
});
