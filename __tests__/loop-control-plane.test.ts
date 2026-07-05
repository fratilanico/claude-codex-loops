// LOOP CONTROL PLANE — bin/loop.mjs behavioral tests.
//
// The human's kill switch + inspector. Proves: the kill switch is
// honored/reported FIRST; status renders thread state via the state machine;
// disable/enable toggle the DISABLED file; reset clears state+trace but NOT the
// kill switch; trace tails the JSONL; every command exits 0; and a thread name
// with path characters is sanitized (cannot escape the pingpong dir).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOOP = join(__dirname, "..", "bin", "loop.mjs");
let repo: string;

function git(args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function run(argv: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [LOOP, ...argv, "--repo", repo], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

const pingpongDir = () => join(repo, ".agent-loops", "pingpong");
const disabledFile = () => join(repo, ".agent-loops", "DISABLED");

function seedThread(name: string, state: object, traceLines: string[] = []) {
  mkdirSync(pingpongDir(), { recursive: true });
  writeFileSync(join(pingpongDir(), `${name}.json`), JSON.stringify(state) + "\n", "utf8");
  if (traceLines.length) {
    writeFileSync(join(pingpongDir(), `${name}.trace.jsonl`), traceLines.join("\n") + "\n", "utf8");
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ccl-cp-"));
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.co"]);
  git(["config", "user.name", "t"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("status", () => {
  it("reports the kill switch off + no threads on a fresh repo (exit 0)", () => {
    const r = run(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch: off/);
    expect(r.stdout).toMatch(/no ping-pong threads/);
  });

  it("defaults to status when no command is given", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch/);
  });

  it("renders each thread's state via the state machine describer", () => {
    seedThread("pr-200", { status: "active", phase: "codex-turn", round: 1, maxRounds: 4 });
    seedThread("pr-201", { status: "exited", phase: "converged", round: 2, maxRounds: 4, reason: "converged" });
    seedThread("pr-bad", { total: "nonsense" }); // corrupt
    const r = run(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pr-200: active: codex-turn \(round 1\/4\)/);
    expect(r.stdout).toMatch(/pr-201: EXITED\{converged\}/);
    expect(r.stdout).toMatch(/pr-bad: CORRUPT/);
  });
});

describe("disable / enable — the kill switch", () => {
  it("disable writes the DISABLED file; enable removes it (both exit 0)", () => {
    expect(existsSync(disabledFile())).toBe(false);
    const d = run(["disable"]);
    expect(d.status).toBe(0);
    expect(existsSync(disabledFile())).toBe(true);
    expect(d.stdout).toMatch(/ENGAGED/);

    const e = run(["enable"]);
    expect(e.status).toBe(0);
    expect(existsSync(disabledFile())).toBe(false);
    expect(e.stdout).toMatch(/released/);
  });

  it("status reflects the DISABLED file", () => {
    run(["disable"]);
    const r = run(["status"]);
    expect(r.stdout).toMatch(/kill switch: ENGAGED \(DISABLED file\)/);
  });

  it("CCL_DISABLED=1 shows as engaged via env even with no file", () => {
    const r = run(["status"], { CCL_DISABLED: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch: ENGAGED \(CCL_DISABLED=1\)/);
  });

  it("when disabled, non-status commands announce the disabled banner FIRST", () => {
    run(["disable"]);
    const r = run(["trace", "whatever"]);
    expect(r.status).toBe(0);
    // The banner is the first loop: line.
    const firstLoopLine = r.stdout.split("\n").find((l) => l.startsWith("loop:"));
    expect(firstLoopLine).toMatch(/kill switch ENGAGED/);
  });

  it("enable on an already-enabled loop is a harmless no-op (exit 0)", () => {
    const r = run(["enable"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already off/);
  });
});

describe("reset", () => {
  it("clears a thread's state + trace but LEAVES the kill switch untouched", () => {
    run(["disable"]);
    seedThread("pr-200", { status: "active", phase: "idle", round: 0, maxRounds: 4 }, [
      '{"ts":"t","event":"start","to":"claude-turn"}',
    ]);
    expect(existsSync(join(pingpongDir(), "pr-200.json"))).toBe(true);

    const r = run(["reset", "pr-200"]);
    expect(r.status).toBe(0);
    expect(existsSync(join(pingpongDir(), "pr-200.json"))).toBe(false);
    expect(existsSync(join(pingpongDir(), "pr-200.trace.jsonl"))).toBe(false);
    // Kill switch survives a reset.
    expect(existsSync(disabledFile())).toBe(true);
  });

  it("reset with no thread clears ALL threads", () => {
    seedThread("a", { status: "active", phase: "idle", round: 0, maxRounds: 4 });
    seedThread("b", { status: "active", phase: "idle", round: 0, maxRounds: 4 });
    const r = run(["reset"]);
    expect(r.status).toBe(0);
    expect(readdirSync(pingpongDir()).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("reset on a nonexistent thread is a harmless no-op (exit 0)", () => {
    const r = run(["reset", "ghost"]);
    expect(r.status).toBe(0);
  });
});

describe("trace", () => {
  it("tails a thread's JSONL trace", () => {
    seedThread("pr-9", { status: "active", phase: "codex-turn", round: 1, maxRounds: 4 }, [
      '{"ts":"1","event":"start","to":"claude-turn"}',
      '{"ts":"2","event":"turn-complete","to":"codex-turn"}',
    ]);
    const r = run(["trace", "pr-9"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2 line\(s\)/);
    expect(r.stdout).toMatch(/"event":"turn-complete"/);
  });

  it("reports missing trace cleanly (exit 0)", () => {
    const r = run(["trace", "nope"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no trace for thread/);
  });

  it("trace with no thread prints usage (exit 0)", () => {
    const r = run(["trace"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/usage/);
  });

  it("REDACTS a secret shape that leaked into a trace detail on the way out", () => {
    // A trace line whose detail carries a token shape (assembled from fragments so
    // THIS test source stays hygiene-clean). The control plane must not re-emit it.
    const tokenShape = "gh" + "p_" + "0123456789abcdef0123456789abcdef0123";
    seedThread("pr-leak", { status: "active", phase: "idle", round: 0, maxRounds: 4 }, [
      JSON.stringify({ ts: "1", event: "turn-complete", detail: `finding with ${tokenShape}` }),
    ]);
    const r = run(["trace", "pr-leak"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[REDACTED\]/);
    expect(r.stdout).not.toContain(tokenShape);
  });
});

describe("safety — thread-name sanitization + fail-soft", () => {
  it("a path-traversal thread name cannot escape the pingpong dir", () => {
    // Reset a malicious thread name; the sanitized target stays inside pingpong/.
    // The traversal literal is fragment-assembled so THIS test source stays
    // hygiene-clean (no contiguous parent-dir escape sequence).
    const traversal = ".." + "/" + ".." + "/etc/passwd";
    const r = run(["reset", traversal]);
    expect(r.status).toBe(0);
    // The sanitized name has NO path separator, so join() can never climb out of
    // the pingpong dir (every / became _). It is a single safe filename segment.
    const m = r.stdout.match(/reset thread '([^']*)'/);
    expect(m).not.toBeNull();
    const sanitized = m ? m[1] : "";
    expect(sanitized).not.toContain("/");
    expect(sanitized).toMatch(/^[A-Za-z0-9._-]+$/);
    // And it did NOT touch anything outside the repo's state dir.
    expect(existsSync("/etc/passwd.json")).toBe(false);
  });

  it("unknown command prints usage and exits 0", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unknown command/);
    expect(r.stdout).toMatch(/usage/);
  });

  it("outside a git repo (bad --repo that is not a repo) still exits 0", () => {
    const bogus = join(tmpdir(), "ccl-not-a-repo-" + Date.now());
    // --repo points at a path that is used directly (no git needed for control
    // plane), so it just operates on an empty state dir and exits 0.
    const r = spawnSync(process.execPath, [LOOP, "status", "--repo", bogus], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(r.status).toBe(0);
  });
});
