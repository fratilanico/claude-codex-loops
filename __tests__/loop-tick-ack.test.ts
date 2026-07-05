// LOOP-TICK ACK SCOPE-ANCHOR — the emitted sync-back packet MUST carry
// `lastAckSha` (finding #2).
//
// The Codex review-contract (codex/AGENTS.review-contract.md §b) tells the peer
// to EXIT blocked-needs-human when `lastAckSha` is missing and to scope its
// review to `git diff <lastAckSha>..HEAD`. So if bin/loop-tick.mjs ever emitted a
// packet without that anchor, the peer would dead-end every pass and never do a
// scoped review. This test runs the REAL tick against a REAL throwaway git repo,
// reads the EMITTED <agent>-status.json off disk, and asserts the anchor is
// present, is a full 40-char sha, and equals the repo HEAD.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TICK = join(__dirname, "..", "bin", "loop-tick.mjs");

let repo: string;
let emptyHome: string; // a HOME with no ~/.codex so the nested watch is a no-op

function git(args: string[]) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

// Run the tick with HOME pointed at an EMPTY dir: the sibling watch-codex sees no
// ~/.codex and exits without touching the findings.log we seed, so the test is
// hermetic (it does not read the developer's real ~/.codex sessions).
function runTick(extraArgs: string[] = []) {
  return spawnSync(process.execPath, [TICK, "--repo", repo, ...extraArgs], {
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome, CODEX_LOOP_FETCH: "0" },
    timeout: 30_000,
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ccl-tick-ack-"));
  emptyHome = mkdtempSync(join(tmpdir(), "ccl-tick-home-"));
  // A real one-commit git repo so `git rev-parse HEAD` resolves a real sha.
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(repo, "a.txt"), "hello\n", "utf8");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

// Seed the shared findings.log the way watch-codex would, with a peer CCL-EXIT line.
function seedFindingsLog(lines: string[]) {
  const stateDir = join(repo, ".agent-loops");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "findings.log"), lines.join("\n") + "\n", "utf8");
}

describe("loop-tick emits lastAckSha in the sync-back ack", () => {
  it("writes a codex-status.json whose parsed JSON carries lastAckSha === HEAD", () => {
    const head = git(["rev-parse", "HEAD"]);

    const r = runTick(["--agent", "codex"]);
    expect(r.status).toBe(0);

    // The ack lands under <stateDir>/bridge/<agent>-status.json (stateDir default
    // .agent-loops).
    const statusFile = join(repo, ".agent-loops", "bridge", "codex-status.json");
    const packet = JSON.parse(readFileSync(statusFile, "utf8"));

    // The anchor field is PRESENT (the whole point — its absence dead-ends the peer).
    expect(Object.prototype.hasOwnProperty.call(packet, "lastAckSha")).toBe(true);
    // …and it is the real HEAD sha (a full 40-char hex), the base the peer diffs FROM.
    expect(packet.lastAckSha).toBe(head);
    expect(packet.lastAckSha).toMatch(/^[0-9a-f]{40}$/);
    // Sanity: the packet is the versioned ack shape and the short head is separate.
    expect(packet.version).toBe(1);
    expect(head.startsWith(packet.claude.head)).toBe(true);
  });
});

describe("loop-tick consumes peer CCL-EXIT lines and advances the ping-pong state", () => {
  it("maps a seeded [CCL-EXIT] converged onto the thread state and surfaces the terminal", () => {
    // Seed the shared log exactly as watch-codex writes a peer terminal.
    seedFindingsLog([
      "  [HIGH] some earlier finding the peer raised",
      "  [CCL-EXIT] converged",
    ]);

    const r = runTick(["--agent", "codex"]);
    expect(r.status).toBe(0);

    // The per-thread ping-pong state is persisted under <stateDir>/pingpong/<agent>.json
    // — the SAME file the `loop` control plane reads — and is the terminal the peer drove.
    const threadFile = join(repo, ".agent-loops", "pingpong", "codex.json");
    expect(existsSync(threadFile)).toBe(true);
    const state = JSON.parse(readFileSync(threadFile, "utf8"));
    expect(state.status).toBe("exited");
    expect(state.phase).toBe("converged");
    expect(state.reason).toBe("converged");

    // The ack surfaces the terminal so the peer/human sees the loop reached an exit.
    const packet = JSON.parse(
      readFileSync(join(repo, ".agent-loops", "bridge", "codex-status.json"), "utf8")
    );
    expect(packet.openQuestions.some((q: string) => /terminal 'converged'/.test(q))).toBe(true);
    // …and stdout announces the CCL-EXIT-driven state advance.
    expect(r.stdout).toMatch(/EXIT\{converged\}/);
  });

  it("is sticky across ticks — a later blocked-needs-human never overwrites converged", () => {
    seedFindingsLog(["  [CCL-EXIT] converged"]);
    expect(runTick(["--agent", "codex"]).status).toBe(0);

    // A second peer exit lands in the log on a later pass…
    seedFindingsLog(["  [CCL-EXIT] converged", "  [CCL-EXIT] blocked-needs-human"]);
    expect(runTick(["--agent", "codex"]).status).toBe(0);

    // …but the already-terminal thread stays converged (stickiness holds end-to-end).
    const state = JSON.parse(
      readFileSync(join(repo, ".agent-loops", "pingpong", "codex.json"), "utf8")
    );
    expect(state.phase).toBe("converged");
  });

  it("does NOT create a terminal thread state when the peer emitted no CCL-EXIT", () => {
    seedFindingsLog(["  [NORMAL] just a finding, no exit yet"]);
    const r = runTick(["--agent", "codex"]);
    expect(r.status).toBe(0);
    // A fresh idle state may be written, but it must not be a terminal.
    const threadFile = join(repo, ".agent-loops", "pingpong", "codex.json");
    if (existsSync(threadFile)) {
      const state = JSON.parse(readFileSync(threadFile, "utf8"));
      expect(state.status).not.toBe("exited");
    }
  });

  // finding #2 (Codex P2): the scheduled tick must load the installed repo config
  // file so DEFAULTS<file<env<CLI precedence holds — env-only made the file inert.
  it("honors the installed .claude-codex-loops.json config file (stateDir from the file layer)", () => {
    writeFileSync(
      join(repo, ".claude-codex-loops.json"),
      JSON.stringify({ stateDir: ".custom-state" }) + "\n",
      "utf8"
    );
    const r = runTick(["--agent", "codex"]);
    expect(r.status).toBe(0);
    // The ack landed under the FILE-specified stateDir, not the default one.
    expect(existsSync(join(repo, ".custom-state", "bridge", "codex-status.json"))).toBe(true);
    expect(existsSync(join(repo, ".agent-loops"))).toBe(false);
  });

  // finding #3 (Codex P2): --probe / --digest-only must touch NOTHING on disk
  // (the /pingpong pull "inspect-only" contract). No state dir, no lock, no writes.
  it("--probe touches nothing on disk", () => {
    const r = runTick(["--probe"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0); // it still prints a digest
    // A read-only probe created no state dir at all.
    expect(existsSync(join(repo, ".agent-loops"))).toBe(false);
  });
});
