// SINGLE-FLIGHT LOCK + KILL SWITCH — the NEW safety additions in bin/loop-tick.mjs.
//
// The launchd plist fires the tick on a fixed StartInterval with RunAtLoad=true.
// If one tick runs long (slow git fetch, big session scan) the next fire could
// overlap it. The atomic-mkdir lock guarantees only ONE tick touches state at a
// time; a second concurrent tick must log "lock-held" and exit 0 IMMEDIATELY
// without mutating any bridge state. The kill switch (DISABLED file or
// CCL_DISABLED=1) is honored BEFORE the lock and before any work.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TICK = join(__dirname, "..", "bin", "loop-tick.mjs");

let repo: string;

function git(args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function runTick(extraArgs: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [TICK, "--repo", repo, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ccl-lock-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.co"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("single-flight lock", () => {
  it("a normal tick acquires the lock, writes state, then RELEASES it", () => {
    const r = runTick();
    expect(r.status).toBe(0);
    // Lock dir must be gone after a clean run.
    expect(existsSync(join(repo, ".agent-loops", "tick.lock"))).toBe(false);
    // A tick wrote the sync-back ack.
    expect(existsSync(join(repo, ".agent-loops", "bridge", "codex-status.json"))).toBe(true);
  });

  it("a second tick, with the lock already held, exits 0 fast with 'lock-held' and touches NO state", () => {
    const stateDir = join(repo, ".agent-loops");
    const bridgeDir = join(stateDir, "bridge");
    // Simulate tick #1 mid-run: the lock dir is held.
    mkdirSync(join(stateDir, "tick.lock"), { recursive: true });
    // No bridge dir yet — prove the locked-out tick creates none.
    expect(existsSync(bridgeDir)).toBe(false);

    const start = Date.now();
    const r = runTick();
    const elapsed = Date.now() - start;

    expect(r.status).toBe(0);
    expect(elapsed).toBeLessThan(2000); // must bail well under 2s
    expect(r.stdout).toMatch(/lock-held/);
    // State untouched: the locked-out tick wrote no ack and created no bridge dir.
    expect(existsSync(bridgeDir)).toBe(false);
    expect(existsSync(join(bridgeDir, "codex-status.json"))).toBe(false);
    // The pre-existing lock is left in place (owner tick releases it, not us).
    expect(existsSync(join(stateDir, "tick.lock"))).toBe(true);
  });

  it("two ticks launched concurrently: exactly one does the work, the other reports lock-held", async () => {
    const launch = () =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn(process.execPath, [TICK, "--repo", repo], {
          env: { ...process.env },
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (out += d.toString()));
        child.on("close", (code) => resolve({ code: code ?? 0, out }));
      });

    const [a, b] = await Promise.all([launch(), launch()]);
    // Both must exit 0 (fail-soft contract).
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // At most one may report lock-held; the other did the work. (If they don't
    // truly overlap in scheduling, zero report lock-held and both ran serially —
    // still safe because the lock serialized them. So: NOT BOTH may lock out.)
    const lockedOut = [a, b].filter((r) => /lock-held/.test(r.out)).length;
    expect(lockedOut).toBeLessThanOrEqual(1);
    // Whichever ran wrote the ack.
    expect(existsSync(join(repo, ".agent-loops", "bridge", "codex-status.json"))).toBe(true);
    // Lock is released at the end (no orphan).
    expect(existsSync(join(repo, ".agent-loops", "tick.lock"))).toBe(false);
  });

  it("reclaims a STALE lock (older than the TTL) so a crashed tick cannot wedge the loop forever", () => {
    const stateDir = join(repo, ".agent-loops");
    const lockDir = join(stateDir, "tick.lock");
    mkdirSync(lockDir, { recursive: true });
    // Back-date the lock's mtime well past the 15-min TTL.
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    // utimesSync needs fs; use a tiny inline node call to avoid an extra import.
    execFileSync(process.execPath, [
      "-e",
      `require('fs').utimesSync(${JSON.stringify(lockDir)}, new Date(${old.getTime()}), new Date(${old.getTime()}))`,
    ]);
    const r = runTick();
    expect(r.status).toBe(0);
    // The stale lock was reclaimed → the tick actually ran and wrote the ack.
    expect(existsSync(join(stateDir, "bridge", "codex-status.json"))).toBe(true);
    // And released its own lock at the end.
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("kill switch — honored before the lock and before any work", () => {
  it("a DISABLED file makes the tick skip (exit 0, no bridge state)", () => {
    const stateDir = join(repo, ".agent-loops");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "DISABLED"), "", "utf8");
    const r = runTick();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/disabled/i);
    expect(existsSync(join(stateDir, "bridge"))).toBe(false);
  });

  it("CCL_DISABLED=1 makes the tick skip (exit 0, no bridge state)", () => {
    const r = runTick([], { CCL_DISABLED: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/disabled/i);
    expect(existsSync(join(repo, ".agent-loops", "bridge"))).toBe(false);
  });

  it("the kill switch wins even when NO lock is held (checked first)", () => {
    // No lock pre-created; DISABLED still short-circuits before any lock attempt.
    const stateDir = join(repo, ".agent-loops");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "DISABLED"), "", "utf8");
    const r = runTick();
    expect(r.status).toBe(0);
    // No tick.lock was ever created (kill switch returned before acquireLock).
    expect(existsSync(join(stateDir, "tick.lock"))).toBe(false);
  });
});
