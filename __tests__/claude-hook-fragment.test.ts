// CLAUDE HOOK FRAGMENT GATE (ships with the pack).
//
// hooks/claude.settings.fragment.json is a FRAGMENT that install.sh deep-merges
// into a repo's .claude/settings.json — it is not a full settings file. This
// test asserts the fragment's safety contract:
//   - valid JSON;
//   - SessionStart runs a bounded probe: its command ends with `|| true` and it
//     carries a numeric timeout (so the probe can never fail or hang a session);
//   - Stop is GATED on CCL_TICK_ON_STOP=1 (opt-in), so it does nothing by
//     default;
//   - every command is repo-relative — no absolute home path.
//
// The home-path needle is assembled from fragments so THIS test source never
// contains the literal it forbids.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const FRAGMENT_PATH = join(PACK_DIR, "hooks", "claude.settings.fragment.json");
const RAW = readFileSync(FRAGMENT_PATH, "utf8");

const HOME_PATH = "/Us" + "ers/"; // assembled so it never appears verbatim here

type HookCommand = { type?: string; command?: string; timeout?: number };
type HookGroup = { _ccl?: boolean; hooks?: HookCommand[] };

function commandsFor(fragment: { hooks?: Record<string, HookGroup[]> }, event: string): HookCommand[] {
  const groups = fragment.hooks?.[event] ?? [];
  return groups.flatMap((g) => g.hooks ?? []);
}

describe("claude hook fragment", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(RAW)).not.toThrow();
  });

  const fragment = JSON.parse(RAW);

  it("has SessionStart and Stop hook groups", () => {
    expect(Array.isArray(fragment.hooks?.SessionStart)).toBe(true);
    expect(Array.isArray(fragment.hooks?.Stop)).toBe(true);
  });

  it("SessionStart probe ends with `|| true` and carries a timeout", () => {
    const cmds = commandsFor(fragment, "SessionStart");
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.command).toBeTruthy();
      expect(c.command!.trim().endsWith("|| true")).toBe(true);
      expect(typeof c.timeout).toBe("number");
      expect(c.timeout).toBeGreaterThan(0);
    }
  });

  it("SessionStart timeout is short (<= 8s)", () => {
    const cmds = commandsFor(fragment, "SessionStart");
    for (const c of cmds) {
      expect(c.timeout).toBeLessThanOrEqual(8);
    }
  });

  it("Stop entry is gated behind CCL_TICK_ON_STOP=1", () => {
    const cmds = commandsFor(fragment, "Stop");
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c.command).toContain("CCL_TICK_ON_STOP");
      // The gate compares to the enable value 1 before running the tick.
      expect(c.command).toMatch(/CCL_TICK_ON_STOP[^&|]*=[^&|]*1/);
    }
  });

  it("contains no absolute home path (all commands repo-relative)", () => {
    expect(RAW.includes(HOME_PATH)).toBe(false);
  });

  it("every command references a repo-relative pack bin", () => {
    const all = [...commandsFor(fragment, "SessionStart"), ...commandsFor(fragment, "Stop")];
    for (const c of all) {
      expect(c.command).toContain("./packages/claude-codex-loops/bin/");
    }
  });

  it("every hook group is tagged _ccl for selective uninstall", () => {
    const groups = [...(fragment.hooks.SessionStart ?? []), ...(fragment.hooks.Stop ?? [])];
    for (const g of groups) {
      expect(g._ccl).toBe(true);
    }
  });
});
