// /ccl-loop STATE-HELPER tests (skills/ccl-loop/loop.mjs).
//
// The general-loop skill helper is a THIN state driver over the pack's pure
// core/pingpong-state.mjs — it spawns NO model. These tests prove:
//   - start → step → status → stop drive the bounded state machine correctly;
//   - the named loop's state file round-trips under <stateDir>/loops/<name>.json;
//   - reaching maxRounds routes to the STICKY {max-rounds} terminal (later steps
//     are no-ops that keep the terminal);
//   - the kill switch (DISABLED file / CCL_DISABLED=1) is honored first and does
//     no work.
//
// We run the real helper as a child process against a throwaway git repo so the
// git rev-parse repo-root path and the on-disk state are exercised end to end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HELPER = join(__dirname, "..", "skills", "ccl-loop", "loop.mjs");
const STATE_DIR = ".agent-loops";

let repo: string;

function git(args: string[]) {
  spawnSync("git", args, { cwd: repo, stdio: "ignore" });
}

// Run the helper inside the temp repo. Returns { status, stdout }.
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || "") };
}

function stateFile(name: string) {
  return join(repo, STATE_DIR, "loops", `${name}.json`);
}
function readState(name: string) {
  return JSON.parse(readFileSync(stateFile(name), "utf8"));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ccl-loop-"));
  git(["init", "-q"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("/ccl-loop helper: start → step → status → stop", () => {
  it("start creates a running loop at round 0 and writes state to disk", () => {
    const r = run(["start", "mytask"]);
    expect(r.status).toBe(0);
    expect(existsSync(stateFile("mytask"))).toBe(true);
    const s = readState("mytask");
    expect(s.status).toBe("active");
    expect(s.phase).toBe("claude-turn"); // idle → running (maker up)
    expect(s.round).toBe(0);
    expect(r.stdout).toMatch(/started/);
    expect(r.stdout).toMatch(/CONTINUE/);
  });

  it("step advances the machine and the state round-trips", () => {
    run(["start", "mytask"]);
    // One turn-complete (claude leg) → codex-turn, same round.
    let r = run(["step", "mytask", "progress"]);
    expect(r.status).toBe(0);
    let s = readState("mytask");
    expect(s.phase).toBe("codex-turn");
    expect(s.round).toBe(0);
    // Second turn-complete (codex leg) closes round 0 → round 1, claude-turn.
    r = run(["step", "mytask", "progress"]);
    s = readState("mytask");
    expect(s.phase).toBe("claude-turn");
    expect(s.round).toBe(1);
  });

  it("converged outcome exits cleanly to a sticky terminal", () => {
    run(["start", "mytask"]);
    const r = run(["step", "mytask", "converged"]);
    expect(r.status).toBe(0);
    const s = readState("mytask");
    expect(s.status).toBe("exited");
    expect(s.phase).toBe("converged");
    expect(r.stdout).toMatch(/DONE/);
    // A later step is a no-op that keeps the terminal (never re-arms).
    run(["step", "mytask", "progress"]);
    expect(readState("mytask").phase).toBe("converged");
  });

  it("status prints state and touches nothing", () => {
    run(["start", "mytask"]);
    const before = readFileSync(stateFile("mytask"), "utf8");
    const r = run(["status", "mytask"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/active/);
    expect(readFileSync(stateFile("mytask"), "utf8")).toBe(before);
  });

  it("stop forces EXIT{disabled} and the terminal is sticky", () => {
    run(["start", "mytask"]);
    const r = run(["stop", "mytask"]);
    expect(r.status).toBe(0);
    const s = readState("mytask");
    expect(s.status).toBe("exited");
    expect(s.phase).toBe("disabled");
    // step after stop is a no-op.
    run(["step", "mytask", "progress"]);
    expect(readState("mytask").phase).toBe("disabled");
  });

  it("step on an unknown loop does not create state", () => {
    const r = run(["step", "ghost", "progress"]);
    expect(r.status).toBe(0);
    expect(existsSync(stateFile("ghost"))).toBe(false);
    expect(r.stdout).toMatch(/no such loop/);
  });
});

describe("/ccl-loop helper: maxRounds → sticky terminal", () => {
  it("reaching maxRounds routes to a sticky {max-rounds} exit", () => {
    // maxRounds = 1 → the FIRST closed round hits the cap.
    run(["start", "capped", "--max-rounds", "1"]);
    expect(readState("capped").maxRounds).toBe(1);
    run(["step", "capped", "progress"]); // claude leg → codex-turn
    const r = run(["step", "capped", "progress"]); // codex leg closes round 0 → round 1 == maxRounds
    const s = readState("capped");
    expect(s.status).toBe("exited");
    expect(s.phase).toBe("max-rounds");
    expect(r.stdout).toMatch(/STOP/);
    // Sticky: further steps never revive it.
    run(["step", "capped", "progress"]);
    expect(readState("capped").phase).toBe("max-rounds");
  });

  it("no-change outcome routes toward no-progress terminal", () => {
    run(["start", "stuck"]);
    const r = run(["step", "stuck", "no-change"]);
    const s = readState("stuck");
    expect(s.status).toBe("exited");
    expect(s.phase).toBe("no-progress");
    expect(r.stdout).toMatch(/STOP/);
  });
});

describe("/ccl-loop helper: kill switch honored first", () => {
  it("CCL_DISABLED=1 makes start do no work", () => {
    const r = run(["start", "mytask"], { CCL_DISABLED: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch ENGAGED/);
    expect(existsSync(stateFile("mytask"))).toBe(false);
  });

  it("CCL_DISABLED=1 makes step a no-op (state untouched)", () => {
    run(["start", "mytask"]);
    const before = readFileSync(stateFile("mytask"), "utf8");
    const r = run(["step", "mytask", "progress"], { CCL_DISABLED: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/kill switch ENGAGED/);
    expect(readFileSync(stateFile("mytask"), "utf8")).toBe(before);
  });
});
