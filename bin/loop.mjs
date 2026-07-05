#!/usr/bin/env node
// loop — the HUMAN control plane for the ping-pong loop. Not a daemon: it runs
// ONE command and exits 0. There is no schedule, no re-arm, no model call — it
// only reads/writes local loop state under <stateDir> and prints.
//
// Commands:
//   status              show the kill-switch state + every thread's state
//   reset [<thread>]    clear one thread's state+trace (or ALL threads); the
//                       kill switch is left untouched
//   disable             engage the kill switch (write <stateDir>/DISABLED)
//   enable              release the kill switch (remove <stateDir>/DISABLED)
//   trace <thread>      print the tail of a thread's JSONL trace
//
// SAFETY: the kill switch (<stateDir>/DISABLED file OR CCL_DISABLED=1) is
// evaluated and REPORTED FIRST, before any command work — consistent with every
// other bin. The control-plane commands themselves are the human's tools, so
// they still run while disabled (you must be able to `enable`, `status`,
// `trace`, and `reset` a halted loop); each simply announces the disabled banner
// up front. `disable`/`enable` are the intended way to toggle it.
//
// This bin performs NO agent/provider/network work (I2): its only imports are
// node:* stdlib + the pure core state/ledger modules, and it spawns nothing.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, isAbsolute } from "node:path";

import { loadConfig } from "../core/loop-config.mjs";
import { isTerminal, isActive, isCorrupt } from "../core/pingpong-state.mjs";
import { DEFAULT_KEEP } from "../core/ledger.mjs";
// Runtime output filter — every packet/trace line printed to a human passes
// through it so a secret that ever leaked into a trace detail is not re-emitted.
import { redact } from "../core/redact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBPROCESS_TIMEOUT_MS = 60_000; // the one external call (git rev-parse)

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { cmd: null, thread: null, repo: null, all: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] || null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    else if (a === "--all") args.all = true;
    else if (a.startsWith("--")) {
      /* ignore unknown flags — fail-soft */
    } else positional.push(a);
  }
  args.cmd = positional[0] || "status";
  args.thread = positional[1] || null;
  return args;
}

// ── repo root ─────────────────────────────────────────────────────────────────
function resolveRepoRoot(repoFlag) {
  if (repoFlag) return isAbsolute(repoFlag) ? repoFlag : join(process.cwd(), repoFlag);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SUBPROCESS_TIMEOUT_MS,
    }).trim();
  } catch {
    return "";
  }
}

// ── state layout under <stateDir> ──────────────────────────────────────────────
function paths(repoRoot, cfg) {
  const stateDir = join(repoRoot, cfg.stateDir);
  return {
    stateDir,
    disabledFile: join(stateDir, "DISABLED"),
    pingpongDir: join(stateDir, "pingpong"),
  };
}

function threadStateFile(pingpongDir, thread) {
  return join(pingpongDir, `${sanitizeThread(thread)}.json`);
}
function threadTraceFile(pingpongDir, thread) {
  return join(pingpongDir, `${sanitizeThread(thread)}.trace.jsonl`);
}

// Thread names come from a human on the CLI — keep them to a safe, path-segment
// charset so no `..`/slash can escape the pingpong dir.
function sanitizeThread(thread) {
  return String(thread ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function listThreads(pingpongDir) {
  if (!existsSync(pingpongDir)) return [];
  try {
    return readdirSync(pingpongDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// ── kill switch ────────────────────────────────────────────────────────────────
function killSwitchState(cfg, disabledFile) {
  const byFile = existsSync(disabledFile);
  const byEnv = cfg.disabled === true; // CCL_DISABLED=1 resolved into config
  return { disabled: byFile || byEnv, byFile, byEnv };
}

function describeState(state) {
  if (isTerminal(state)) return `EXITED{${state.phase}} (round ${state.round ?? 0})`;
  if (isActive(state)) return `active: ${state.phase} (round ${state.round}/${state.maxRounds})`;
  if (isCorrupt(state)) return "CORRUPT → treat as blocked-needs-human on next advance";
  return "unknown";
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdStatus(p, cfg) {
  const ks = killSwitchState(cfg, p.disabledFile);
  const banner = ks.disabled
    ? `kill switch: ENGAGED (${ks.byFile ? "DISABLED file" : ""}${
        ks.byFile && ks.byEnv ? " + " : ""
      }${ks.byEnv ? "CCL_DISABLED=1" : ""}) — ticks will skip`
    : "kill switch: off";
  console.log(`loop: ${banner}`);
  console.log(`loop: stateDir = ${p.stateDir}`);

  const threads = listThreads(p.pingpongDir);
  if (threads.length === 0) {
    console.log("loop: no ping-pong threads yet");
    return;
  }
  console.log(`loop: ${threads.length} thread(s):`);
  for (const t of threads) {
    const st = readJson(threadStateFile(p.pingpongDir, t), null);
    console.log(`  ${t}: ${redact(describeState(st))}`);
  }
}

function cmdReset(p, args) {
  mkdirSync(p.pingpongDir, { recursive: true });
  const targets = args.all || !args.thread ? listThreads(p.pingpongDir) : [sanitizeThread(args.thread)];
  if (args.thread && !args.all) {
    // Explicit single thread: reset exactly it (even if no state file exists yet).
    resetOne(p, sanitizeThread(args.thread));
    console.log(`loop: reset thread '${sanitizeThread(args.thread)}' (state + trace cleared)`);
    return;
  }
  if (targets.length === 0) {
    console.log("loop: nothing to reset (no threads)");
    return;
  }
  for (const t of targets) resetOne(p, t);
  console.log(`loop: reset ${targets.length} thread(s) — kill switch left untouched`);
}

function resetOne(p, thread) {
  for (const f of [
    threadStateFile(p.pingpongDir, thread),
    threadTraceFile(p.pingpongDir, thread),
    // rotated generations
    ...Array.from({ length: DEFAULT_KEEP + 1 }, (_, i) => `${threadTraceFile(p.pingpongDir, thread)}.${i + 1}`),
  ]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* fail-soft */
    }
  }
}

function cmdDisable(p) {
  mkdirSync(p.stateDir, { recursive: true });
  writeFileSync(
    p.disabledFile,
    `disabled by control plane @ ${new Date().toISOString()}\n`,
    "utf8"
  );
  console.log(`loop: kill switch ENGAGED — wrote ${p.disabledFile}`);
  console.log("loop: every tick will now skip until you run `loop enable`.");
}

function cmdEnable(p) {
  if (existsSync(p.disabledFile)) {
    try {
      rmSync(p.disabledFile, { force: true });
    } catch {
      /* fail-soft */
    }
    console.log(`loop: kill switch released — removed ${p.disabledFile}`);
  } else {
    console.log("loop: kill switch already off (no DISABLED file).");
  }
  console.log("loop: NOTE — if CCL_DISABLED=1 is set in the environment, unset it too.");
}

function cmdTrace(p, args) {
  const thread = args.thread;
  if (!thread) {
    console.log("loop: usage — loop trace <thread>");
    const threads = listThreads(p.pingpongDir);
    if (threads.length) console.log(`loop: known threads: ${threads.join(", ")}`);
    return;
  }
  const file = threadTraceFile(p.pingpongDir, thread);
  if (!existsSync(file)) {
    console.log(`loop: no trace for thread '${sanitizeThread(thread)}' (${file} missing)`);
    return;
  }
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.log(`loop: could not read trace — ${e && e.message ? e.message : e}`);
    return;
  }
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-40); // bounded output; full file stays on disk
  console.log(`loop: trace for '${sanitizeThread(thread)}' (${lines.length} line(s), last ${tail.length}):`);
  // Redact each line on the way out — defense in depth if a finding detail ever
  // carried a secret shape into the trace.
  for (const l of tail) console.log(redact(l));
}

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(args.repo);
  if (!repoRoot) {
    console.log("loop: not inside a git repo (no --repo, git rev-parse failed) — nothing to do");
    return;
  }
  const cfg = loadConfig(process.env);
  const p = paths(repoRoot, cfg);

  // KILL SWITCH honored/announced FIRST (before any command work). The control
  // commands still run while disabled — they are the human's escape hatch — but
  // the disabled banner is printed up front so the state is never a surprise.
  const ks = killSwitchState(cfg, p.disabledFile);
  if (ks.disabled && args.cmd !== "status") {
    console.log("loop: [kill switch ENGAGED] — the loop is disabled; ticks are skipping.");
  }

  switch (args.cmd) {
    case "status":
      cmdStatus(p, cfg);
      break;
    case "reset":
      cmdReset(p, args);
      break;
    case "disable":
      cmdDisable(p);
      break;
    case "enable":
      cmdEnable(p);
      break;
    case "trace":
      cmdTrace(p, args);
      break;
    default:
      console.log(`loop: unknown command '${args.cmd}'`);
      console.log("loop: usage — loop status|reset [<thread>]|disable|enable|trace <thread>");
      break;
  }
}

try {
  main();
} catch (e) {
  console.warn(`loop: unexpected error — ${e && e.message ? e.message : e}`);
}
process.exit(0);
