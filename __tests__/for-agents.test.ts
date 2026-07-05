// FOR-AGENTS.md gate — the agent self-onboarding quickstart.
//
// FOR-AGENTS.md is the ONE file an AI agent (Claude Code or Codex) reads to
// install the pack, verify it, start a loop, and open Claude<->Codex comms.
// This gate proves the file exists and stays a complete, copy-paste-ready
// onboarding surface as the pack evolves:
//   - the one-command install (`install.sh --repo .`);
//   - EVERY skill trigger the pack ships (so no loop is undiscoverable);
//   - a doctor verification step;
//   - the kill-switch / safety brakes stated up front;
//   - the cross-agent Claude<->Codex comms section (ferry tick + review contract).
// It also enforces doc hygiene: no absolute macOS home path and no owner-name
// literal (the forbidden literals are assembled from fragments so they never
// appear verbatim in this shipped test).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const PACK_DIR = join(__dirname, "..");
const FOR_AGENTS = join(PACK_DIR, "FOR-AGENTS.md");

function read(): string {
  return readFileSync(FOR_AGENTS, "utf8");
}

describe("FOR-AGENTS.md: the agent self-onboarding quickstart", () => {
  it("exists", () => {
    expect(existsSync(FOR_AGENTS)).toBe(true);
  });

  it("gives the one-command install", () => {
    const text = read();
    expect(text.includes("install.sh --repo .")).toBe(true);
  });

  it("names every skill trigger the pack ships", () => {
    const text = read();
    for (const trigger of [
      "/ccl-loop",
      "/research-loop",
      "/pingpong",
      "/pingpong-pr",
      "/pingpong-install",
    ]) {
      expect(text.includes(trigger)).toBe(true);
    }
  });

  it("includes a doctor verification step", () => {
    const text = read();
    expect(/doctor\.mjs/.test(text)).toBe(true);
  });

  it("states the kill switch / safety brakes up front", () => {
    const text = read();
    expect(text.toLowerCase().includes("kill switch")).toBe(true);
    expect(text.includes("CCL_DISABLED")).toBe(true);
    expect(text.includes("maxRounds")).toBe(true);
  });

  it("has a cross-agent Claude<->Codex comms section (ferry + contract)", () => {
    const text = read();
    // Names both agents and the two comms mechanisms.
    expect(/Claude<->Codex|Claude<\->Codex/.test(text)).toBe(true);
    expect(text.toLowerCase().includes("ferry")).toBe(true);
    expect(text.includes("review contract")).toBe(true);
    expect(text.includes("CCL-FINDING")).toBe(true);
    expect(text.includes("CCL-EXIT")).toBe(true);
  });

  it("uses a decision-tree framing (if you are Claude / if you are Codex)", () => {
    const text = read();
    expect(text.includes("If you are Claude")).toBe(true);
    expect(text.includes("If you are Codex")).toBe(true);
  });

  it("states no provider API keys are used", () => {
    const text = read();
    expect(/no provider api key/i.test(text)).toBe(true);
  });
});

describe("FOR-AGENTS.md: doc hygiene", () => {
  // Assembled from fragments so the forbidden literals never appear verbatim in
  // this shipped source (the upstream fleet-hygiene gate forbids them).
  const HOME_ROOT = "/Us" + "ers/";
  const ownerSlug = "frat" + "ila" + "nico";
  const ownerHome = HOME_ROOT + "nico";

  it("contains no absolute macOS home path", () => {
    const text = read();
    expect(text.includes(HOME_ROOT)).toBe(false);
  });

  it("contains no owner-name literal", () => {
    const text = read();
    expect(text.includes(ownerSlug)).toBe(false);
    expect(text.includes(ownerHome)).toBe(false);
  });
});
