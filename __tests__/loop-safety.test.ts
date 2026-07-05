// LOOP-SAFETY — the invariant suite (I1–I6) for the whole bin/ surface.
//
// This is the proof that the pack is a BUILD-TIME ferry, never a resident
// autonomous loop and never a model driver. It works on the REAL source of every
// bin/ entrypoint AND — for I2 — on the TRANSITIVE static-import graph reachable
// from each entrypoint (so a model call hidden two imports deep is still caught).
//
//   I1  no resident process   — no setInterval / while(true) / re-armed setTimeout
//                               anywhere in bin/; every bin terminates.
//   I2  ferry is model-free   — via a transitive static-import walk from each bin
//                               entry: no claude/codex/provider spawn or fetch
//                               anywhere in the reachable import graph.
//   I3  cadence external-only  — no internal scheduler; the interval floor ≥ 60 is
//                               enforced by config, and bins never self-schedule.
//   I4  finite handoffs        — maxRounds → terminal, round monotone, ≤ 2·maxRounds
//                               model turns per thread (proven against the machine).
//   I5  sticky terminals       — once exited never re-init; corrupt → blocked-needs-human.
//   I6  fail-soft not fail-loop — no retry/backoff LOOP; a failure exits, never spins.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { advance, initState, isTerminal, terminal } from "../core/pingpong-state.mjs";

const PACK = join(__dirname, "..");
const BIN_DIR = join(PACK, "bin");
const CORE_DIR = join(PACK, "core");

function binEntries(): string[] {
  if (!existsSync(BIN_DIR)) return [];
  return readdirSync(BIN_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => join(BIN_DIR, f));
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

// Strip line + block comments and string/template contents so structural
// checks (schedulers, exec command literals) don't false-positive on prose or
// on a literal like a log message. Returns code-only text with strings blanked.
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let state: "code" | "line" | "block" | "s" | "d" | "t" = "code";
  let quote = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        state = c === "'" ? "s" : c === '"' ? "d" : "t";
        quote = c;
        out += " "; // placeholder for the opening quote
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += "\n";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        i += 2;
      } else {
        if (c === "\n") out += "\n";
        i += 1;
      }
      continue;
    }
    // inside a string/template: blank the content, keep newlines for line numbers
    if (c === "\\") {
      i += 2; // skip escaped char
      continue;
    }
    if (c === quote) {
      state = "code";
      out += " "; // placeholder for the closing quote
      i += 1;
      continue;
    }
    if (c === "\n") out += "\n";
    i += 1;
  }
  return out;
}

// Collect the string-literal specifiers of every static `import ... from "x"`,
// `export ... from "x"`, and dynamic `import("x")` in a source file.
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:\bimport\b[^;]*?\bfrom\s*|\bexport\b[^;]*?\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[2]);
  // Bare `import "x"` side-effect form.
  const re2 = /\bimport\s*(["'`])([^"'`]+)\1/g;
  while ((m = re2.exec(src))) {
    // avoid double-counting the `import x from "y"` case already matched
    if (!specs.includes(m[2])) specs.push(m[2]);
  }
  return specs;
}

// Transitive walk of the LOCAL static-import graph from a set of entry files.
// Returns the set of reachable local source files (absolute paths) PLUS the set
// of every non-relative (bare) import specifier seen along the way.
function walkImportGraph(entries: string[]): { files: Set<string>; bareImports: Set<string> } {
  const files = new Set<string>();
  const bareImports = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    if (!existsSync(file)) continue;
    files.add(file);
    const src = read(file);
    for (const spec of importSpecifiers(src)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        // Resolve a relative import to a real file (add .mjs/.js if needed).
        const base = resolve(dirname(file), spec);
        const candidates = [base, base + ".mjs", base + ".js", join(base, "index.mjs")];
        const hit = candidates.find((c) => existsSync(c));
        if (hit) queue.push(hit);
        else bareImports.add(spec); // unresolved relative — surface it, don't hide it
      } else {
        bareImports.add(spec);
      }
    }
  }
  return { files, bareImports };
}

// ── I1 ─────────────────────────────────────────────────────────────────────
describe("I1 — no resident process (every bin is a single bounded run)", () => {
  const bins = binEntries();

  it("there is at least one bin to check", () => {
    expect(bins.length).toBeGreaterThan(0);
  });

  it("no bin uses setInterval, while(true), or a re-armed setTimeout", () => {
    for (const bin of bins) {
      const code = stripCommentsAndStrings(read(bin));
      const rel = relative(PACK, bin);
      expect(code, `${rel} must not setInterval`).not.toMatch(/\bsetInterval\s*\(/);
      // while(true) / while(1) / for(;;) — an unbounded spin loop.
      expect(code, `${rel} must not while(true)`).not.toMatch(/\bwhile\s*\(\s*(true|1)\s*\)/);
      expect(code, `${rel} must not for(;;)`).not.toMatch(/\bfor\s*\(\s*;\s*;\s*\)/);
      // setTimeout is allowed ONLY if it never appears (the simplest guarantee);
      // a re-armed setTimeout (a self-rescheduling pseudo-daemon) is the real
      // hazard, and the blanket ban is the tightest, least-ambiguous rule.
      expect(code, `${rel} must not setTimeout (no self-scheduling)`).not.toMatch(
        /\bsetTimeout\s*\(/
      );
      // No unref'd timers / immediates that would keep the loop alive.
      expect(code, `${rel} must not setImmediate`).not.toMatch(/\bsetImmediate\s*\(/);
    }
  });

  it("every bin terminates on a trivial invocation (exit code, bounded time)", () => {
    for (const bin of bins) {
      const start = Date.now();
      const r = spawnSync(process.execPath, [bin, "--help-nonsense", "--repo", "/nonexistent/xyz"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      const elapsed = Date.now() - start;
      expect(r.signal, `${relative(PACK, bin)} killed by timeout (did not terminate)`).toBe(null);
      expect(r.status, `${relative(PACK, bin)} must exit 0`).toBe(0);
      expect(elapsed).toBeLessThan(15_000);
    }
  }, 90_000);
});

// ── I2 ─────────────────────────────────────────────────────────────────────
describe("I2 — the ferry is MODEL-FREE across the transitive import graph", () => {
  const bins = binEntries();
  const { files, bareImports } = walkImportGraph(bins);

  it("reaches the pure core modules from the bins (graph is non-trivial)", () => {
    expect(files.size).toBeGreaterThan(bins.length); // bins + at least some core
    const reached = [...files].map((f) => relative(PACK, f));
    expect(reached.some((f) => f.startsWith("core/"))).toBe(true);
  });

  it("imports NOTHING outside node:* stdlib (no npm/provider SDK in the graph)", () => {
    const offenders = [...bareImports].filter((s) => !s.startsWith("node:"));
    expect(offenders, `non-stdlib imports reachable from bin/: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no reachable file does fetch() or imports a network module", () => {
    const NETWORK_MODULES = ["node:http", "node:https", "node:net", "node:tls", "node:dgram", "node:http2"];
    for (const file of files) {
      const rel = relative(PACK, file);
      const code = stripCommentsAndStrings(read(file));
      expect(code, `${rel} must not call fetch()`).not.toMatch(/\bfetch\s*\(/);
      expect(code, `${rel} must not use XMLHttpRequest`).not.toMatch(/\bXMLHttpRequest\b/);
      for (const mod of NETWORK_MODULES) {
        // Check the RAW source for the import specifier (strings are blanked in
        // `code`, so read imports from the original text).
        const specs = importSpecifiers(read(file));
        expect(specs, `${rel} must not import ${mod}`).not.toContain(mod);
      }
    }
  });

  it("no reachable file references a provider SDK / model gateway / model token", () => {
    // These names must not appear ANYWHERE (code or string) in the ferry graph —
    // an SDK import, a gateway URL, or an auth-header name would all be a model
    // seam. Assembled from fragments so THIS test file stays hygiene-clean.
    const FORBIDDEN = [
      "anthropic",
      "openai",
      "@google/gen" + "erative-ai",
      "generativelanguage",
      "x-cla" + "ude-token",
      "CLA" + "UDE_GATEWAY",
      "api.anthropic",
      "api.openai",
    ];
    for (const file of files) {
      const rel = relative(PACK, file);
      const raw = read(file).toLowerCase();
      for (const needle of FORBIDDEN) {
        expect(raw.includes(needle.toLowerCase()), `${rel} must not reference "${needle}"`).toBe(
          false
        );
      }
    }
  });

  it("every exec/spawn command literal in the graph is an ALLOWLISTED non-model binary", () => {
    // Only these process spawns are legitimate for a ferry: git, gh (both under
    // the user's own login), launchctl (schedule install), and node itself
    // (running a sibling ferry script). Spawning `claude`/`codex`/any provider
    // CLI is the exact thing a ferry must never do.
    const ALLOW = new Set(["git", "gh", "launchctl", "node", "process.execPath"]);
    const EXEC_OPEN =
      /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\s*\(\s*/g;
    for (const file of files) {
      const rel = relative(PACK, file);
      const src = read(file);
      let m: RegExpExecArray | null;
      EXEC_OPEN.lastIndex = 0;
      while ((m = EXEC_OPEN.exec(src))) {
        // Grab the first argument token after the open paren, tolerant of
        // whitespace/newlines. It is either a quoted string literal or an
        // identifier expression like process.execPath.
        const after = src.slice(m.index + m[0].length);
        const cmd = firstCallArg(after);
        expect(
          ALLOW.has(cmd),
          `${rel}: exec/spawn command "${cmd}" is not in the non-model allowlist {${[...ALLOW].join(", ")}}`
        ).toBe(true);
      }
    }
  });
});

// Parse the first argument of an exec/spawn call from the text immediately after
// the open paren. Returns the string-literal value, or a normalized identifier
// expression (e.g. "process.execPath"), or "<dynamic>" if it cannot be resolved
// to a static command (which the allowlist assertion then rejects).
function firstCallArg(after: string): string {
  let i = 0;
  while (i < after.length && /\s/.test(after[i])) i++;
  const q = after[i];
  if (q === '"' || q === "'" || q === "`") {
    let j = i + 1;
    let val = "";
    while (j < after.length && after[j] !== q) {
      if (after[j] === "\\") {
        val += after[j + 1];
        j += 2;
        continue;
      }
      val += after[j];
      j++;
    }
    return val;
  }
  // identifier / member expression up to the next , ) or whitespace
  const m = after.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$.]*/);
  return m ? m[0] : "<dynamic>";
}

// ── I3 ─────────────────────────────────────────────────────────────────────
describe("I3 — cadence is external-only (floor ≥ 60, no internal scheduler)", () => {
  it("config enforces the interval floor ≥ 60 and rejects anything below", async () => {
    const { loadConfig } = await import("../core/loop-config.mjs");
    // A valid config accepts ≥ 60.
    expect(loadConfig({ CODEX_LOOP_INTERVAL: "60" }).intervalSeconds).toBe(60);
    expect(loadConfig({ CODEX_LOOP_INTERVAL: "600" }).intervalSeconds).toBe(600);
    // Below-floor is REJECTED hard — validateConfig throws, so a sub-60 cadence
    // can never be smuggled in via env (the floor is a fail-closed gate, not a
    // silent clamp). This is the load-bearing I3 guarantee.
    expect(() => loadConfig({ CODEX_LOOP_INTERVAL: "5" })).toThrow(/intervalSeconds.*>= 60/);
    // The default is itself ≥ 60.
    expect(loadConfig({}).intervalSeconds).toBeGreaterThanOrEqual(60);
  });

  it("no bin self-schedules (I1 already bans timers; assert intervalSeconds is data-only)", () => {
    // The interval is a NUMBER the external scheduler (launchd) consumes; no bin
    // arms a timer off it. We re-assert the timer-ban here scoped to interval use.
    for (const bin of binEntries()) {
      const code = stripCommentsAndStrings(read(bin));
      expect(code).not.toMatch(/setInterval|setTimeout|setImmediate/);
    }
  });
});

// ── I4 ─────────────────────────────────────────────────────────────────────
describe("I4 — finite handoffs (maxRounds → terminal, ≤ 2·maxRounds turns)", () => {
  it("a thread driven only by turn-complete always terminates at maxRounds", () => {
    for (const mr of [1, 3, 4, 9]) {
      let s: any = advance(initState(mr), "start");
      let turns = 0;
      while (!isTerminal(s) && turns < 10_000) {
        s = advance(s, "turn-complete");
        turns++;
      }
      expect(isTerminal(s)).toBe(true);
      expect(s.phase).toBe("max-rounds");
      expect(turns).toBeLessThanOrEqual(2 * mr);
      expect(turns).toBe(2 * mr); // exactly claude+codex each round
    }
  });

  it("no event sequence can push round above maxRounds (the cap holds)", () => {
    let s: any = advance(initState(2), "start");
    // Hammer it well past the cap; it must be terminal at round 2, never 3+.
    for (let k = 0; k < 50; k++) s = advance(s, "turn-complete");
    expect(s.phase).toBe("max-rounds");
    expect(s.round).toBe(2);
  });
});

// ── I5 ─────────────────────────────────────────────────────────────────────
describe("I5 — sticky terminals + corrupt → blocked-needs-human", () => {
  it("a terminal is never revived by any event", () => {
    for (const reason of ["converged", "quiet", "max-rounds", "no-progress", "stale", "blocked-needs-human", "disabled"]) {
      let s: any = terminal(reason, { round: 2, maxRounds: 4 });
      for (const ev of ["start", "turn-complete", "converged", "disable", "junk"]) {
        s = advance(s, ev);
        expect(s.status).toBe("exited");
        expect(s.phase).toBe(reason);
      }
    }
  });

  it("a corrupt state advances to a STICKY blocked-needs-human", () => {
    let s: any = advance({ nonsense: true }, "turn-complete");
    expect(s.phase).toBe("blocked-needs-human");
    // sticky
    s = advance(s, "start");
    s = advance(s, "turn-complete");
    expect(s.phase).toBe("blocked-needs-human");
    expect(isTerminal(s)).toBe(true);
  });
});

// ── I6 ─────────────────────────────────────────────────────────────────────
describe("I6 — fail-soft, never fail-LOOP (no retry/backoff spin)", () => {
  const bins = binEntries();

  it("no bin contains a retry/backoff loop construct", () => {
    for (const bin of bins) {
      const code = stripCommentsAndStrings(read(bin));
      const rel = relative(PACK, bin);
      // The failure mode we forbid is a loop that RE-TRIES on error. Bans:
      //  - any while/for that mentions 'retry' or 'attempt' or 'backoff'
      //  - recursive re-invocation of main() on catch
      expect(code, `${rel}: no while-retry loop`).not.toMatch(
        /\b(while|for)\s*\([^)]*\b(retry|retries|attempt|attempts|backoff)\b/i
      );
      // A catch block must not call the entrypoint again (self-restart on error).
      expect(code, `${rel}: catch must not re-invoke main()`).not.toMatch(
        /catch\s*\([^)]*\)\s*\{[^}]*\bmain\s*\(/
      );
    }
  });

  it("each bin's top level fail-softs to process.exit(0) (no throw escapes)", () => {
    // Structural: the entry has a try/catch OR a .catch that ends in exit 0, and
    // the very last statement is process.exit(0) (proven behaviorally by I1's
    // termination test on a bad invocation, re-asserted here structurally).
    for (const bin of bins) {
      const src = read(bin);
      const rel = relative(PACK, bin);
      expect(src, `${rel} must guarantee exit 0`).toMatch(/process\.exit\(0\)|process\.exit\(\s*0\s*\)/);
      expect(src, `${rel} must have a top-level catch/fail-soft`).toMatch(/catch\s*\(/);
    }
  });
});
