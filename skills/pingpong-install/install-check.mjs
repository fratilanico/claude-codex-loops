#!/usr/bin/env node
// install-check — THIN wrapper for `/pingpong-install check`.
//
// Shells to the pack doctor (bin/doctor.mjs). The doctor is built in a later
// wave; until it exists this wrapper reports that gracefully and NEVER throws
// (it always exits, and exits 0 for the "not yet installed" case so a preflight
// probe stays non-fatal).
//
// stdlib only (node:*).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the REAL installed pack root. When this skill is copied by install.sh
// into <repo>/.claude/skills/pingpong-install/, the two-up path resolves to
// <repo>/.claude (NOT the pack) and DOCTOR would break. So resolve, in order:
//   1. CCL_PACK_ROOT env (explicit override);
//   2. a .ccl-pack-root marker file install.sh writes next to the copied skill
//      (holds the absolute installed pack dir);
//   3. two levels up — the pack-resident layout (skills/pingpong-install/ → pack root).
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
const DOCTOR = join(PACK_ROOT, "bin", "doctor.mjs");

function main() {
  if (!existsSync(DOCTOR)) {
    console.log("pingpong-install: doctor not yet installed (bin/doctor.mjs absent) — skipping preflight");
    return 0;
  }
  const r = spawnSync(process.execPath, [DOCTOR, ...process.argv.slice(2)], { stdio: "inherit" });
  // Propagate the doctor's PASS/FAIL exit status when it ran; default 0 on signal.
  return typeof r.status === "number" ? r.status : 0;
}

process.exit(main());
