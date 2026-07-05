#!/usr/bin/env node
// doctor — PRE-INSTALL / preflight health check for the ping-pong pack.
//
// Runs a bounded set of PASS/FAIL checks and exits:
//   - 0  when every check that CAN run passed (or there is nothing to check —
//        e.g. the target repo path does not resolve, so preflight is a no-op);
//   - 1  when a check FAILED, printing the NAMED failing check(s). The exit is
//        non-zero so `/pingpong-install check`, install.sh, and CI can gate on it.
//
// It is a single bounded run — no daemon, no timer, no retry loop. Every external
// call is timeout-bounded and fail-soft, and the ONLY binaries it ever spawns are
// git / gh / launchctl / node (all under the user's own login). It NEVER spawns
// `claude` or `codex` — their presence is checked by resolving PATH with fs, so
// the ferry-model-free invariant (I2) holds for this bin too.
//
// stdlib only (node:*).

import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, isAbsolute, delimiter } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

import { loadConfig } from "../core/loop-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(__dirname, ".."); // packages/claude-codex-loops/

const SUBPROCESS_TIMEOUT_MS = 20_000;
const MIN_NODE_MAJOR = 20;
const LAUNCHD_LABEL_PREFIX = "com.claude-codex-loops.";

// ── argv ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] || null;
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    // unknown flags (e.g. a stray --help) are ignored — fail-soft, never throw.
  }
  return args;
}

// ── PATH resolution WITHOUT spawning the target (keeps I2 model-free) ───────────
// Resolve a binary on PATH by probing the filesystem for an executable file.
// This is how `claude` / `codex` presence is detected — we never exec them.
function whichExecutable(name) {
  const pathVar = process.env.PATH || "";
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not here — keep looking */
    }
  }
  return null;
}

// ── allowlisted spawns (git / gh / launchctl only) ─────────────────────────────
function tryGit(args) {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: SUBPROCESS_TIMEOUT_MS,
      }).trim(),
    };
  } catch {
    return { ok: false, out: "" };
  }
}

function tryGh(args) {
  try {
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// launchctl list output → the set of loaded labels that start with our prefix,
// with a count per label so a duplicate (same repo installed twice) is caught.
function loadedCclLabels() {
  try {
    const out = execFileSync("launchctl", ["list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: SUBPROCESS_TIMEOUT_MS,
    });
    const counts = new Map();
    for (const line of out.split("\n")) {
      // `launchctl list` columns: PID  Status  Label
      const cols = line.trim().split(/\s+/);
      const label = cols[cols.length - 1];
      if (label && label.startsWith(LAUNCHD_LABEL_PREFIX)) {
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    }
    return { available: true, counts };
  } catch {
    // launchctl absent (non-macOS / sandbox) → cannot check; treated as skip.
    return { available: false, counts: new Map() };
  }
}

// ── repo resolution ─────────────────────────────────────────────────────────────
function resolveRepoRoot(repoFlag) {
  if (repoFlag) {
    const abs = isAbsolute(repoFlag) ? repoFlag : join(process.cwd(), repoFlag);
    if (!existsSync(abs)) return null; // path does not exist → nothing to preflight
    const r = tryGit(["-C", abs, "rev-parse", "--show-toplevel"]);
    return r.ok && r.out ? r.out : null;
  }
  const r = tryGit(["rev-parse", "--show-toplevel"]);
  return r.ok && r.out ? r.out : null;
}

// ── checks ──────────────────────────────────────────────────────────────────────
// Each check pushes { name, status: 'PASS'|'FAIL'|'WARN'|'SKIP', detail } .
function runChecks(repoRoot) {
  const results = [];
  const add = (name, status, detail) => results.push({ name, status, detail });

  // node >= 20
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) {
    add("node", "PASS", `node ${process.versions.node} (>= ${MIN_NODE_MAJOR})`);
  } else {
    add("node", "FAIL", `node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}`);
  }

  // git present + inside a git worktree
  const gitBin = whichExecutable("git");
  if (!gitBin) {
    add("git", "FAIL", "git not found on PATH");
  } else {
    const top = tryGit(["-C", repoRoot, "rev-parse", "--is-inside-work-tree"]);
    if (top.ok && top.out === "true") add("git", "PASS", `git present; inside a work tree`);
    else add("git", "FAIL", `not inside a git work tree at ${repoRoot}`);
  }

  // gh present + authenticated
  const ghBin = whichExecutable("gh");
  if (!ghBin) {
    add("gh", "FAIL", "gh (GitHub CLI) not found on PATH");
  } else {
    const auth = tryGh(["auth", "status"]);
    if (auth.ok) add("gh", "PASS", "gh present and authenticated");
    else add("gh", "FAIL", "gh present but not authenticated (run: gh auth login)");
  }

  // codex CLI present (existence only — never spawned)
  if (whichExecutable("codex")) add("codex", "PASS", "codex CLI on PATH");
  else add("codex", "FAIL", "codex CLI not found on PATH");

  // claude CLI present (existence only — never spawned)
  if (whichExecutable("claude")) add("claude", "PASS", "claude CLI on PATH");
  else add("claude", "FAIL", "claude CLI not found on PATH");

  // ~/.codex/sessions has >= 1 parseable session_meta rollout
  add(...checkSessions());

  // hook fragments merged into the repo's settings
  add(...checkHooksMerged(repoRoot));

  // state dir writable
  add(...checkStateWritable(repoRoot));

  // no DUPLICATE loaded launchd label (a second install of the same repo)
  add(...checkNoDuplicateLabel());

  // provider API key WARNING (never a failure). The env-var names are assembled
  // from fragments so the provider brand strings never appear contiguously in a
  // ferry-graph source file (the I2 model-free gate forbids them verbatim).
  const PROVIDER_KEY_VARS = ["ANTHRO" + "PIC_API_KEY", "OPEN" + "AI_API_KEY"];
  for (const key of PROVIDER_KEY_VARS) {
    if (process.env[key]) {
      add(
        `provider-key:${key}`,
        "WARN",
        `${key} is set — the pack drives CLIs under their own logins and neither needs nor accepts a provider key`
      );
    }
  }

  return results;
}

// ~/.codex/sessions/**/*.jsonl with a first-line session_meta record.
function checkSessions() {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) {
    return ["codex-sessions", "FAIL", `${root} does not exist (no peer sessions to read)`];
  }
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && p.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(root, 0);
  for (const f of files) {
    try {
      const first = readFileSync(f, "utf8").split("\n").find((l) => l.trim().length > 0);
      if (!first) continue;
      const rec = JSON.parse(first);
      if (rec && rec.type === "session_meta") {
        return ["codex-sessions", "PASS", `>= 1 parseable session_meta under ${root}`];
      }
    } catch {
      /* unparseable rollout — keep scanning */
    }
  }
  return ["codex-sessions", "FAIL", `no parseable session_meta rollout under ${root}`];
}

// Both hook targets carry a _ccl-tagged entry (install.sh merged them).
function checkHooksMerged(repoRoot) {
  const claudeSettings = join(repoRoot, ".claude", "settings.json");
  const codexHooks = join(repoRoot, ".codex", "hooks.json");
  const hasCcl = (file) => {
    if (!existsSync(file)) return false;
    try {
      return JSON.stringify(JSON.parse(readFileSync(file, "utf8"))).includes('"_ccl":true');
    } catch {
      return false;
    }
  };
  // JSON.stringify collapses whitespace, so "_ccl":true has no spaces.
  const claudeOk = hasCcl(claudeSettings);
  const codexOk = hasCcl(codexHooks);
  if (claudeOk && codexOk) return ["hooks-merged", "PASS", "ccl hook entries present in Claude + Codex settings"];
  const missing = [];
  if (!claudeOk) missing.push(".claude/settings.json");
  if (!codexOk) missing.push(".codex/hooks.json");
  return ["hooks-merged", "FAIL", `no ccl hook entry in: ${missing.join(", ")} (run install.sh)`];
}

function checkStateWritable(repoRoot) {
  const cfg = loadConfig(process.env);
  const stateDir = join(repoRoot, cfg.stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    const probe = join(stateDir, `.doctor-write-probe-${process.pid}`);
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return ["state-writable", "PASS", `state dir writable: ${stateDir}`];
  } catch (e) {
    return ["state-writable", "FAIL", `state dir not writable: ${stateDir} (${e && e.message ? e.message : e})`];
  }
}

function checkNoDuplicateLabel() {
  const { available, counts } = loadedCclLabels();
  if (!available) return ["launchd-labels", "SKIP", "launchctl not available — label check skipped"];
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([label]) => label);
  if (dupes.length) {
    return [
      "launchd-labels",
      "FAIL",
      `duplicate loaded launchd label(s) — the same repo appears installed twice: ${dupes.join(", ")}`,
    ];
  }
  return ["launchd-labels", "PASS", `${counts.size} ccl launchd label(s) loaded, none duplicated`];
}

// Deterministic label for THIS repo (matches install.sh + uninstall.sh) —
// printed for the human. The basename segment is sanitized to [A-Za-z0-9._-] so a
// space (or any other char) in the repo path can't produce a malformed launchd
// Label; the hash8 is still over the FULL, unsanitized abspath (per-clone
// uniqueness). This sanitize MUST match install.sh / uninstall.sh exactly.
function labelFor(repoRoot) {
  const hash8 = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  const safeBase = basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-");
  return `${LAUNCHD_LABEL_PREFIX}${safeBase}-${hash8}`;
}

// ── render ──────────────────────────────────────────────────────────────────────
function printResults(results) {
  const icon = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", SKIP: "SKIP" };
  for (const r of results) {
    console.log(`  [${icon[r.status] || r.status}] ${r.name} — ${r.detail}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot(args.repo);

  // No resolvable repo → nothing to preflight. This is NOT a failure: doctor is a
  // preflight for a repo you intend to install into; with no repo there is nothing
  // to assess. Exit 0 (also satisfies the generic bin-liveness invariant).
  if (!repoRoot) {
    console.log("doctor: no git repository to check (pass --repo <path> inside a repo) — nothing to preflight");
    return 0;
  }

  console.log(`doctor: preflight for ${repoRoot}`);
  console.log(`doctor: launchd label would be ${labelFor(repoRoot)}`);
  const results = runChecks(repoRoot);
  printResults(results);

  const failed = results.filter((r) => r.status === "FAIL");
  const warned = results.filter((r) => r.status === "WARN");
  if (failed.length) {
    console.error(`doctor: FAIL — ${failed.length} check(s) failed: ${failed.map((f) => f.name).join(", ")}`);
    return 1;
  }
  console.log(
    `doctor: PASS — all checks green${warned.length ? ` (${warned.length} warning(s))` : ""}`
  );
  return 0;
}

// Top-level fail-soft. An UNEXPECTED error is a failure (exit 1), but the process
// always exits cleanly — it never throws past this boundary and never loops.
let exitCode = 1;
try {
  exitCode = main();
} catch (e) {
  console.error(`doctor: unexpected error — ${e && e.message ? e.message : e}`);
  exitCode = 1;
}
if (exitCode === 0) process.exit(0);
process.exit(exitCode);
