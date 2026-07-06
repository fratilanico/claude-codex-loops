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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCodexPassArgs, buildCodexPassPrompt } from "../../core/codex-pass.mjs";

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

// Kill switch first, before anything else runs.
const stateDir = process.env.CCL_STATE_DIR || ".agent-loops";
if (process.env.CCL_DISABLED === "1" || existsSync(join(repoRoot, stateDir, "DISABLED"))) {
  console.log("codex-pass: kill switch engaged — refusing to run (loop enable to release)");
  process.exit(0);
}

// Fail fast with the corrective action when codex is absent.
const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(
    "codex-pass: codex CLI not found on PATH — install it (npm i -g @openai/codex) or add it to PATH"
  );
  process.exit(1);
}

const prompt = buildCodexPassPrompt(args.confirm ? { confirm: args.confirm } : {});
const { argv, stdin } = buildCodexPassArgs(repoRoot, prompt);

console.log(`codex-pass: one ${args.confirm ? "confirmation" : "review"} pass on ${repoRoot} (timeout ${args.timeout}s)`);
const r = spawnSync("codex", argv, {
  stdio: [stdin, "inherit", "inherit"],
  timeout: args.timeout * 1000,
});
if (r.error && r.error.code === "ETIMEDOUT") {
  console.error(`codex-pass: timed out after ${args.timeout}s (pass killed; nothing re-arms)`);
  process.exit(124);
}
process.exit(r.status ?? 1);
