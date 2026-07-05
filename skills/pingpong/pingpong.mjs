#!/usr/bin/env node
// pingpong — THIN wrapper for the /pingpong skill.
//
// This adds NO loop logic. It shells to the pack's bounded bins:
//   round  → node bin/loop-tick.mjs                (one bounded tick: kill-switch → lock → work)
//   pull   → node bin/loop-tick.mjs --probe        (print the peer digest; touch nothing)
//   push   → node bin/loop-tick.mjs                (the tick writes the redacted ack packet)
//   status → node bin/loop.mjs status (print thread state, touch nothing)
//
// TURN BUDGET: exactly ONE round per session. `round` runs a single tick and
// stops. Raising the budget requires an explicit `--turns <n>` (each turn is
// still one bounded bin invocation; the state machine's round cap and brakes
// still apply, so --turns only lets you drive several already-bounded ticks in
// one session — it never removes a brake).
//
// stdlib only (node:*). Exits 0 on every path a bin exits 0 on; propagates a
// bin's non-zero status only when a bin itself fails hard.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the REAL installed pack root. When this skill is copied by install.sh
// into <repo>/.claude/skills/pingpong/, the two-up path resolves to <repo>/.claude
// (NOT the pack) and BIN() would break. So resolve, in order:
//   1. CCL_PACK_ROOT env (explicit override);
//   2. a .ccl-pack-root marker file install.sh writes next to the copied skill
//      (holds the absolute installed pack dir);
//   3. two levels up — the pack-resident layout (skills/pingpong/ → pack root).
function resolvePackRoot() {
  const env = process.env.CCL_PACK_ROOT;
  if (env && env.trim()) return env.trim();
  try {
    const marker = join(__dirname, ".ccl-pack-root");
    if (existsSync(marker)) {
      const p = readFileSync(marker, "utf8").trim();
      if (p) return p;
    }
  } catch {
    /* fall through to the pack-resident default */
  }
  return join(__dirname, "..", "..");
}
const PACK_ROOT = resolvePackRoot();
const BIN = (name) => join(PACK_ROOT, "bin", name);

const TURN_BUDGET_THIS_SESSION = 1;

function parseArgs(argv) {
  const args = { cmd: "round", thread: null, turns: TURN_BUDGET_THIS_SESSION, passthrough: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--thread") args.thread = argv[++i] || null;
    else if (a.startsWith("--thread=")) args.thread = a.slice("--thread=".length);
    else if (a === "--turns") args.turns = Number(argv[++i]) || TURN_BUDGET_THIS_SESSION;
    else if (a.startsWith("--turns=")) args.turns = Number(a.slice("--turns=".length)) || TURN_BUDGET_THIS_SESSION;
    else if (a === "--repo") { args.passthrough.push("--repo", argv[++i]); }
    else if (a.startsWith("--")) args.passthrough.push(a);
    else positional.push(a);
  }
  args.cmd = positional[0] || "round";
  // A turn count is only honored when raised explicitly; otherwise it is the
  // one-round session budget. Clamp to a sane bound so a stray flag can't spin.
  if (!Number.isFinite(args.turns) || args.turns < 1) args.turns = TURN_BUDGET_THIS_SESSION;
  if (args.turns > 20) args.turns = 20;
  return args;
}

// Run one bin, inheriting stdio. Returns its exit status (default 0 on signal).
function runBin(script, extra) {
  const r = spawnSync(process.execPath, [BIN(script), ...extra], { stdio: "inherit" });
  return typeof r.status === "number" ? r.status : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Forwarded verbatim; bins that do not scope by thread ignore it harmlessly.
  const threadArgs = args.thread ? ["--thread", args.thread] : [];

  switch (args.cmd) {
    case "status":
      return runBin("loop.mjs", ["status", ...args.passthrough]);

    case "pull":
      // Extract-only: the tick's probe mode prints the peer digest and writes
      // NOTHING to disk (no handoff, no ack).
      return runBin("loop-tick.mjs", ["--probe", ...threadArgs, ...args.passthrough]);

    case "push":
      // The tick writes the redacted sync-back ack packet.
      return runBin("loop-tick.mjs", [...threadArgs, ...args.passthrough]);

    case "round": {
      // Advance one round (default one turn; --turns raises the session budget).
      let last = 0;
      for (let turn = 0; turn < args.turns; turn++) {
        last = runBin("loop-tick.mjs", [...threadArgs, ...args.passthrough]);
        // A hard bin failure stops the session; a normal bounded exit continues.
        if (last !== 0) break;
      }
      // Report the resulting thread state (never touches disk).
      runBin("loop.mjs", ["status", ...args.passthrough]);
      return last;
    }

    default:
      console.log(`pingpong: unknown command '${args.cmd}' (round|status|pull|push)`);
      return 0;
  }
}

process.exit(main());
