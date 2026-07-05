#!/usr/bin/env node
// research-loop — THIN state + findings-ledger helper for the /research-loop
// skill (a RESEARCH flavor of the general bounded loop).
//
// This helper does NOT spawn any model or hit any provider API. The AGENT runs
// each research pass with its OWN session tools (WebSearch / fetch / read),
// VERIFIES each claim against a real source, and then hands the VERIFIED
// findings to this helper, which:
//   - appends each cited finding to a per-topic markdown ledger under
//     <stateDir>/research/<topic>.md, DEDUPED by fingerprint (core/ledger.mjs)
//     so the same claim is never written twice across rounds;
//   - DROPS + LOGS any finding with no source (adversarial-verify built in: a
//     claim with no `source` is not knowledge, it is a guess);
//   - drives the same bounded state machine as the general loop (round/brakes/
//     sticky-exit via core/pingpong-state.mjs) so research is bounded too: it
//     exits on a QUIET round (no NEW verified findings) or on maxRounds.
//
// Commands (args):
//   start  <topic>                       begin a research loop on <topic>
//   record <topic> --finding <text> --source <url> [--path <k>]
//                                        add ONE verified finding (needs a source)
//   round  <topic>                       close a research round: if this round
//                                        added zero NEW verified findings → EXIT
//                                        {quiet}; else advance a turn (maxRounds
//                                        → EXIT{max-rounds})
//   status <topic>                       print state + finding count; touch nothing
//   stop   <topic>                       force EXIT{disabled}
//
// Flags: --repo <path>, --max-rounds <n>, --finding <text>, --source <url>,
//        --path <key> (optional finding subject/file), --surface <name>.
//
// SAFETY: kill switch honored first; every ledger line passes through redact().
// stdlib only (node:*); spawns nothing except the one git rev-parse for repo root.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBPROCESS_TIMEOUT_MS = 60_000;

// Resolve the REAL installed pack root. When this skill is copied by install.sh
// into <repo>/.claude/skills/research-loop/, the two-up path resolves to
// <repo>/.claude (NOT the pack), so a STATIC `../../core/*.mjs` import would fail
// with MODULE_NOT_FOUND at load time. We therefore resolve the pack root at
// runtime and DYNAMICALLY import core from there. Resolution order:
//   1. CCL_PACK_ROOT env (explicit override);
//   2. a .ccl-pack-root marker file install.sh writes next to the copied skill
//      (holds the absolute installed pack dir);
//   3. two levels up — the pack-resident layout (skills/research-loop/ → pack root).
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
  isTerminal,
  isActive,
  isCorrupt,
  terminal,
} = await import(coreUrl("pingpong-state.mjs"));
const { fingerprint } = await import(coreUrl("ledger.mjs"));
const { redact } = await import(coreUrl("redact.mjs"));

// ── argv ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    cmd: null,
    topic: null,
    repo: null,
    maxRounds: null,
    finding: null,
    source: null,
    path: null,
    surface: "research",
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] || null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    else if (a === "--max-rounds") args.maxRounds = Number(argv[++i]);
    else if (a.startsWith("--max-rounds=")) args.maxRounds = Number(a.slice("--max-rounds=".length));
    else if (a === "--finding") args.finding = argv[++i] || null;
    else if (a.startsWith("--finding=")) args.finding = a.slice("--finding=".length);
    else if (a === "--source") args.source = argv[++i] || null;
    else if (a.startsWith("--source=")) args.source = a.slice("--source=".length);
    else if (a === "--path") args.path = argv[++i] || null;
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a === "--surface") args.surface = argv[++i] || "research";
    else if (a.startsWith("--surface=")) args.surface = a.slice("--surface=".length);
    else if (a.startsWith("--")) {
      /* ignore unknown flags — fail-soft */
    } else positional.push(a);
  }
  args.cmd = positional[0] || "status";
  args.topic = positional[1] || null;
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
  return {
    stateDir,
    disabledFile: join(stateDir, "DISABLED"),
    researchDir: join(stateDir, "research"),
  };
}

// Topic names come from a human/agent on the CLI — keep them to a safe
// path-segment charset so no `..`/slash can escape the research dir.
function sanitizeTopic(topic) {
  return String(topic ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}
function stateFile(researchDir, topic) {
  return join(researchDir, `${sanitizeTopic(topic)}.state.json`);
}
function findingsFile(researchDir, topic) {
  return join(researchDir, `${sanitizeTopic(topic)}.md`);
}
function dropLog(researchDir, topic) {
  return join(researchDir, `${sanitizeTopic(topic)}.dropped.log`);
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
  if (isCorrupt(state)) return "CORRUPT → treat as blocked-needs-human on next round";
  return "unknown";
}

// The state file also tracks: the set of fingerprints already in the ledger
// (dedupe), and how many NEW verified findings the CURRENT round has added
// (quiet-round detection). We keep that alongside the pingpong state.
function loadTopicState(researchDir, topic) {
  const raw = readJson(stateFile(researchDir, topic), null);
  if (raw == null) return null;
  return {
    machine: raw.machine || null,
    seen: Array.isArray(raw.seen) ? raw.seen : [],
    roundNew: Number.isInteger(raw.roundNew) ? raw.roundNew : 0,
  };
}
function saveTopicState(researchDir, topic, ts) {
  mkdirSync(researchDir, { recursive: true });
  writeFileSync(
    stateFile(researchDir, topic),
    JSON.stringify({ machine: ts.machine, seen: ts.seen, roundNew: ts.roundNew }),
    "utf8"
  );
}

// ── commands ────────────────────────────────────────────────────────────────
function cmdStart(p, args, cfg) {
  const topic = sanitizeTopic(args.topic);
  mkdirSync(p.researchDir, { recursive: true });
  const maxRounds = Number.isInteger(args.maxRounds) ? args.maxRounds : cfg.pingpong.maxRounds;
  let m = initState(maxRounds);
  m = advance(m, "start");
  saveTopicState(p.researchDir, topic, { machine: m, seen: [], roundNew: 0 });
  // Seed the findings ledger with a header if it does not exist yet.
  const fFile = findingsFile(p.researchDir, topic);
  if (!existsSync(fFile)) {
    writeFileSync(fFile, `# Research ledger: ${redact(topic)}\n\n> Verified, cited findings only. Unsourced claims are dropped.\n`, "utf8");
  }
  console.log(`research '${topic}': started — ${describeState(m)}`);
  console.log(`  → ledger: ${fFile}`);
  console.log("  → do a research pass with YOUR session tools, verify each claim, then `research record`.");
}

function cmdRecord(p, args) {
  const topic = sanitizeTopic(args.topic);
  const ts = loadTopicState(p.researchDir, topic);
  if (ts == null) {
    console.log(`research '${topic}': no such loop — run \`research start ${topic}\` first.`);
    return;
  }
  if (isTerminal(ts.machine)) {
    console.log(`research '${topic}': ${describeState(ts.machine)} — loop already exited; not recording.`);
    return;
  }
  const finding = (args.finding || "").trim();
  const source = (args.source || "").trim();

  // ADVERSARIAL VERIFY, built in: no source → the claim is DROPPED and LOGGED.
  if (!finding) {
    console.log("research: record needs --finding <text>");
    return;
  }
  if (!source) {
    const line = `${new Date().toISOString()}\tDROPPED (no source)\t${redact(finding).slice(0, 200)}\n`;
    try {
      mkdirSync(p.researchDir, { recursive: true });
      writeFileSync(dropLog(p.researchDir, topic), line, { flag: "a" });
    } catch {
      /* fail-soft */
    }
    console.log(`research '${topic}': DROPPED unsourced claim (logged). A claim with no source is a guess, not a finding.`);
    return;
  }

  // DEDUPE by fingerprint (core/ledger.mjs — the triage-format fingerprint).
  const fp = fingerprint({ surface: args.surface || "research", path: args.path || topic, body: finding });
  if (ts.seen.includes(fp)) {
    console.log(`research '${topic}': duplicate finding (already in ledger) — not re-appended.`);
    return;
  }

  // Append the verified, cited finding to the per-topic markdown ledger.
  const entry = `- ${redact(finding)}\n  - source: ${redact(source)}\n`;
  try {
    mkdirSync(p.researchDir, { recursive: true });
    writeFileSync(findingsFile(p.researchDir, topic), entry, { flag: "a" });
  } catch (e) {
    console.log(`research '${topic}': could not append finding — ${e && e.message ? e.message : e}`);
    return;
  }
  ts.seen.push(fp);
  ts.roundNew += 1;
  saveTopicState(p.researchDir, topic, ts);
  console.log(`research '${topic}': recorded verified finding (#${ts.seen.length} total, ${ts.roundNew} new this round).`);
}

function cmdRound(p, args) {
  const topic = sanitizeTopic(args.topic);
  const ts = loadTopicState(p.researchDir, topic);
  if (ts == null) {
    console.log(`research '${topic}': no such loop — run \`research start ${topic}\` first.`);
    return;
  }
  if (isTerminal(ts.machine)) {
    console.log(`research '${topic}': ${describeState(ts.machine)} — already exited.`);
    return;
  }

  // QUIET-ROUND exit: a round that added zero NEW verified findings means the
  // topic is exhausted for now → clean EXIT{quiet}. Otherwise advance a turn
  // (the round counter climbs; reaching maxRounds → EXIT{max-rounds}).
  let next;
  if (ts.roundNew === 0) {
    next = advance(ts.machine, "quiet");
    console.log(`research '${topic}': quiet round (0 new verified findings) → ${describeState(next)}`);
  } else {
    // Two turn-completes close a full round in the ping-pong machine; a research
    // round is one maker/checker cycle, so we advance one turn per closed round
    // and let the machine bound it. Complete the claude leg then the codex leg
    // so the monotone round counter advances exactly once.
    const mid = advance(ts.machine, "turn-complete");
    next = advance(mid, "turn-complete");
    console.log(`research '${topic}': round closed (${ts.roundNew} new) → ${describeState(next)}`);
  }
  ts.machine = next;
  ts.roundNew = 0; // reset the per-round new-finding counter
  saveTopicState(p.researchDir, topic, ts);
  if (isTerminal(next)) {
    if (next.phase === "quiet" || next.phase === "converged")
      console.log("  → DONE. The research loop exited cleanly; the ledger holds the verified findings.");
    else console.log(`  → STOP (${next.phase}). Bounded exit — review the ledger and escalate if needed.`);
  } else {
    console.log("  → CONTINUE: do another research pass, verify, `record`, then `round` again.");
  }
}

function cmdStatus(p, args, cfg) {
  const topic = sanitizeTopic(args.topic);
  const ts = loadTopicState(p.researchDir, topic);
  if (ts == null) {
    console.log(`research '${topic}': no state yet (not started).`);
    return;
  }
  const ks = killSwitchState(cfg, p.disabledFile);
  if (ks.disabled) console.log(`research '${topic}': [kill switch ENGAGED] — rounds will no-op.`);
  console.log(`research '${topic}': ${redact(describeState(ts.machine))}`);
  console.log(`  → ${ts.seen.length} verified finding(s) in the ledger; ${ts.roundNew} new this round.`);
}

function cmdStop(p, args) {
  const topic = sanitizeTopic(args.topic);
  const ts = loadTopicState(p.researchDir, topic);
  const base = ts && ts.machine && Number.isInteger(ts.machine.round) ? ts.machine : {};
  const t = terminal("disabled", base);
  const nextTs = ts || { seen: [], roundNew: 0 };
  nextTs.machine = t;
  saveTopicState(p.researchDir, topic, nextTs);
  console.log(`research '${topic}': stopped — EXITED{disabled}.`);
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(args.repo);
  if (!repoRoot) {
    console.log("research: not inside a git repo (no --repo, git rev-parse failed) — nothing to do");
    return;
  }
  const cfg = loadConfig(process.env);
  const p = paths(repoRoot, cfg);

  const ks = killSwitchState(cfg, p.disabledFile);
  if (ks.disabled && (args.cmd === "start" || args.cmd === "record" || args.cmd === "round")) {
    console.log("research: [kill switch ENGAGED] — disabled; no work done. Run `loop enable`.");
    return;
  }

  if (args.cmd !== "status" && !args.topic && args.cmd !== null) {
    // status also needs a topic below; enforce a topic for the working commands.
  }
  if (["start", "record", "round", "status", "stop"].includes(args.cmd) && !args.topic) {
    console.log(`research: usage — research ${args.cmd} <topic>`);
    return;
  }

  switch (args.cmd) {
    case "start":
      cmdStart(p, args, cfg);
      break;
    case "record":
      cmdRecord(p, args);
      break;
    case "round":
      cmdRound(p, args);
      break;
    case "status":
      cmdStatus(p, args, cfg);
      break;
    case "stop":
      cmdStop(p, args);
      break;
    default:
      console.log(`research: unknown command '${args.cmd}'`);
      console.log("research: usage — research start|record|round|status|stop <topic>");
      break;
  }
}

try {
  main();
} catch (e) {
  console.warn(`research: unexpected error — ${e && e.message ? e.message : e}`);
}
process.exit(0);
