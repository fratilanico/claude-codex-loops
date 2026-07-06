#!/usr/bin/env node
// loop-tick — ONE bounded ping-pong tick per run. GENERICIZED from the origin
// codex-loop bridge poll (the bidirectional bridge tick).
//
// WHY: the peer agent (Codex) auto-syncs to this repo and reviews the Claude
// session's work; this closes the loop the other way — each tick (1) PULLS what
// the peer is doing (scoped session findings + peer branch ahead/behind), (2)
// surfaces only what is NEW since the last tick, and (3) PUSHES a machine-readable
// sync-back ack the peer can read. A single-poll SCRIPT, never a daemon — cadence
// is the caller's (launchd StartInterval, or a Claude ScheduleWakeup). Build-time
// ops only; zero runtime autonomous-loop surface and NO model call (I2).
//
// HARD ORDER (safety spine):
//   (a) KILL SWITCH — <stateDir>/DISABLED file OR CCL_DISABLED=1 → exit 0 at once.
//   (b) SINGLE-FLIGHT LOCK — atomic mkdir(<stateDir>/tick.lock) BEFORE any other
//       work. If already held (a slower tick still running, e.g. launchd fired
//       again), log "lock-held" and exit 0. Released in finally. A stale lock
//       older than the lock TTL is reclaimed so a crashed tick cannot wedge the
//       loop forever.
// BOTH (a) and (b) are NEW in the pack — neither exists in the origin codex-loop
// today. Every external git/gh call carries execFileSync timeout: 60_000 so a
// hung subprocess can never defeat "exits 0 always". Exit code is 0 on EVERY
// path, including kill-switch, lock-held, and subprocess timeout.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, isAbsolute } from "node:path";

import {
  parseRevListCount,
  classifyBranchSync,
  newKeys,
  porcelainDirtyPaths,
  rootCheckoutQuestions,
  buildClaudeStatus,
  summarizeTick,
} from "../core/codex-bridge.mjs";
import { loadConfig } from "../core/loop-config.mjs";
import { initState, applyExitState, isTerminal } from "../core/pingpong-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH_SCRIPT = join(__dirname, "watch-codex.mjs"); // sibling ferry

const SUBPROCESS_TIMEOUT_MS = 60_000; // every external git/gh/watch call
const LOCK_TTL_MS = 15 * 60 * 1000; // reclaim a lock older than this (crashed tick)

const now = () => new Date().toISOString();

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { probe: false, digestOnly: false, agent: "codex", repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--probe") args.probe = true;
    else if (a === "--digest-only") args.digestOnly = true;
    else if (a === "--agent") args.agent = argv[++i] || args.agent;
    else if (a.startsWith("--agent=")) args.agent = a.slice("--agent=".length);
    else if (a === "--repo") args.repo = argv[++i] || null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
  }
  // Only claude|codex are meaningful peers; anything else → default.
  if (args.agent !== "claude" && args.agent !== "codex") args.agent = "codex";
  return args;
}

// ── repo root resolution ──────────────────────────────────────────────────────
function resolveRepoRoot(repoFlag) {
  if (repoFlag) {
    const abs = isAbsolute(repoFlag) ? repoFlag : join(process.cwd(), repoFlag);
    return abs;
  }
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

// ── git helpers (all timeout-bounded, fail-soft) ──────────────────────────────
function makeGit(repoRoot) {
  const run = (args, trim) => {
    try {
      const out = execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SUBPROCESS_TIMEOUT_MS,
      });
      return trim ? out.trim() : out;
    } catch {
      return "";
    }
  };
  return { git: (a) => run(a, true), gitRaw: (a) => run(a, false) };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

// ── single-flight lock (atomic mkdir) ─────────────────────────────────────────
// mkdir is atomic on POSIX: it either creates the dir (we hold the lock) or throws
// EEXIST (someone else holds it). No O_EXCL file race, no PID guesswork.
function acquireLock(lockDir) {
  try {
    mkdirSync(lockDir, { recursive: false });
    return true; // acquired
  } catch (e) {
    if (e && e.code === "EEXIST") {
      // Held. Reclaim only if clearly stale (crashed tick left it behind).
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > LOCK_TTL_MS) {
          rmdirSync(lockDir);
          mkdirSync(lockDir, { recursive: false });
          return true; // reclaimed a stale lock
        }
      } catch {
        // race on reclaim → treat as held
      }
      return false; // genuinely held by a live tick
    }
    // Any other error (e.g. parent dir missing) → do not hold; caller mkdirs parent.
    throw e;
  }
}

function releaseLock(lockDir) {
  try {
    rmdirSync(lockDir);
  } catch {
    /* fail-soft — never let cleanup break the exit-0 contract */
  }
}

// ── PULL 1: refresh peer session findings via the sibling watch ferry ──────────
function runWatch(repoRoot, cfg) {
  if (!existsSync(WATCH_SCRIPT)) return;
  try {
    execFileSync(process.execPath, [WATCH_SCRIPT, "--repo", repoRoot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SUBPROCESS_TIMEOUT_MS,
      env: {
        ...process.env,
        CCL_STATE_DIR: cfg.stateDir,
        CODEX_WATCH_REPO_SCOPE: cfg.repoScope,
        // Forward under the name the child's loadConfig actually READS
        // (CODEX_LOOP_WINDOW_HOURS → watchWindowHours). The prior
        // CODEX_WATCH_WINDOW_HOURS name was DEAD env: loadConfig never consumed
        // it, so the child silently fell back to the default 24h window instead
        // of the parent's configured value (finding #13).
        CODEX_LOOP_WINDOW_HOURS: String(cfg.watchWindowHours),
      },
    });
  } catch {
    /* fail-soft: a broken watch must not break the tick */
  }
}

// Extract finding lines ("  [HIGH] ..." / "  [NORMAL] ...") from the shared log.
function readFindingLines(findingsLog) {
  if (!existsSync(findingsLog)) return [];
  const lines = readFileSync(findingsLog, "utf8").split("\n");
  return lines.filter((l) => /^\s*\[(HIGH|NORMAL)\]/.test(l)).map((l) => l.trim());
}

// Extract the peer's terminal exits ("  [CCL-EXIT] <state>") from the shared log,
// in file order (oldest→newest). watch-codex writes these when the peer follows
// the review-contract; the tick maps the MOST RECENT one onto the ping-pong
// state so the peer's terminal actually advances the bounded state machine
// (otherwise the loop never registers that the peer exited). Returns state tokens.
function readExitStates(findingsLog) {
  if (!existsSync(findingsLog)) return [];
  const lines = readFileSync(findingsLog, "utf8").split("\n");
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\s*\[CCL-EXIT\]\s+([a-z][a-z0-9-]*)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── PULL 2: peer branch ahead/behind ──────────────────────────────────────────
function branchStates(git, cfg, dryRun) {
  // In dry-run (--probe / --digest-only) the tick must touch NOTHING on disk. A
  // git fetch writes .git/FETCH_HEAD and remote-tracking refs, so it is skipped
  // here even when cfg.fetch is on — the digest is read-only over existing refs.
  if (cfg.fetch && !dryRun) git(["fetch", "--quiet", "origin", cfg.fetchRefspec]);
  const out = git(["for-each-ref", "--format=%(refname:short)", cfg.branchPrefix]);
  const branches = out ? out.split("\n").filter(Boolean) : [];
  return branches.map((b) => {
    const count = parseRevListCount(git(["rev-list", "--left-right", "--count", `HEAD...${b}`]));
    const cls = classifyBranchSync(count);
    return { branch: b.replace(/^origin\//, ""), ...cls };
  });
}

function rootCheckoutState(git, gitRaw) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const canonicalBranch = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    .replace(/^origin\//, "");
  const status = gitRaw(["status", "--porcelain", "--untracked-files=all"]);
  return { branch, canonicalBranch, dirtyPaths: porcelainDirtyPaths(status) };
}

// Per-thread ping-pong state lives under <stateDir>/pingpong/<thread>.json — the
// SAME layout the human `loop` control plane reads. The ferry keys the thread by
// the peer agent so `loop status` shows the terminal the peer drove it to.
function sanitizeThread(thread) {
  return String(thread ?? "").replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

// The one bounded unit of work — assumes lock held + kill switch already checked.
function tick(repoRoot, cfg, args) {
  const stateDir = join(repoRoot, cfg.stateDir);
  const bridgeDir = join(stateDir, "bridge");
  const pingpongDir = join(stateDir, "pingpong");
  const statusFile = join(bridgeDir, `${args.agent}-status.json`); // sync-back ack
  const lastTickFile = join(bridgeDir, "last-tick.json"); // diff cursor
  const loopLog = join(bridgeDir, "loop.log");
  const findingsLog = join(stateDir, "findings.log");
  const threadFile = join(pingpongDir, `${sanitizeThread(args.agent)}.json`);

  // --probe / --digest-only must touch NOTHING on disk: skip the dir creation and
  // the watch-codex refresh (which writes the cursor + findings.log). The digest is
  // then computed read-only from whatever state already exists.
  const dryRun = args.probe || args.digestOnly;

  if (!dryRun) mkdirSync(bridgeDir, { recursive: true });

  const { git, gitRaw } = makeGit(repoRoot);

  if (!dryRun) runWatch(repoRoot, cfg); // refresh findings.log (parsed from the log)

  // DIFF findings vs last tick.
  const last = readJson(lastTickFile, { findings: [], branches: [], exits: [] });
  const allFindings = readFindingLines(findingsLog);
  const fresh = newKeys(allFindings, last.findings || []);
  const freshHigh = fresh.filter((l) => /^\[HIGH\]/.test(l)).length;

  // DIFF peer CCL-EXIT terminals vs last tick. The peer emits at most one exit per
  // pass; the MOST RECENT new one is what advances the ping-pong state machine.
  const allExits = readExitStates(findingsLog);
  const freshExits = newKeys(allExits, last.exits || []);
  const latestNewExit = freshExits.length ? freshExits[freshExits.length - 1] : null;

  // Advance the bounded ping-pong state by the peer's terminal (if any). Load the
  // persisted per-thread state (or a fresh idle one), apply the exit, and note
  // whether the thread became terminal so we can surface it. PURE transition —
  // sticky terminals + corrupt-fail-safe are enforced inside applyExitState.
  const prevThread = readJson(threadFile, null);
  const baseThread = prevThread ?? initState(cfg.pingpong.maxRounds);
  const nextThread = latestNewExit ? applyExitState(baseThread, latestNewExit) : baseThread;
  const terminalReached = latestNewExit && isTerminal(nextThread) ? nextThread.phase : null;

  // PULL branch states + DIFF (surface branches where the PEER moved, not us).
  const branches = branchStates(git, cfg, dryRun);
  const movedBranches = branches.filter((b) => {
    const prev = (last.branches || []).find((p) => p.branch === b.branch);
    return !prev || prev.codexAhead !== b.codexAhead;
  });

  // Build the sync-back ack.
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]);
  // Full HEAD sha = the scope anchor the peer diffs FROM (review-contract §b).
  // The Codex peer EXITs blocked-needs-human if lastAckSha is missing, so it must
  // always be emitted; fail-soft "" (git failed) serializes to null downstream.
  const lastAckSha = git(["rev-parse", "HEAD"]);
  const branchQuestions = movedBranches
    .filter((b) => b.status === "codex-ahead" || b.status === "diverged")
    .map((b) => `peer branch ${b.branch} is ${b.status} (+${b.codexAhead}) — review/merge?`);
  const checkoutQuestions = rootCheckoutQuestions(rootCheckoutState(git, gitRaw));
  // Surface the peer's terminal in the ack so a human reading the packet (and the
  // peer on its next ack-read) sees the loop reached a terminal for this thread.
  const exitQuestions = terminalReached
    ? [`peer thread ${args.agent} reached terminal '${terminalReached}' — no further ferry rounds until reset`]
    : [];
  const ack = buildClaudeStatus({
    branch,
    head,
    lastAckSha,
    devLoop: null,
    ackFindings: fresh.slice(0, cfg.maxAckFindings),
    openQuestions: [...exitQuestions, ...branchQuestions, ...checkoutQuestions],
    ts: now(),
  });

  const line = summarizeTick({
    newFindings: fresh.length,
    highCount: freshHigh,
    branchStates: branches,
    ts: now(),
  });

  // --probe / --digest-only: print the digest, touch NOTHING on disk.
  if (args.probe || args.digestOnly) {
    console.log(line);
    return;
  }

  // PUSH the ack + persist the diff cursor + the advanced thread state.
  writeFileSync(statusFile, JSON.stringify(ack, null, 2) + "\n", "utf8");
  writeFileSync(
    lastTickFile,
    JSON.stringify(
      { ts: now(), findings: allFindings, branches, exits: allExits },
      null,
      2
    ) + "\n",
    "utf8"
  );
  // Persist the ping-pong state only when it actually moved (or was never written)
  // so a quiet tick doesn't churn the file the control plane reads.
  if (latestNewExit || !prevThread) {
    try {
      mkdirSync(pingpongDir, { recursive: true });
      writeFileSync(threadFile, JSON.stringify(nextThread, null, 2) + "\n", "utf8");
    } catch {
      /* fail-soft — a failed state persist must never break the exit-0 contract */
    }
  }

  console.log(line);
  if (fresh.length) {
    console.log(`loop-tick: ${fresh.length} new finding(s) since last tick:`);
    for (const f of fresh.slice(0, 10)) console.log(`  ${f}`);
  }
  if (movedBranches.length) {
    console.log(`loop-tick: ${movedBranches.length} peer branch(es) moved:`);
    for (const b of movedBranches)
      console.log(`  ${b.branch} → ${b.status} (codexAhead=${b.codexAhead}, weAhead=${b.weAhead})`);
  }
  if (terminalReached) {
    console.log(
      `loop-tick: peer thread ${args.agent} → EXIT{${terminalReached}} (ping-pong state advanced by CCL-EXIT)`
    );
  }
  console.log(`loop-tick: sync-back ack written → ${statusFile}`);

  try {
    const existing = existsSync(loopLog) ? readFileSync(loopLog, "utf8") : "";
    writeFileSync(loopLog, existing + line + "\n", "utf8");
  } catch {
    /* fail-soft */
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(args.repo);
  if (!repoRoot) {
    console.log("loop-tick: not inside a git repo (no --repo, git rev-parse failed) — skipping");
    return;
  }

  // FILE layer: the installer writes <repo>/.claude-codex-loops.json (path overridable
  // via CCL_CONFIG). Load it so the advertised DEFAULTS<file<env<CLI precedence actually
  // holds for the scheduled tick — env-only would make the installed config file inert.
  const configPath = process.env.CCL_CONFIG || join(repoRoot, ".claude-codex-loops.json");
  const fileCfg = readJson(configPath, null);
  const fileLayer = fileCfg && typeof fileCfg === "object" ? { file: fileCfg } : {};
  const cfg = loadConfig(process.env, fileLayer);
  // repoScope neutral sentinel → basename of the repo root.
  const scope = cfg.repoScope || basename(repoRoot);
  const effectiveCfg = cfg.repoScope
    ? cfg
    : loadConfig(process.env, { ...fileLayer, repoScope: scope });

  const stateDir = join(repoRoot, effectiveCfg.stateDir);

  // (a) KILL SWITCH — honored FIRST, before the lock and before any work.
  const disabledFile = join(stateDir, "DISABLED");
  if (effectiveCfg.disabled || existsSync(disabledFile)) {
    console.log("loop-tick: disabled (DISABLED file or CCL_DISABLED=1) — skipping");
    return;
  }

  // Read-only modes (--probe / --digest-only) take NO lock and create NO state:
  // they must touch nothing on disk (the /pingpong pull "inspect-only" contract).
  // tick() also skips its own writes + the watch-codex refresh in this mode.
  if (args.probe || args.digestOnly) {
    tick(repoRoot, effectiveCfg, args);
    return;
  }

  // (b) SINGLE-FLIGHT LOCK — atomic mkdir BEFORE any other work.
  const lockDir = join(stateDir, "tick.lock");
  // Ensure the parent state dir exists so mkdir(lockDir) can succeed atomically.
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    /* fail-soft */
  }
  if (!acquireLock(lockDir)) {
    console.log("loop-tick: lock-held (another tick is running) — skipping");
    return;
  }

  try {
    tick(repoRoot, effectiveCfg, args);
  } finally {
    releaseLock(lockDir);
  }
}

try {
  main();
} catch (e) {
  console.warn(`loop-tick: unexpected error — ${e && e.message ? e.message : e}`);
}
process.exit(0);
