// CONFIG contract for the ping-pong loop (pack side, NEUTRAL defaults).
//
// Doctrine: variables change, LOGIC does not. Everything tunable lives in
// loadConfig so the SAME deterministic logic can be re-pointed at another
// repo / peer / cadence purely by changing config — never code. loadConfig
// must be a PURE, DETERMINISTIC function of its inputs (env-NAME-as-config-data).
//
// This locks: neutral defaults (no consumer literal), the DEFAULTS<file<env<CLI
// precedence, the inherited intervalSeconds>=60 floor + Object.freeze, and the
// NEW CCL_* keys + their clamps.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, loadConfig, validateConfig } from "../core/loop-config.mjs";

describe("DEFAULTS — neutral, ships without any consumer-specific value", () => {
  it("neutral-defaults snapshot (no repo, home, or fleet literal baked in)", () => {
    // A stable, inspectable snapshot of the shipped neutral config. If any
    // default changes, this snapshot must be updated deliberately.
    expect(DEFAULTS).toEqual({
      repoScope: "", // caller substitutes basename(git toplevel)
      peer: "codex",
      branchPrefix: "refs/remotes/origin/codex",
      fetchRefspec: "+refs/heads/codex/*:refs/remotes/origin/codex/*",
      claudeBranchPrefix: "claude/",
      stateDir: ".agent-loops",
      ledgerDir: "docs/reviews",
      intervalSeconds: 600,
      maxAckFindings: 20,
      watchWindowHours: 24,
      fetch: false,
      pingpong: { maxRounds: 4, staleAfterHours: 48, maxPacketFindings: 30 },
      triage: { maxRounds: 3 },
      disabled: false,
      tickOnStop: false,
    });
  });

  it("bakes in NO consumer literal — repoScope/stateDir/ledgerDir are neutral", () => {
    const blob = JSON.stringify(DEFAULTS);
    expect(DEFAULTS.repoScope).toBe(""); // never a hard-coded repo name
    expect(blob).not.toMatch(/quotic/i);
    // Home-path needle assembled from fragments so THIS source does not itself
    // contain the literal the pack-hygiene gate forbids.
    expect(blob).not.toContain("/Us" + "ers/");
    // stateDir is the neutral per-clone dir, not a consumer path.
    expect(DEFAULTS.stateDir).toBe(".agent-loops");
    expect(DEFAULTS.ledgerDir).toBe("docs/reviews");
  });

  it("is deeply frozen (config is read-only at runtime, nested governors too)", () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.pingpong)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.triage)).toBe(true);
  });
});

describe("loadConfig — pure, deterministic", () => {
  it("empty env returns the neutral defaults (deep-equal)", () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  it("is deterministic — same inputs give a deep-equal config every call", () => {
    const env = { CODEX_LOOP_INTERVAL: "900", CCL_MAX_ROUNDS: "6" };
    expect(loadConfig(env)).toEqual(loadConfig(env));
  });

  it("returns a deeply FROZEN config", () => {
    const cfg = loadConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.pingpong)).toBe(true);
    expect(Object.isFrozen(cfg.triage)).toBe(true);
  });

  it("env-NAME-as-config-data: the VALUE flows through verbatim", () => {
    const wild = "Any-Repo_Name.123";
    expect(loadConfig({ CODEX_LOOP_REPO_SCOPE: wild }).repoScope).toBe(wild);
    // CODEX_WATCH_REPO_SCOPE is the watch-side alias for the same field.
    expect(loadConfig({ CODEX_WATCH_REPO_SCOPE: wild }).repoScope).toBe(wild);
    expect(
      loadConfig({ CODEX_LOOP_BRANCH_PREFIX: "refs/remotes/origin/gemini" }).branchPrefix
    ).toBe("refs/remotes/origin/gemini");
  });
});

describe("precedence — DEFAULTS < file < env < CLI (last wins)", () => {
  it("file layer beats DEFAULTS", () => {
    const cfg = loadConfig({}, { file: { peer: "gemini", ledgerDir: "reviews/custom" } });
    expect(cfg.peer).toBe("gemini");
    expect(cfg.ledgerDir).toBe("reviews/custom");
  });

  it("env beats file", () => {
    const cfg = loadConfig(
      { CODEX_LOOP_PEER: "fromEnv" },
      { file: { peer: "fromFile" } }
    );
    expect(cfg.peer).toBe("fromEnv");
  });

  it("CLI overrides beat env and file", () => {
    const cfg = loadConfig(
      { CODEX_LOOP_PEER: "fromEnv" },
      { file: { peer: "fromFile" }, peer: "fromCli" }
    );
    expect(cfg.peer).toBe("fromCli");
  });

  it("full ladder resolves in order for one key", () => {
    // DEFAULT "codex" < file "f" < env "e" < CLI "c"
    expect(loadConfig({}).peer).toBe("codex");
    expect(loadConfig({}, { file: { peer: "f" } }).peer).toBe("f");
    expect(loadConfig({ CODEX_LOOP_PEER: "e" }, { file: { peer: "f" } }).peer).toBe("e");
    expect(
      loadConfig({ CODEX_LOOP_PEER: "e" }, { file: { peer: "f" }, peer: "c" }).peer
    ).toBe("c");
  });

  it("nested pingpong/triage overrides merge field-by-field (siblings survive)", () => {
    const cfg = loadConfig({}, { file: { pingpong: { maxRounds: 7 } } });
    expect(cfg.pingpong.maxRounds).toBe(7);
    expect(cfg.pingpong.staleAfterHours).toBe(DEFAULTS.pingpong.staleAfterHours); // unchanged
    expect(cfg.pingpong.maxPacketFindings).toBe(DEFAULTS.pingpong.maxPacketFindings);
  });
});

describe("cadence floor — inherited intervalSeconds >= 60", () => {
  it("coerces numeric interval envs; bad numerics fall back to default", () => {
    expect(loadConfig({ CODEX_LOOP_INTERVAL: "1200" }).intervalSeconds).toBe(1200);
    expect(loadConfig({ CODEX_LOOP_INTERVAL: "not-a-number" }).intervalSeconds).toBe(
      DEFAULTS.intervalSeconds
    );
  });

  it("validateConfig rejects a sub-60 interval (the inherited sanity floor is KEPT)", () => {
    expect(() => validateConfig({ ...DEFAULTS, intervalSeconds: 5 })).toThrow(/intervalSeconds/);
    expect(() => validateConfig({ ...DEFAULTS, intervalSeconds: 59 })).toThrow(/intervalSeconds/);
    expect(() => validateConfig({ ...DEFAULTS, intervalSeconds: 60 })).not.toThrow();
  });

  it("a file/CLI interval below the floor is caught by validateConfig via loadConfig", () => {
    // loadConfig runs validateConfig; a floor violation throws with the field name.
    expect(() => loadConfig({}, { file: { intervalSeconds: 30 } })).toThrow(/intervalSeconds/);
  });
});

describe("new CCL_* keys — validated and clamped", () => {
  it("CCL_STATE_DIR / CCL_LEDGER_DIR flow through", () => {
    const cfg = loadConfig({ CCL_STATE_DIR: ".loops", CCL_LEDGER_DIR: "docs/pp" });
    expect(cfg.stateDir).toBe(".loops");
    expect(cfg.ledgerDir).toBe("docs/pp");
  });

  it("CCL_MAX_ROUNDS clamps to 1..20", () => {
    expect(loadConfig({ CCL_MAX_ROUNDS: "6" }).pingpong.maxRounds).toBe(6);
    expect(loadConfig({ CCL_MAX_ROUNDS: "0" }).pingpong.maxRounds).toBe(1); // clamp low
    expect(loadConfig({ CCL_MAX_ROUNDS: "999" }).pingpong.maxRounds).toBe(20); // clamp high
    expect(loadConfig({ CCL_MAX_ROUNDS: "-3" }).pingpong.maxRounds).toBe(1);
    // non-integer → falls back to default
    expect(loadConfig({ CCL_MAX_ROUNDS: "abc" }).pingpong.maxRounds).toBe(
      DEFAULTS.pingpong.maxRounds
    );
  });

  it("a file/CLI maxRounds out of range is re-clamped after the CLI layer", () => {
    expect(loadConfig({}, { file: { pingpong: { maxRounds: 40 } } }).pingpong.maxRounds).toBe(20);
    expect(loadConfig({}, { pingpong: { maxRounds: 0 } }).pingpong.maxRounds).toBe(1);
  });

  it("CCL_TRIAGE_MAX_ROUNDS clamps to 1..20 (default 3)", () => {
    expect(loadConfig({}).triage.maxRounds).toBe(3);
    expect(loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "5" }).triage.maxRounds).toBe(5);
    expect(loadConfig({ CCL_TRIAGE_MAX_ROUNDS: "50" }).triage.maxRounds).toBe(20);
  });

  it("CCL_STALE_HOURS coerces to a positive int", () => {
    expect(loadConfig({ CCL_STALE_HOURS: "72" }).pingpong.staleAfterHours).toBe(72);
    expect(loadConfig({ CCL_STALE_HOURS: "0" }).pingpong.staleAfterHours).toBe(
      DEFAULTS.pingpong.staleAfterHours
    );
  });

  it("CODEX_LOOP_WINDOW_HOURS is consumed into watchWindowHours (the watcher's scan window)", () => {
    expect(loadConfig({ CODEX_LOOP_WINDOW_HOURS: "6" }).watchWindowHours).toBe(6);
    expect(loadConfig({ CODEX_LOOP_WINDOW_HOURS: "bad" }).watchWindowHours).toBe(
      DEFAULTS.watchWindowHours
    );
  });

  it("CCL_DISABLED / CCL_TICK_ON_STOP are strict '1' opt-in", () => {
    expect(loadConfig({}).disabled).toBe(false);
    expect(loadConfig({ CCL_DISABLED: "1" }).disabled).toBe(true);
    expect(loadConfig({ CCL_DISABLED: "0" }).disabled).toBe(false);
    expect(loadConfig({ CCL_DISABLED: "true" }).disabled).toBe(false); // strict: only "1"
    expect(loadConfig({}).tickOnStop).toBe(false);
    expect(loadConfig({ CCL_TICK_ON_STOP: "1" }).tickOnStop).toBe(true);
  });
});

// The loop-tick ferry spawns watch-codex and forwards the scan window via env.
// That forwarded env var NAME must be one the child's loadConfig actually READS,
// or the window silently reverts to the default in the child (finding #13: the
// old CODEX_WATCH_WINDOW_HOURS forward was dead env).
describe("loop-tick → watch-codex window-hours forward is a name loadConfig reads", () => {
  const TICK_SRC = readFileSync(join(__dirname, "..", "bin", "loop-tick.mjs"), "utf8");

  it("forwards the watch window under a *_WINDOW_HOURS env key loadConfig consumes", () => {
    // Lift every *_WINDOW_HOURS env key the ferry passes to the watch subprocess
    // (an object-literal `NAME: String(cfg.watchWindowHours)`).
    const forwarded = [...TICK_SRC.matchAll(/\b([A-Z0-9_]*_WINDOW_HOURS)\s*:\s*String\(/g)].map(
      (m) => m[1]
    );
    expect(forwarded.length).toBeGreaterThan(0);
    // Each forwarded key must actually move the config when passed as env — i.e.
    // loadConfig reads it. A dead-env key (like the old CODEX_WATCH_WINDOW_HOURS)
    // would leave watchWindowHours at the default and fail here.
    for (const key of forwarded) {
      const cfg = loadConfig({ [key]: "7" });
      expect(cfg.watchWindowHours, `loadConfig ignored forwarded env key ${key}`).toBe(7);
    }
    // Belt-and-braces: the specific dead name must not be the forward anymore.
    expect(TICK_SRC).not.toMatch(/CODEX_WATCH_WINDOW_HOURS\s*:\s*String\(/);
  });
});

describe("validateConfig — deterministic rejection of bad config", () => {
  it("accepts the neutral defaults", () => {
    expect(() => validateConfig(DEFAULTS)).not.toThrow();
  });
  it("accepts an empty repoScope (git-toplevel sentinel) but rejects a non-string", () => {
    expect(() => validateConfig({ ...DEFAULTS, repoScope: "" })).not.toThrow();
    // A deliberately non-string repoScope must be rejected (cast to bypass the
    // static type so the runtime guard is what we exercise).
    expect(() =>
      validateConfig({ ...DEFAULTS, repoScope: 123 } as unknown as typeof DEFAULTS)
    ).toThrow(/repoScope/);
  });
  it("rejects empty peer / branchPrefix / stateDir / ledgerDir", () => {
    expect(() => validateConfig({ ...DEFAULTS, peer: "" })).toThrow(/peer/);
    expect(() => validateConfig({ ...DEFAULTS, branchPrefix: "" })).toThrow(/branchPrefix/);
    expect(() => validateConfig({ ...DEFAULTS, stateDir: "" })).toThrow(/stateDir/);
    expect(() => validateConfig({ ...DEFAULTS, ledgerDir: "" })).toThrow(/ledgerDir/);
  });
  it("rejects out-of-range round governors", () => {
    expect(() =>
      validateConfig({ ...DEFAULTS, pingpong: { ...DEFAULTS.pingpong, maxRounds: 0 } })
    ).toThrow(/pingpong\.maxRounds/);
    expect(() =>
      validateConfig({ ...DEFAULTS, pingpong: { ...DEFAULTS.pingpong, maxRounds: 21 } })
    ).toThrow(/pingpong\.maxRounds/);
    expect(() =>
      validateConfig({ ...DEFAULTS, triage: { maxRounds: 0 } })
    ).toThrow(/triage\.maxRounds/);
  });
  it("rejects non-positive limits", () => {
    expect(() => validateConfig({ ...DEFAULTS, maxAckFindings: 0 })).toThrow(/maxAckFindings/);
    expect(() => validateConfig({ ...DEFAULTS, watchWindowHours: 0 })).toThrow(/watchWindowHours/);
  });
});
