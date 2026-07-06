#!/usr/bin/env node
// codex-pass — run ONE headless Codex review pass with every hang safeguard
// baked in (see core/codex-pass.mjs for why each exists). Bounded: one spawn,
// hard timeout, exits with the codex exit code. Never loops, never re-arms.
//
//   node bin/codex-pass.mjs [--repo <path>] [--confirm "<prior finding>"]
//                           [--timeout <seconds>]
//
// SAFETY: the kill switch (<stateDir>/DISABLED or CCL_DISABLED=1) is honored
// FIRST — same contract as every other bin in this pack.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the REAL installed pack root, same contract as pingpong.mjs. When
// install.sh copies THIS skill into <repo>/.claude/skills/pingpong/, only the
// skill files + a .ccl-pack-root marker are copied — there is NO
// <repo>/.claude/core/. A static `import "../../core/..."` would therefore
// resolve to the non-existent <repo>/.claude/core/codex-pass.mjs and throw
// ERR_MODULE_NOT_FOUND before any code (even the kill switch) runs. So resolve,
// in order: 1. CCL_PACK_ROOT env; 2. the marker file; 3. two-up (pack-resident).
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
const { buildCodexPassArgs, buildCodexPassPrompt } = await import(
  pathToFileURL(join(PACK_ROOT, "core", "codex-pass.mjs")).href
);
const { loadConfig } = await import(
  pathToFileURL(join(PACK_ROOT, "core", "loop-config.mjs")).href
);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const out = { repo: "", confirm: "", timeout: 300 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") out.repo = argv[++i] ?? "";
    else if (argv[i] === "--confirm") out.confirm = argv[++i] ?? "";
    else if (argv[i] === "--timeout") out.timeout = Number(argv[++i]) || 300;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

let repoRoot = args.repo;
try {
  repoRoot = execFileSync("git", ["-C", repoRoot || ".", "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
} catch {
  console.error(`codex-pass: not a git repository: ${args.repo || process.cwd()}`);
  process.exit(1);
}

// Kill switch first, before anything else runs. Resolve stateDir through the SAME
// DEFAULTS<file<env precedence loop-tick honors — a repo that configures a custom
// stateDir in .claude-codex-loops.json (path overridable via CCL_CONFIG) puts its
// DISABLED file THERE, so an env-only check would silently bypass the kill switch.
const configPath = process.env.CCL_CONFIG || join(repoRoot, ".claude-codex-loops.json");
const fileCfg = readJson(configPath, null);
const fileLayer = fileCfg && typeof fileCfg === "object" ? { file: fileCfg } : {};
const cfg = loadConfig(process.env, fileLayer);
if (cfg.disabled || existsSync(join(repoRoot, cfg.stateDir, "DISABLED"))) {
  console.log("codex-pass: kill switch engaged — refusing to run (loop enable to release)");
  process.exit(0);
}

// Fail fast with the corrective action when codex is absent. The preflight is
// hardened like the main pass: stdin closed, bounded, uncatchable kill — a
// stalling `codex --version` (update check, env issue, stdin read) must not
// hang the "never hangs" driver before its own bounded spawn.
const probe = spawnSync("codex", ["--version"], {
  stdio: ["ignore", "ignore", "ignore"],
  timeout: 10_000,
  killSignal: "SIGKILL",
});
if (probe.error || probe.status !== 0) {
  console.error(
    "codex-pass: codex CLI not found on PATH — install it (npm i -g @openai/codex) or add it to PATH"
  );
  process.exit(1);
}

const prompt = buildCodexPassPrompt(args.confirm ? { confirm: args.confirm } : {});
const { argv, stdin } = buildCodexPassArgs(repoRoot, prompt);

console.log(`codex-pass: one ${args.confirm ? "confirmation" : "review"} pass on ${repoRoot} (timeout ${args.timeout}s)`);
// killSignal SIGKILL: spawnSync's default SIGTERM can be caught/ignored by a
// hung codex (observed live: killed wrappers left codex orphans running for
// hours) — the hard-timeout contract needs a signal that cannot be trapped.
const r = spawnSync("codex", argv, {
  stdio: [stdin, "inherit", "inherit"],
  timeout: args.timeout * 1000,
  killSignal: "SIGKILL",
});
if (r.error && r.error.code === "ETIMEDOUT") {
  console.error(`codex-pass: timed out after ${args.timeout}s (pass killed; nothing re-arms)`);
  process.exit(124);
}
process.exit(r.status ?? 1);
