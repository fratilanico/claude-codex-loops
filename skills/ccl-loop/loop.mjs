#!/usr/bin/env node
// loop — THIN state helper for the /ccl-loop skill (a GENERAL bounded
// orchestration driver for ANY task: build, refactor, migration, research).
//
// This helper does NOT spawn any model. It only manages a NAMED loop's state
// file under <stateDir>/loops/<name>.json and prints status + the next step the
// agent should take. The AGENT is the maker/checker; this helper is the bounded
// bookkeeping around it — round/brakes/sticky-exit come from the pure
// core/pingpong-state.mjs, the trace line from core/ledger.mjs, and the state
// dir / round governors from core/loop-config.mjs. It reuses those; it does NOT
// re-implement the loop engine.
//
// THE LOOP CONTRACT (self-paced, build-time, bounded — never a daemon):
//   trigger → maker (agent does work) → independent checker (the named checker)
//   → record state on disk → decide continue/exit → trace.
// Each `step` is ONE bounded iteration: the agent has already done a round of
// work and run the checker; this helper records the outcome (passed / no
// change / needs-human) and advances the bounded state machine. When a brake
// fires (maxRounds / no-progress / stale / kill switch) the loop EXITs to a
// sticky terminal and every later call is a no-op that reports the reason.
//
// Commands (args):
//   start <name>            create/replace a named loop at round 0 (idle → running)
//   step  <name> [outcome]  record one iteration + advance; outcome ∈
//                             progress (default) | no-change | converged |
//                             quiet | blocked
//   status <name>           print the loop's state; touch nothing
//   stop  <name>            force the loop to the disabled terminal (kill this loop)
//
// Flags: --repo <path> (else git rev-parse), --max-rounds <n>, --detail <text>.
//
// SAFETY: the pack kill switch (<stateDir>/DISABLED file or CCL_DISABLED=1) is
// honored FIRST on every command — a disabled loop reports and does no work.
// stdlib only (node:*); spawns nothing except the one git rev-parse for repo root.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBPROCESS_TIMEOUT_MS = 60_000;

// Resolve the REAL installed pack root. When this skill is copied by install.sh
// into <repo>/.claude/skills/ccl-loop/, the two-up path resolves to
// <repo>/.claude (NOT the pack), so a STATIC `../../core/*.mjs` import would fail
// with MODULE_NOT_FOUND at load time. We therefore resolve the pack root at
// runtime and DYNAMICALLY import core from there. Resolution order:
//   1. CCL_PACK_ROOT env (explicit override);
//   2. a .ccl-pack-root marker file install.sh writes next to the copied skill
//      (holds the absolute installed pack dir);
//   3. two levels up — the pack-resident layout (skills/ccl-loop/ → pack root).
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
const coreUrl = (name) => pathToFileURL(join(PACK_ROOT, "core", name)).href;

const { loadConfig } = await import(coreUrl("loop-config.mjs"));
const {
  initState,
  advance,
  applyBrakes,
  isTerminal,
  isActive,
  isCorrupt,
  terminal,
  SAFE_TERMINAL,
} = await import(coreUrl("pingpong-state.mjs"));
const { traceLine, rotationDecision } = await import(coreUrl("ledger.mjs"));
const { redact } = await import(coreUrl("redact.mjs"));

// ── argv ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { cmd: null, name: null, outcome: null, repo: null, maxRounds: null, detail: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] || null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    else if (a === "--max-rounds") args.maxRounds = Number(argv[++i]);
    else if (a.startsWith("--max-rounds=")) args.maxRounds = Number(a.slice("--max-rounds=".length));
    else if (a === "--detail") args.detail = argv[++i] || null;
    else if (a.startsWith("--detail=")) args.detail = a.slice("--detail=".length);
    else if (a.startsWith("--")) {
      /* ignore unknown flags — fail-soft */
    } else positional.push(a);
  }
  args.cmd = positional[0] || "status";
  args.name = positional[1] || null;
  args.outcome = positional[2] || null;
  return args;
}

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

// ── layout ──────────────────────────────────────────────────────────────────
function paths(repoRoot, cfg) {
  const stateDir = join(repoRoot, cfg.stateDir);
  return { stateDir, disabledFile: join(stateDir, "DISABLED"), loopsDir: join(stateDir, "loops") };
}

// Loop names come from a human on the CLI — keep them to a safe path-segment
// charset so no `..`/slash can escape the loops dir.
function sanitizeName(name) {
  return String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function stateFile(loopsDir, name) {
  return join(loopsDir, `${sanitizeName(name)}.json`);
}
function traceFile(loopsDir, name) {
  return join(loopsDir, `${sanitizeName(name)}.trace.jsonl`);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function killSwitchState(cfg, disabledFile) {
  const byFile = existsSync(disabledFile);
  const byEnv = cfg.disabled === true;
  return { disabled: byFile || byEnv, byFile, byEnv };
}

function describeState(state) {
  if (isTerminal(state)) return `EXITED{${state.phase}} (round ${state.round ?? 0})`;
  if (isActive(state)) return `active: ${state.phase} (round ${state.round}/${state.maxRounds})`;
  if (isCorrupt(state)) return "CORRUPT → treat as blocked-needs-human on next step";
  return "unknown";
}

// Append one JSONL trace line, rotating the file first if it would overflow.
function appendTrace(loopsDir, name, event) {
  const file = traceFile(loopsDir, name);
  const line = redact(traceLine(event)) + "\n";
  let curBytes = 0;
  try {
    curBytes = existsSync(file) ? statSync(file).size : 0;
  } catch {
    curBytes = 0;
  }
  const dec = rotationDecision(curBytes, Buffer.byteLength(line), {});
  if (dec.rotate) {
    // Shift generations: keep at most `keep` rotated files.
    for (let i = dec.keep; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (existsSync(from)) renameSync(from, to);
      } catch {
        /* fail-soft */
      }
    }
  }
  try {
    writeFileSync(file, line, { flag: "a" });
  } catch {
    /* fail-soft: a trace write must never break the loop */
  }
}

// Map a step outcome word to the pingpong-state event that advances the machine.
//   progress   → turn-complete (make forward progress; may close a round)
//   no-change  → no-progress   (the checker saw nothing new → brake toward human)
//   converged  → converged     (clean exit: the checker is satisfied)
//   quiet      → quiet          (nothing to do this iteration → clean exit)
//   blocked    → blocked        (agent escalates to a human)
const OUTCOME_TO_EVENT = Object.freeze({
  progress: "turn-complete",
  "no-change": "no-progress",
  converged: "converged",
  quiet: "quiet",
  blocked: "blocked",
});

// ── commands ────────────────────────────────────────────────────────────────
function cmdStart(p, args, cfg) {
  mkdirSync(p.loopsDir, { recursive: true });
  const maxRounds = Number.isInteger(args.maxRounds) ? args.maxRounds : cfg.pingpong.maxRounds;
  let s = initState(maxRounds);
  s = advance(s, "start"); // idle → running (claude-turn phase = "the maker is up")
  writeFileSync(stateFile(p.loopsDir, args.name), JSON.stringify(s), "utf8");
  appendTrace(p.loopsDir, args.name, {
    ts: new Date().toISOString(),
    thread: sanitizeName(args.name),
    event: "start",
    from: "idle",
    to: s.phase,
    round: s.round,
    maxRounds: s.maxRounds,
    detail: args.detail ?? null,
  });
  console.log(`loop '${sanitizeName(args.name)}': started — ${describeState(s)}`);
  console.log(nextStepHint(s));
}

function cmdStep(p, args) {
  const name = sanitizeName(args.name);
  const file = stateFile(p.loopsDir, name);
  const prev = readJson(file, null);

  // Sticky terminal / corrupt: advance() handles both (no-op on terminal,
  // corrupt → blocked-needs-human). Do NOT re-init here.
  if (prev == null) {
    console.log(`loop '${name}': no such loop — run \`loop start ${name}\` first.`);
    return;
  }

  const outcome = (args.outcome || "progress").toLowerCase();
  const event = OUTCOME_TO_EVENT[outcome] || "turn-complete";

  // Brakes (stale/no-progress) are checked by the state machine on the event we
  // raise; the freshness brake is applied here from the state-file mtime.
  let ageHours = null;
  try {
    ageHours = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
  } catch {
    ageHours = null;
  }
  const braked = applyBrakes(prev, {
    ageHours,
    history: [],
    staleAfterHours: undefined, // per-loop freshness is opt-in; step-driven loops are self-paced
  });

  const next = advance(braked, event);
  writeFileSync(file, JSON.stringify(next), "utf8");
  appendTrace(p.loopsDir, name, {
    ts: new Date().toISOString(),
    thread: name,
    event,
    from: prev.phase ?? null,
    to: next.phase ?? null,
    round: next.round,
    maxRounds: next.maxRounds,
    reason: next.reason ?? null,
    detail: args.detail ?? null,
  });
  console.log(`loop '${name}': ${outcome} → ${describeState(next)}`);
  console.log(nextStepHint(next));
}

function cmdStatus(p, args, cfg) {
  const name = sanitizeName(args.name);
  const s = readJson(stateFile(p.loopsDir, name), null);
  if (s == null) {
    console.log(`loop '${name}': no state yet (not started).`);
    return;
  }
  const ks = killSwitchState(cfg, p.disabledFile);
  if (ks.disabled) console.log(`loop '${name}': [kill switch ENGAGED] — steps will no-op.`);
  console.log(`loop '${name}': ${redact(describeState(s))}`);
  console.log(nextStepHint(s));
}

function cmdStop(p, args) {
  const name = sanitizeName(args.name);
  const file = stateFile(p.loopsDir, name);
  const prev = readJson(file, null);
  const base = prev && Number.isInteger(prev.round) ? prev : {};
  const t = terminal("disabled", base);
  mkdirSync(p.loopsDir, { recursive: true });
  writeFileSync(file, JSON.stringify(t), "utf8");
  appendTrace(p.loopsDir, name, {
    ts: new Date().toISOString(),
    thread: name,
    event: "disable",
    from: prev && prev.phase ? prev.phase : null,
    to: t.phase,
    round: t.round,
    maxRounds: t.maxRounds,
    reason: t.reason,
  });
  console.log(`loop '${name}': stopped — EXITED{disabled}. Every later step is a no-op.`);
}

// The agent-facing "what do I do next" line — the whole point of the helper.
function nextStepHint(s) {
  if (isTerminal(s)) {
    if (s.phase === "converged" || s.phase === "quiet")
      return `  → DONE (${s.phase}). Nothing more to do; the loop exited cleanly.`;
    return `  → STOP (${s.phase}). Brake fired — escalate to a human; do NOT re-arm this loop.`;
  }
  if (isActive(s))
    return `  → CONTINUE: do one iteration of work, run the checker, then \`loop step <name> <outcome>\`.`;
  return "  → CORRUPT state — the next step will route to blocked-needs-human.";
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(args.repo);
  if (!repoRoot) {
    console.log("loop: not inside a git repo (no --repo, git rev-parse failed) — nothing to do");
    return;
  }
  const cfg = loadConfig(process.env);
  const p = paths(repoRoot, cfg);

  // KILL SWITCH first, everywhere. A disabled loop does no work; status/stop
  // still run (they are the escape hatch) but announce the banner.
  const ks = killSwitchState(cfg, p.disabledFile);
  if (ks.disabled && (args.cmd === "start" || args.cmd === "step")) {
    console.log("loop: [kill switch ENGAGED] — the loop is disabled; no work done. Run `loop enable`.");
    return;
  }

  if ((args.cmd === "start" || args.cmd === "step" || args.cmd === "stop") && !args.name) {
    console.log(`loop: usage — loop ${args.cmd} <name>`);
    return;
  }

  switch (args.cmd) {
    case "start":
      cmdStart(p, args, cfg);
      break;
    case "step":
      cmdStep(p, args);
      break;
    case "status":
      if (!args.name) {
        console.log("loop: usage — loop status <name>");
        break;
      }
      cmdStatus(p, args, cfg);
      break;
    case "stop":
      cmdStop(p, args);
      break;
    default:
      console.log(`loop: unknown command '${args.cmd}'`);
      console.log("loop: usage — loop start <name> | step <name> [outcome] | status <name> | stop <name>");
      break;
  }
}

try {
  main();
} catch (e) {
  console.warn(`loop: unexpected error — ${e && e.message ? e.message : e}`);
}
process.exit(0);
