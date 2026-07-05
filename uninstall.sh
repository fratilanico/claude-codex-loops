#!/usr/bin/env bash
# uninstall.sh — symmetric reversal of install.sh. Removes ONLY what the pack
# added (marker/tag-scoped), never a foreign hook entry, and KEEPS the state dir
# so no loop history is lost (its path is printed). It also writes a DISABLED
# kill-switch file so any still-scheduled tick halts immediately.
#
# Steps:
#   1. launchctl unload + remove the rendered plist for this repo's label.
#   2. remove ONLY the ccl marker-fenced block from AGENTS.md.
#   3. filter ONLY the ccl-tagged hook groups out of .claude/settings.json and
#      .codex/hooks.json (foreign entries untouched).
#   4. write <stateDir>/DISABLED (kill switch).
#   5. print (and keep) the state dir.
#
# Usage: ./uninstall.sh [--repo <path>]

set -euo pipefail

PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="node"

log()   { printf '%s\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31muninstall: %s\033[0m\n' "$*" >&2; exit 1; }

REPO_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)   REPO_ARG="${2:-}"; shift 2 ;;
    --repo=*) REPO_ARG="${1#--repo=}"; shift ;;
    *) shift ;;
  esac
done

if [ -n "$REPO_ARG" ]; then
  [ -d "$REPO_ARG" ] || die "not a directory: $REPO_ARG"
  REPO_ROOT="$(cd "$REPO_ARG" && git rev-parse --show-toplevel 2>/dev/null || true)"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO_ROOT" ] || die "not inside a git repository (run from a repo, or pass --repo <path>)"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

# Sanitize the basename segment to [A-Za-z0-9._-] (a space in the repo path would
# yield a malformed label) — MUST match install.sh + doctor.mjs so the label
# agrees. hash8 is still over the full unsanitized abspath (per-clone uniqueness).
LABEL="$("$NODE_BIN" -e 'const c=require("node:crypto"),p=require("node:path");const r=process.argv[1];const h=c.createHash("sha256").update(r).digest("hex").slice(0,8);const b=p.basename(r).replace(/[^A-Za-z0-9._-]/g,"-");process.stdout.write("com.claude-codex-loops."+b+"-"+h)' "$REPO_ROOT")"
STATE_DIR="$("$NODE_BIN" -e '
import("file://"+process.argv[2]+"/core/loop-config.mjs").then(m=>{process.stdout.write(m.loadConfig(process.env).stateDir);}).catch(()=>{process.stdout.write(".agent-loops");});
' -- "$PACK_ROOT")"

log "uninstall: target = $REPO_ROOT"
log "uninstall: label  = $LABEL"

# ── 1. unload + remove the plist ──────────────────────────────────────────────
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
if command -v launchctl >/dev/null 2>&1; then
  launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
fi
if [ -f "$PLIST_DEST" ]; then
  rm -f "$PLIST_DEST"
  log "uninstall: removed launchd plist $PLIST_DEST"
else
  log "uninstall: no launchd plist at $PLIST_DEST (nothing to remove)"
fi

# ── 2. remove ONLY the ccl marker-fenced block from AGENTS.md ──────────────────
AGENTS="$REPO_ROOT/AGENTS.md"
BEGIN_MARK="<!-- ccl:begin -->"
END_MARK="<!-- ccl:end -->"
if [ -f "$AGENTS" ] && grep -qF "$BEGIN_MARK" "$AGENTS"; then
  "$NODE_BIN" -e '
    const fs=require("node:fs");
    const dest=process.argv[1], b=process.argv[2], e=process.argv[3];
    let s=fs.readFileSync(dest,"utf8");
    const bi=s.indexOf(b);
    const ei=s.indexOf(e);
    if(bi>=0&&ei>=0){
      const end=ei+e.length;
      // also swallow a single trailing newline block left behind
      let after=s.slice(end).replace(/^\n+/,"\n");
      s=s.slice(0,bi).replace(/\n+$/,"\n")+after;
      fs.writeFileSync(dest, s, "utf8");
    }
  ' "$AGENTS" "$BEGIN_MARK" "$END_MARK"
  log "uninstall: removed the ccl review-contract block from AGENTS.md"
else
  log "uninstall: no ccl block in AGENTS.md (nothing to remove)"
fi

# ── 3. filter ONLY ccl-tagged hook groups ─────────────────────────────────────
MERGE="$PACK_ROOT/schedule/merge-json.mjs"
for target in "$REPO_ROOT/.claude/settings.json" "$REPO_ROOT/.codex/hooks.json"; do
  if [ -f "$target" ]; then
    "$NODE_BIN" "$MERGE" unmerge "$target"
  fi
done

# ── 4. write the kill switch ──────────────────────────────────────────────────
KILL_DIR="$REPO_ROOT/$STATE_DIR"
mkdir -p "$KILL_DIR"
printf 'disabled by uninstall @ %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$KILL_DIR/DISABLED"
log "uninstall: wrote kill switch $KILL_DIR/DISABLED"

# ── 5. keep + print the state dir ─────────────────────────────────────────────
green "uninstall: DONE"
log   "  • launchd job + plist removed"
log   "  • ccl hook groups + AGENTS.md block removed (foreign entries untouched)"
log   "  • state dir KEPT (loop history preserved): $KILL_DIR"
log   ""
log   "The config (.claude-codex-loops.json), skills, and .gitignore line are left"
log   "in place — remove them by hand if you want a fully clean tree."
