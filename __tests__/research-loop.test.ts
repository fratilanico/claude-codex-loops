// /research-loop tests (skills/research-loop/research-loop.mjs).
//
// The research-loop helper is a THIN state + findings-ledger driver over the
// pack's pure core modules — it spawns NO model and hits NO provider API. These
// tests prove the research-specific contract:
//   - a VERIFIED (sourced) finding is appended to the per-topic ledger;
//   - a duplicate finding is deduped by fingerprint (core/ledger.mjs);
//   - an UNSOURCED claim is DROPPED and written to the drop log, never the ledger;
//   - a QUIET round (no new verified findings) exits the loop cleanly.
//
// Run against a throwaway git repo so the git rev-parse repo-root path and the
// on-disk ledger are exercised end to end.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HELPER = join(__dirname, "..", "skills", "research-loop", "research-loop.mjs");
const STATE_DIR = ".agent-loops";

let repo: string;

function git(args: string[]) {
  spawnSync("git", args, { cwd: repo, stdio: "ignore" });
}
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout || "") + (r.stderr || "") };
}

function researchDir() {
  return join(repo, STATE_DIR, "research");
}
function ledgerFile(topic: string) {
  return join(researchDir(), `${topic}.md`);
}
function dropLog(topic: string) {
  return join(researchDir(), `${topic}.dropped.log`);
}
function stateFile(topic: string) {
  return join(researchDir(), `${topic}.state.json`);
}
function readState(topic: string) {
  return JSON.parse(readFileSync(stateFile(topic), "utf8"));
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "research-loop-"));
  git(["init", "-q"]);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("/research-loop: verified findings ledger", () => {
  it("start seeds a per-topic ledger and state", () => {
    const r = run(["start", "hvac-market"]);
    expect(r.status).toBe(0);
    expect(existsSync(ledgerFile("hvac-market"))).toBe(true);
    expect(existsSync(stateFile("hvac-market"))).toBe(true);
    const s = readState("hvac-market");
    expect(s.machine.status).toBe("active");
    expect(s.seen).toEqual([]);
  });

  it("appends a sourced finding to the ledger", () => {
    run(["start", "topic"]);
    const r = run([
      "record",
      "topic",
      "--finding",
      "Widget adoption grew 30% YoY.",
      "--source",
      "https://example.com/report",
    ]);
    expect(r.status).toBe(0);
    const text = readFileSync(ledgerFile("topic"), "utf8");
    expect(text).toMatch(/Widget adoption grew 30% YoY\./);
    expect(text).toMatch(/example\.com\/report/);
    expect(readState("topic").seen.length).toBe(1);
    expect(readState("topic").roundNew).toBe(1);
  });

  it("dedupes an identical finding by fingerprint (not re-appended)", () => {
    run(["start", "topic"]);
    const args = [
      "record",
      "topic",
      "--finding",
      "Same claim.",
      "--source",
      "https://a.example/x",
    ];
    run(args);
    const r = run(args);
    expect(r.stdout).toMatch(/duplicate/);
    // Only ONE bullet for the claim.
    const bullets = readFileSync(ledgerFile("topic"), "utf8").match(/- Same claim\./g) || [];
    expect(bullets.length).toBe(1);
    expect(readState("topic").seen.length).toBe(1);
  });
});

describe("/research-loop: unsourced claim dropped + logged", () => {
  it("drops a finding with no --source and logs it, never touching the ledger", () => {
    run(["start", "topic"]);
    const ledgerBefore = readFileSync(ledgerFile("topic"), "utf8");
    const r = run(["record", "topic", "--finding", "Unsourced guess about the market."]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DROPPED/);
    // Ledger unchanged.
    expect(readFileSync(ledgerFile("topic"), "utf8")).toBe(ledgerBefore);
    // Drop log written with the claim.
    expect(existsSync(dropLog("topic"))).toBe(true);
    const log = readFileSync(dropLog("topic"), "utf8");
    expect(log).toMatch(/DROPPED \(no source\)/);
    expect(log).toMatch(/Unsourced guess about the market\./);
    // No finding counted.
    expect(readState("topic").seen.length).toBe(0);
  });
});

describe("/research-loop: quiet round → exit", () => {
  it("a round with new findings advances; a following quiet round exits {quiet}", () => {
    run(["start", "topic"]);
    run([
      "record",
      "topic",
      "--finding",
      "A verified fact.",
      "--source",
      "https://s.example/1",
    ]);
    // Round with a new finding advances (still active).
    let r = run(["round", "topic"]);
    expect(r.status).toBe(0);
    let s = readState("topic");
    expect(s.machine.status).toBe("active");
    expect(s.roundNew).toBe(0); // per-round counter reset
    expect(s.machine.round).toBe(1);
    // Next round adds nothing new → quiet exit.
    r = run(["round", "topic"]);
    s = readState("topic");
    expect(s.machine.status).toBe("exited");
    expect(s.machine.phase).toBe("quiet");
    expect(r.stdout).toMatch(/DONE/);
  });

  it("a first round with zero verified findings exits {quiet} immediately", () => {
    run(["start", "topic"]);
    const r = run(["round", "topic"]);
    const s = readState("topic");
    expect(s.machine.status).toBe("exited");
    expect(s.machine.phase).toBe("quiet");
    expect(r.stdout).toMatch(/quiet round/);
  });

  it("recording after exit is refused (loop already exited)", () => {
    run(["start", "topic"]);
    run(["round", "topic"]); // quiet → exit
    const r = run([
      "record",
      "topic",
      "--finding",
      "Late finding.",
      "--source",
      "https://s.example/late",
    ]);
    expect(r.stdout).toMatch(/already exited/);
    expect(readFileSync(ledgerFile("topic"), "utf8")).not.toMatch(/Late finding\./);
  });
});

describe("/research-loop: maxRounds bound", () => {
  it("keeps advancing rounds until maxRounds → EXIT{max-rounds}", () => {
    run(["start", "topic", "--max-rounds", "2"]);
    // Round 0: add a finding, close → round 1 (active).
    run(["record", "topic", "--finding", "F1", "--source", "https://s/1"]);
    run(["round", "topic"]);
    expect(readState("topic").machine.round).toBe(1);
    // Round 1: add a finding, close → round 2 == maxRounds → exit.
    run(["record", "topic", "--finding", "F2", "--source", "https://s/2"]);
    const r = run(["round", "topic"]);
    const s = readState("topic");
    expect(s.machine.status).toBe("exited");
    expect(s.machine.phase).toBe("max-rounds");
    expect(r.stdout).toMatch(/STOP/);
  });
});

describe("/research-loop: kill switch", () => {
  it("CCL_DISABLED=1 makes record a no-op", () => {
    run(["start", "topic"]);
    const before = readFileSync(ledgerFile("topic"), "utf8");
    const r = run(
      ["record", "topic", "--finding", "X", "--source", "https://s/x"],
      { CCL_DISABLED: "1" }
    );
    expect(r.stdout).toMatch(/kill switch ENGAGED/);
    expect(readFileSync(ledgerFile("topic"), "utf8")).toBe(before);
  });
});
