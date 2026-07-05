// WATCH ROUND-TRIP — the one real NEW-code delta in bin/watch-codex.mjs is
// structured CCL-FINDING / CCL-EXIT marker extraction from peer session rollouts.
//
// This feeds a SYNTHETIC rollout JSONL (per the ~/.codex rollout contract:
// session_meta first line, then event_msg/response_item records) into a fake
// ~/.codex/sessions and asserts the watcher extracts ≥1 CCL-FINDING and records
// the CCL-EXIT. It also proves: out-of-scope sessions are ignored, and an
// unrecognized rollout format emits an explicit log line (never silent).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WATCH = join(__dirname, "..", "bin", "watch-codex.mjs");
const SCOPE = "roundtrip-repo"; // the repo scope both the rollout cwd and env use

let home: string;
let repo: string;
let sessionsDir: string;

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// A minimal in-scope rollout: session_meta (cwd matches SCOPE) + an assistant
// message carrying two CCL markers + a heuristic-only finding.
function sessionMeta(cwd: string) {
  return {
    type: "session_meta",
    payload: { id: "sess-1", cwd, timestamp: "2026-07-04T00:00:00Z" },
  };
}
function agentMessage(message: string) {
  return { type: "event_msg", payload: { type: "agent_message", message } };
}
function assistantResponse(text: string) {
  return {
    type: "response_item",
    payload: { role: "assistant", content: [{ type: "output_text", text }] },
  };
}

function writeRollout(name: string, records: unknown[]) {
  const p = join(sessionsDir, name);
  writeFileSync(p, jsonl(records), "utf8");
  return p;
}

function runWatch(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [WATCH, "--repo", repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home, // homedir() → this, so ~/.codex resolves under the fixture
      CODEX_WATCH_REPO_SCOPE: SCOPE, // scope the watcher to our synthetic cwd
      ...env,
    },
    timeout: 30_000,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ccl-rt-home-"));
  repo = mkdtempSync(join(tmpdir(), `ccl-rt-${SCOPE}-`));
  sessionsDir = join(home, ".codex", "sessions", "2026", "07", "04");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("watch-codex round-trip: CCL marker extraction", () => {
  it("extracts >=1 CCL-FINDING from a synthetic in-scope rollout and records the CCL-EXIT", () => {
    const cwd = `/somewhere/${SCOPE}`;
    writeRollout("rollout-a.jsonl", [
      sessionMeta(cwd),
      agentMessage(
        [
          "Reviewed the diff.",
          "CCL-FINDING [HIGH] auth check missing on the admin route — must fail closed",
          "CCL-FINDING [NORMAL] rename this helper for clarity",
          "CCL-EXIT blocked-needs-human",
        ].join("\n")
      ),
    ]);

    const r = runWatch();
    expect(r.status).toBe(0);

    // The findings log is written under <stateDir>/findings.log (per-clone).
    const findingsLog = join(repo, ".agent-loops", "findings.log");
    expect(existsSync(findingsLog)).toBe(true);
    const log = readFileSync(findingsLog, "utf8");

    // >=1 CCL-FINDING extracted (the HIGH one), surfaced as a [HIGH] finding line.
    expect(log).toMatch(/\[HIGH\] auth check missing on the admin route/);
    // The NORMAL marker finding is present too.
    expect(log).toMatch(/\[NORMAL\] rename this helper for clarity/);
    // The CCL-EXIT state is recorded.
    expect(log).toMatch(/\[CCL-EXIT\] blocked-needs-human/);
    // stdout announced the marker extraction; the summary reports the marker count.
    expect(r.stdout).toMatch(/CCL-FINDING/);
    expect(r.stdout).toMatch(/2 CCL-marker/); // 2 marker findings extracted
    // The persisted report summary carries the CCL-marker= count too.
    expect(log).toMatch(/CCL-marker=2/);
  });

  it("redacts a secret that STRADDLES the 180-char truncation cut (no partial token leaks)", () => {
    // Finding #7: the summary is truncate(redact(...)), not redact(truncate(...)).
    // A secret placed so it spans the 180-char cut of the message body would,
    // under the old (truncate-first) order, be SLICED below the redactor's 20-char
    // length floor — leaking the surviving prefix. Here we position a provider-key
    // token to straddle the cut and prove the emitted finding carries [REDACTED]
    // and NONE of the token's body (not even the sliced prefix) survives.
    const cwd = `/deep/${SCOPE}`;
    // Token assembled from fragments so THIS test source never contains a
    // contiguous provider-key-shaped literal (pack-hygiene gate).
    const TOKEN = "s" + "k-" + "A".repeat(40); // 43 chars, well over the {20,} floor
    // Word padding (short alnum runs + spaces) so no long alnum run forms — the
    // redactor's broad base64 arm would otherwise swallow the padding and mask the
    // leak. 32×"word " = 160 chars ⇒ the token begins at col 160 of the message
    // body and straddles the 180 cut; a truncate-first keeps only ~17 token chars
    // (< the 20-char floor) → a partial-token leak the fix must prevent.
    const pad = "word ".repeat(32); // 160 chars, ends with a space
    const msg = `CCL-FINDING [HIGH] ${pad}${TOKEN} tail`;
    writeRollout("rollout-straddle.jsonl", [sessionMeta(cwd), agentMessage(msg)]);

    const r = runWatch();
    expect(r.status).toBe(0);
    const findingsLog = join(repo, ".agent-loops", "findings.log");
    const log = readFileSync(findingsLog, "utf8");

    // The finding was extracted and scrubbed.
    expect(log).toContain("[REDACTED]");
    // NO run of the token body survived anywhere in the emitted log — not the
    // whole token, and not the sliced prefix (as few as 3 trailing chars) that a
    // truncate-first would have leaked. The pattern below matches the token shape
    // via `\s`-tolerant fragments so THIS source never spells the prefix out.
    expect(log).not.toMatch(/s\s*k-?A{3,}/);
    expect(log).not.toContain(TOKEN);
    // stdout mirrors the same scrubbed finding (the redactor runs before emit there too).
    expect(r.stdout).not.toMatch(/s\s*k-?A{3,}/);
  });

  it("extracts CCL markers from assistant response_item content too (not just agent_message)", () => {
    const cwd = `/x/${SCOPE}`;
    writeRollout("rollout-b.jsonl", [
      sessionMeta(cwd),
      assistantResponse("CCL-FINDING [HIGH] SQL built by string concat — injection risk"),
    ]);
    const r = runWatch();
    expect(r.status).toBe(0);
    const log = readFileSync(join(repo, ".agent-loops", "findings.log"), "utf8");
    expect(log).toMatch(/\[HIGH\] SQL built by string concat/);
  });

  it("IGNORES an out-of-scope session (cwd does not path-match the repo scope)", () => {
    // Home-shaped out-of-scope path assembled from fragments so THIS test source
    // never contains the literal home-path prefix the pack-hygiene gate forbids.
    const outOfScopeCwd = "/Us" + "ers/someone/a-different-project";
    writeRollout("rollout-oos.jsonl", [
      sessionMeta(outOfScopeCwd),
      agentMessage("CCL-FINDING [HIGH] this must NOT be extracted (out of scope)"),
    ]);
    const r = runWatch();
    expect(r.status).toBe(0);
    const findingsLog = join(repo, ".agent-loops", "findings.log");
    // Log may exist (run header) but must NOT contain the out-of-scope finding.
    const log = existsSync(findingsLog) ? readFileSync(findingsLog, "utf8") : "";
    expect(log).not.toMatch(/must NOT be extracted/);
    expect(r.stdout).not.toMatch(/must NOT be extracted/);
  });

  it("emits an EXPLICIT log line for an unrecognized rollout format (never silent)", () => {
    // First line is valid JSON but NOT a session_meta record → unknown format.
    writeRollout("rollout-weird.jsonl", [
      { type: "something_else", payload: {} },
      agentMessage("CCL-FINDING [HIGH] should be skipped, format unknown"),
    ]);
    const r = runWatch();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unknown rollout format/);
    const findingsLog = join(repo, ".agent-loops", "findings.log");
    const log = existsSync(findingsLog) ? readFileSync(findingsLog, "utf8") : "";
    expect(log).not.toMatch(/should be skipped/);
  });

  it("also emits an explicit log line when the first line is not JSON at all", () => {
    const p = join(sessionsDir, "rollout-garbage.jsonl");
    writeFileSync(p, "this is not json\n" + JSON.stringify(agentMessage("x")) + "\n", "utf8");
    const r = runWatch();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unknown rollout format/);
  });
});
