// SUBPROCESS TIMEOUT — every external git/gh call in bin/loop-tick.mjs carries
// execFileSync timeout: 60_000, so a hung subprocess (a stuck `git fetch`, a
// wedged network mount) can NEVER defeat the "exits 0 always" contract.
//
// We prove it on the EARLIEST external call: with no --repo, the tick's first act
// is `git rev-parse --show-toplevel` to find the repo root. A fake `git` on PATH
// that sleeps 120s makes that call hang; the 60s timeout must fire, the call must
// fail-soft to empty, and the tick must exit 0 well within timeout + grace
// (nowhere near the fake's 120s sleep).
//
// The test allows up to (timeout 60s + generous grace) but asserts it is FAR
// below the 120s the fake would take if the timeout did NOT fire — so a
// regression that drops the timeout turns this test RED (it would run ~120s+).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TICK = join(__dirname, "..", "bin", "loop-tick.mjs");

let dir: string;
let fakeBinDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccl-timeout-"));
  fakeBinDir = join(dir, "fakebin");
  mkdirSync(fakeBinDir, { recursive: true });
  // A `git` that hangs for 120s on ANY invocation. If the tick's 60s timeout
  // fails to fire, the process would block on this for the full 120s.
  const fakeGit = join(fakeBinDir, "git");
  writeFileSync(fakeGit, "#!/bin/sh\nsleep 120\n", "utf8");
  chmodSync(fakeGit, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hung git subprocess cannot hang the tick", () => {
  it(
    "exits 0 within timeout + grace when `git` sleeps 120s (no --repo → rev-parse hangs, timeout fires)",
    () => {
      const start = Date.now();
      const r = spawnSync(process.execPath, [TICK], {
        encoding: "utf8",
        cwd: dir,
        // Put the fake git FIRST on PATH so the tick resolves it.
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
        // A hard outer ceiling far below 2×120s but above the 60s internal
        // timeout + grace — if the internal timeout regresses, spawnSync kills
        // the child here and status/signal reflects the forced kill (RED).
        timeout: 90_000,
      });
      const elapsed = Date.now() - start;

      // The tick fail-softs to exit 0 (the rev-parse timed out → "not a git repo").
      expect(r.signal).toBe(null); // NOT killed by the outer 90s ceiling
      expect(r.status).toBe(0);
      // Far below the fake's 120s sleep — the internal 60s timeout fired.
      expect(elapsed).toBeLessThan(90_000);
    },
    120_000 // vitest per-test timeout: room for the 60s internal timeout + grace
  );
});
