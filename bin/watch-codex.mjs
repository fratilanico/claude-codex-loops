#!/usr/bin/env node
// watch-codex — bounded single-poll watcher: peer (Codex) local review sessions
// → scoped findings → local ping-pong backlog. GENERICIZED from the origin
// watch-codex poller.
//
// Cadence comes from the caller (launchd, or a Claude SessionStart hook / the
// sibling loop-tick). This script is NOT a daemon — it runs once, scans recent
// peer session rollout files for THIS repo, extracts concise findings, appends
// them to a local report, then exits.
//
// PRIVACY CRITICAL:
//   - Only processes sessions whose session_meta.payload.cwd is scoped to this
//     repo (path-boundary match: a path segment equals the repo scope, not a
//     substring). Out-of-scope sessions have ZERO content read.
//   - Raw transcripts are NEVER logged; only short extracted finding summaries.
//   - Every emitted string passes through the pack runtime redactor
//     (core/redact.mjs) before output.
//   - Default: LOCAL only (print + <stateDir>/findings.log). GH issue filing
//     requires explicit CCL_WATCH_FILE_ISSUES=1.
//
// NEW-CODE DELTA vs the origin poller: explicit CCL-FINDING / CCL-EXIT marker
// extraction. When the peer follows the AGENTS review-contract it emits machine
// lines `CCL-FINDING [HIGH|NORMAL] <text>` and `CCL-EXIT <state>` — those are
// parsed structurally (highest-confidence signal, no keyword heuristics). The
// heuristic keyword extractor is KEPT as a fallback for un-instrumented sessions.
// An unrecognized rollout format emits ONE explicit log line and is skipped.
//
// Fail-soft: any error is logged and the script exits 0 — never breaks a session.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, basename, isAbsolute } from "node:path";

// Pack runtime output filter — the only source-code dependency (core-only, stdlib
// otherwise). Redacts secret shapes from everything this ferry emits.
import { redact } from "../core/redact.mjs";

import { loadConfig } from "../core/loop-config.mjs";

const SCRIPT = "watch-codex";
const SUBPROCESS_TIMEOUT_MS = 60_000;

// ── argv (repo root) ──────────────────────────────────────────────────────────
function parseRepoFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") return argv[i + 1] || null;
    if (argv[i].startsWith("--repo=")) return argv[i].slice("--repo=".length);
  }
  return null;
}

const REPO_FLAG = parseRepoFlag(process.argv.slice(2));
const REPO_ROOT = REPO_FLAG
  ? isAbsolute(REPO_FLAG)
    ? REPO_FLAG
    : join(process.cwd(), REPO_FLAG)
  : process.cwd();

const CFG = loadConfig(process.env);

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = homedir();
const CODEX_DIR = join(HOME, ".codex");
const SESSIONS_DIR = join(CODEX_DIR, "sessions");
const WORKTREES_DIR = join(CODEX_DIR, "worktrees");
const AUTOMATIONS_DIR = join(CODEX_DIR, "automations");

// State dir is per-clone under the repo root (never /tmp, never a consumer path).
const STATE_DIR = join(REPO_ROOT, CFG.stateDir);
// Cursor lives under <stateDir>/cursor/ (was a shared /tmp dir in the original).
const CURSOR_DIR = join(STATE_DIR, "cursor");
const CURSOR_FILE = join(CURSOR_DIR, "watch-codex.cursor");
// Local findings log under <stateDir>.
const FINDINGS_LOG = join(STATE_DIR, "findings.log");

// Repo scope — path-boundary match. Neutral: basename of the repo root unless the
// config/env overrides it (env-NAME-as-config-data; the VALUE flows through).
const REPO_SCOPE = CFG.repoScope || basename(REPO_ROOT);
const REPO_SCOPE_RE = new RegExp(
  "(^|/)" + REPO_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(/|$)"
);

const WINDOW_HOURS = Math.max(1, Number(CFG.watchWindowHours) || 24);
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

// ── Structured CCL markers (the NEW-code delta) ───────────────────────────────
// The AGENTS review-contract instructs the peer to emit these exact lines. They
// are parsed structurally so instrumented sessions need no keyword heuristics.
//   CCL-FINDING [HIGH]  message…
//   CCL-FINDING [NORMAL] message…
//   CCL-EXIT converged | quiet | max-rounds | no-progress | stale | blocked-needs-human
const CCL_FINDING_RE = /\bCCL-FINDING\s*\[(HIGH|NORMAL)\]\s*(.+)$/;
const CCL_EXIT_RE = /\bCCL-EXIT\s+([a-z][a-z0-9-]*)\b/;

// ── Heuristic fallback keyword sets (GENERIC — no fleet/consumer literals) ─────
// Kept for sessions that do NOT emit CCL markers. Deliberately generic: security
// / correctness signal + finding language, so the watcher works on any repo.
const HIGH_PRIORITY_RE =
  /\b(security|leak|secret|credential|vulnerab|injection|auth|bypass|race|deadlock|data[-\s]?loss|corruption|regression|CI|typecheck|null|undefined|crash)\b/i;
const FINDING_SIGNAL_RE =
  /\b(security|leak|secret|credential|vulnerab|injection|auth|bypass|race|deadlock|corruption|regression|null|undefined|crash)\b/i;
const FINDING_LANGUAGE_RE =
  /\b(bug|fail|error|should|must|incorrect|missing|broken|vulnerab|fix)\b/i;

const FILE_ISSUES = process.env.CCL_WATCH_FILE_ISSUES === "1";
const MAX_FINDINGS_PER_RUN = 40;

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncate(text, max = 200) {
  const s = String(text ?? "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function readCursor() {
  try {
    if (existsSync(CURSOR_FILE)) {
      const val = Number(readFileSync(CURSOR_FILE, "utf8").trim());
      if (!Number.isNaN(val) && val > 0) return val;
    }
  } catch {
    // ignore
  }
  return 0;
}

function writeCursor(ts) {
  try {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(CURSOR_FILE, String(ts), "utf8");
  } catch (e) {
    console.warn(`${SCRIPT}: could not write cursor — ${e.message}`);
  }
}

function appendToLog(lines) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const content = lines.join("\n") + "\n";
    const existing = existsSync(FINDINGS_LOG) ? readFileSync(FINDINGS_LOG, "utf8") : "";
    writeFileSync(FINDINGS_LOG, existing + content, "utf8");
  } catch (e) {
    console.warn(`${SCRIPT}: could not write findings log — ${e.message}`);
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: SUBPROCESS_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function ghIssueExists(title) {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "--state", "all", "--search", title, "--json", "title", "--limit", "50"],
      { encoding: "utf8", timeout: SUBPROCESS_TIMEOUT_MS }
    );
    const issues = JSON.parse(out || "[]");
    return issues.some((i) => i.title === title);
  } catch {
    return false;
  }
}

function fileGhIssue(title, body) {
  const baseArgs = [
    "issue", "create", "--title", title, "--body", body, "--label", "ccl-review",
  ];
  const highArgs = [...baseArgs, "--label", "priority:high"];
  try {
    execFileSync("gh", highArgs, { encoding: "utf8", stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS });
    console.log(`${SCRIPT}: filed GH issue — ${title}`);
  } catch {
    try {
      execFileSync("gh", baseArgs, { encoding: "utf8", stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS });
      console.log(`${SCRIPT}: filed GH issue (no priority label) — ${title}`);
    } catch (e2) {
      console.warn(`${SCRIPT}: gh issue create failed — ${e2.message}`);
      console.log(`${SCRIPT}: [PRINT FALLBACK] ${title}\n${body}`);
    }
  }
}

function normalizeForDedup(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Session file discovery ────────────────────────────────────────────────────

function findSessionFiles(sinceMs, cursorMs) {
  const files = [];
  const nowMs = Date.now();
  const windowCutoff = nowMs - sinceMs;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.match(/^rollout-.*\.jsonl$/)) {
        // within window (mtime >= cutoff) AND strictly newer than cursor (> cursor).
        if (st.mtimeMs >= windowCutoff && st.mtimeMs > cursorMs) {
          files.push({ path: full, mtimeMs: st.mtimeMs });
        }
      }
    }
  }

  walk(SESSIONS_DIR);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest-first so cursor advances right
  return files;
}

// ── Session parsing ───────────────────────────────────────────────────────────

// Returns:
//   null                  — out of scope / unreadable (content never read)
//   { unknownFormat: true }— first line parsed but is NOT a session_meta record
//   { sessionId, cwd, sessionTs, textChunks }  — in-scope, parsed
function parseSession(filePath) {
  let lines;
  try {
    lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  let meta;
  try {
    meta = JSON.parse(lines[0]);
  } catch {
    // First line is not JSON at all → unknown rollout format.
    return { unknownFormat: true, reason: "first-line-not-json" };
  }

  if (!meta || meta.type !== "session_meta") {
    // Recognized JSONL but not the rollout schema we understand.
    return { unknownFormat: true, reason: `first-record-type=${meta && meta.type}` };
  }

  const payload = meta.payload ?? {};
  const cwd = payload.cwd ?? "";
  const sessionId = payload.id ?? filePath;
  const sessionTs = payload.timestamp ?? meta.timestamp ?? "";

  // Path-boundary scope: out-of-scope → return null immediately (content unread).
  if (!REPO_SCOPE_RE.test(cwd)) return null;

  // In-scope: read assistant/agent turns only (never user turns or tool dumps).
  const textChunks = [];
  for (let i = 1; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const evType = obj.type;
    const p = obj.payload ?? {};

    if (evType === "event_msg" && p.type === "agent_message" && p.message) {
      textChunks.push({ text: String(p.message), source: "agent_message" });
    }
    if (evType === "response_item" && p.role === "assistant" && Array.isArray(p.content)) {
      for (const item of p.content) {
        if (item && item.type === "output_text" && item.text) {
          textChunks.push({ text: String(item.text), source: "assistant_output" });
        }
      }
    }
    // function_call_output (tool results) deliberately excluded.
  }

  return { sessionId, cwd, sessionTs, textChunks };
}

// ── Finding extraction ────────────────────────────────────────────────────────

// Returns { findings: [{summary, priority, marker}], exits: [state,…] }.
function extractFindings(session) {
  const rawFindings = [];
  const exits = [];

  for (const { text } of session.textChunks) {
    const linesOf = text.split("\n");

    // (1) STRUCTURED CCL markers — highest confidence, parsed per line.
    for (const raw of linesOf) {
      const fm = raw.match(CCL_FINDING_RE);
      if (fm) {
        const priority = fm[1].toUpperCase() === "HIGH" ? "HIGH" : "NORMAL";
        rawFindings.push({
          // REDACT BEFORE TRUNCATE (finding #7): truncating first can slice a
          // secret across the 180-char cut, dropping it below the redactor's
          // length floor so a partial token survives. Redact the FULL string,
          // then truncate the already-scrubbed text.
          summary: truncate(redact(fm[2].trim()), 180),
          priority,
          marker: true,
        });
        continue;
      }
      const em = raw.match(CCL_EXIT_RE);
      if (em) exits.push(em[1]);
    }

    // (2) HEURISTIC fallback — sentence-level, for un-instrumented sessions.
    const sentences = text
      .split(/[.\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10);
    for (const sentence of sentences) {
      if (/^(#{1,6}\s|[-*]{3,}$|>\s|[-*+]\s\[)/.test(sentence)) continue;
      if (/^\s*[-*]\s+\[.*\]\(#/.test(sentence)) continue;
      // Never double-count a line that already produced a structured marker.
      if (CCL_FINDING_RE.test(sentence) || CCL_EXIT_RE.test(sentence)) continue;
      if (FINDING_SIGNAL_RE.test(sentence) && FINDING_LANGUAGE_RE.test(sentence)) {
        rawFindings.push({
          // REDACT BEFORE TRUNCATE (finding #7) — see the marker path above.
          summary: truncate(redact(sentence), 180),
          priority: HIGH_PRIORITY_RE.test(sentence) ? "HIGH" : "NORMAL",
          marker: false,
        });
      }
    }
  }

  const seen = new Set();
  const deduped = rawFindings.filter((f) => {
    const key = normalizeForDedup(f.summary);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { findings: deduped, exits: [...new Set(exits)] };
}

// ── Worktree inspection ───────────────────────────────────────────────────────

function inspectWorktrees() {
  const results = [];
  if (!existsSync(WORKTREES_DIR)) return results;
  let ids;
  try {
    ids = readdirSync(WORKTREES_DIR);
  } catch {
    return results;
  }
  for (const id of ids) {
    const wtBase = join(WORKTREES_DIR, id);
    let repos;
    try {
      repos = readdirSync(wtBase);
    } catch {
      continue;
    }
    for (const repoName of repos) {
      if (!REPO_SCOPE_RE.test("/" + repoName + "/") && repoName !== REPO_SCOPE) continue;
      const wtPath = join(wtBase, repoName);
      let statusOut = "";
      let logOut = "";
      try {
        statusOut = execFileSync("git", ["-C", wtPath, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: "pipe",
          timeout: SUBPROCESS_TIMEOUT_MS,
        }).trim();
      } catch {
        /* not a git repo / git unavailable */
      }
      try {
        logOut = execFileSync("git", ["-C", wtPath, "log", "--oneline", "-5"], {
          encoding: "utf8",
          stdio: "pipe",
          timeout: SUBPROCESS_TIMEOUT_MS,
        }).trim();
      } catch {
        /* ignore */
      }
      results.push({ id, path: wtPath, status: statusOut, log: logOut });
    }
  }
  return results;
}

function listAutomations() {
  if (!existsSync(AUTOMATIONS_DIR)) return [];
  try {
    return readdirSync(AUTOMATIONS_DIR);
  } catch {
    return [];
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(CODEX_DIR)) {
    console.log(`${SCRIPT}: ~/.codex not found — skipping`);
    process.exit(0);
  }

  const cursor = readCursor();
  console.log(
    `${SCRIPT}: scanning last ${WINDOW_HOURS}h of peer sessions (scope=${REPO_SCOPE}, cursor=${cursor})`
  );

  const sessionFiles = findSessionFiles(WINDOW_MS, cursor);
  console.log(`${SCRIPT}: ${sessionFiles.length} session file(s) in window`);

  const reportLines = [
    `# ${SCRIPT} run @ ${new Date().toISOString()}  (window=${WINDOW_HOURS}h, scope=${REPO_SCOPE})`,
  ];

  let latestMtime = cursor;
  let totalFindings = 0;
  let markerFindings = 0;
  let highCount = 0;
  let droppedFindings = 0;
  let unknownFormatCount = 0;
  const allExits = [];
  const issuesFiled = [];

  for (const { path: filePath, mtimeMs } of sessionFiles) {
    const session = parseSession(filePath);
    if (!session) continue; // out of scope / unreadable

    if (session.unknownFormat) {
      // Explicit, single log line per unrecognized file — never silent.
      unknownFormatCount++;
      const msg = `${SCRIPT}: unknown rollout format (${session.reason}) — skipping ${basename(filePath)}`;
      console.log(msg);
      reportLines.push(`\n## SKIP unknown rollout format (${session.reason}) — ${basename(filePath)}`);
      if (mtimeMs > latestMtime) latestMtime = mtimeMs;
      continue;
    }

    const { findings, exits } = extractFindings(session);
    for (const e of exits) allExits.push(e);

    if (findings.length === 0 && exits.length === 0) {
      reportLines.push(`\n## Session ${session.sessionId} (${session.cwd}) — no actionable findings`);
    } else {
      reportLines.push(
        `\n## Session ${session.sessionId}  cwd=${session.cwd}  ts=${session.sessionTs}`
      );
      for (const f of findings) {
        if (totalFindings >= MAX_FINDINGS_PER_RUN) {
          droppedFindings++;
          continue;
        }
        const tag = f.marker ? "CCL-FINDING" : `${f.priority}`;
        const line = `  [${f.priority}] ${f.summary}`;
        reportLines.push(line);
        console.log(`${SCRIPT}: ${tag} ${line.trim()}`);
        totalFindings++;
        if (f.marker) markerFindings++;
        if (f.priority === "HIGH") highCount++;

        if (FILE_ISSUES && f.priority === "HIGH" && ghAvailable()) {
          const title = `Peer finding: ${f.summary.slice(0, 80)}`;
          if (!ghIssueExists(title)) {
            const body = [
              `**Classification:** HIGH`,
              `**Session:** ${session.sessionId}`,
              `**Repo cwd:** ${session.cwd}`,
              `**Session timestamp:** ${session.sessionTs}`,
              "", "---", "",
              f.summary,
            ].join("\n");
            fileGhIssue(title, body);
            issuesFiled.push(title);
          } else {
            console.log(`${SCRIPT}: skip (already filed) — ${title}`);
          }
        }
      }
      for (const e of exits) {
        const line = `  [CCL-EXIT] ${e}`;
        reportLines.push(line);
        console.log(`${SCRIPT}: CCL-EXIT ${e}`);
      }
    }

    if (mtimeMs > latestMtime) latestMtime = mtimeMs;
  }

  if (droppedFindings > 0) {
    reportLines.push(
      `\n## NOTE: ${droppedFindings} additional finding(s) dropped (cap=${MAX_FINDINGS_PER_RUN}/run)`
    );
    console.log(`${SCRIPT}: ${droppedFindings} finding(s) dropped (cap=${MAX_FINDINGS_PER_RUN}/run)`);
  }

  const worktrees = inspectWorktrees();
  if (worktrees.length > 0) {
    reportLines.push(`\n## Peer worktrees (${REPO_SCOPE})`);
    for (const wt of worktrees) {
      reportLines.push(`### Worktree ${wt.id}  path=${wt.path}`);
      if (wt.log) {
        const cleanLog = redact(wt.log);
        reportLines.push(`Recent commits:\n${cleanLog}`);
      }
      if (wt.status) {
        const cleanStatus = redact(wt.status);
        reportLines.push(`Uncommitted changes:\n${cleanStatus}`);
      } else {
        reportLines.push("Working tree clean.");
      }
    }
  } else {
    reportLines.push(`\n## Peer worktrees — none found for ${REPO_SCOPE}`);
  }

  const automations = listAutomations();
  reportLines.push(
    `\n## Peer automations (${automations.length} total)\n${
      automations.length > 0 ? automations.map((a) => `  - ${a}`).join("\n") : "  (none)"
    }`
  );

  const exitSummary = allExits.length ? [...new Set(allExits)].join(", ") : "none";
  reportLines.push(
    `\n## Summary  findings=${totalFindings} (HIGH=${highCount}, CCL-marker=${markerFindings})  exits=[${exitSummary}]  sessions_scanned=${sessionFiles.length}  unknown_format=${unknownFormatCount}  worktrees=${worktrees.length}  issues_filed=${issuesFiled.length}`
  );
  console.log(
    `${SCRIPT}: done — ${totalFindings} finding(s) (${highCount} HIGH, ${markerFindings} CCL-marker), exits=[${exitSummary}] across ${sessionFiles.length} session(s)`
  );

  appendToLog(reportLines);

  if (latestMtime > cursor) writeCursor(latestMtime);
}

main().catch((e) => {
  console.warn(`${SCRIPT}: unexpected error — ${e.message}`);
  process.exit(0);
});
