// HEADLESS CODEX DRIVER — bakes in the three live-proven `codex exec` hang
// safeguards so no agent ever hand-types them (FOR-AGENTS §4):
//   1. stdin must be closed ('ignore') or exec blocks forever pre-session;
//   2. --dangerously-bypass-hook-trust or the pack's own .codex/hooks.json
//      trust prompt hangs an unattended run;
//   3. --ignore-user-config or heavy user MCP servers stall startup minutes.
// Pure builder lives in core/ (tested here); skills/pingpong/codex-pass.mjs is the thin
// spawn wrapper (spawned below — never with a real codex on PATH).

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildCodexPassArgs, buildCodexPassPrompt } from "../core/codex-pass.mjs";

const BIN = join(__dirname, "..", "skills", "pingpong", "codex-pass.mjs");

describe("buildCodexPassArgs: the three hang safeguards are always present", () => {
  const args = buildCodexPassArgs("/some/repo", buildCodexPassPrompt());

  it("closes stdin by contract (spawn stdio directive, not a shell redirect)", () => {
    expect(args.stdin).toBe("ignore");
  });

  it("bypasses the hook-trust prompt and heavy user config, read-only sandbox", () => {
    expect(args.argv).toContain("--dangerously-bypass-hook-trust");
    expect(args.argv).toContain("--ignore-user-config");
    expect(args.argv).toContain("read-only");
    const cIdx = args.argv.indexOf("-C");
    expect(args.argv[cIdx + 1]).toBe("/some/repo");
  });

  it("first argv token is 'exec' and the prompt is the last token", () => {
    expect(args.argv[0]).toBe("exec");
    expect(args.argv[args.argv.length - 1]).toBe(buildCodexPassPrompt());
  });
});

describe("buildCodexPassPrompt: contract wording", () => {
  it("default pass demands ONE pass, CCL-FINDING lines, one CCL-EXIT", () => {
    const p = buildCodexPassPrompt();
    expect(p).toMatch(/exactly ONE review pass/i);
    expect(p).toContain("CCL-FINDING");
    expect(p).toContain("CCL-EXIT");
  });

  it("confirm mode references the prior finding it re-checks", () => {
    const p = buildCodexPassPrompt({ confirm: "prior finding text" });
    expect(p).toContain("prior finding text");
    expect(p).toMatch(/confirmation pass/i);
  });
});

describe("bin/codex-pass.mjs: brakes and graceful failure (no real codex ever spawned)", () => {
  function makeRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "ccl-codexpass-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    return repo;
  }

  it("honors the kill switch FIRST (exit 0, announces, spawns nothing)", () => {
    const repo = makeRepo();
    try {
      mkdirSync(join(repo, ".agent-loops"), { recursive: true });
      writeFileSync(join(repo, ".agent-loops", "DISABLED"), "demo\n", "utf8");
      const r = spawnSync(process.execPath, [BIN, "--repo", repo], {
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin" }, // no codex on PATH either
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/kill switch/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fails fast and helpfully when the codex CLI is absent", () => {
    const repo = makeRepo();
    try {
      const r = spawnSync(process.execPath, [BIN, "--repo", repo], {
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin" },
        timeout: 15_000,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/codex CLI not found/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
