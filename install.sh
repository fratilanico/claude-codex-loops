#!/usr/bin/env bash
# install.sh — one-shot, idempotent installer for the claude-codex-loops pack.
#
# macOS / launchd ONLY for v0.1.0. It REFUSES to run on any other platform with a
# clear message (Linux/cron is v0.2). It is safe to re-run: every step is
# grep-first or hash-skip or a structural JSON merge, so a second run makes no
# further change. It NEVER clobbers your config or a foreign hook entry, and
# uninstall.sh reverses every step.
#
# Steps (in order):
#   0. doctor preflight (informational — a red preflight warns but does not abort;
#      a hard environment failure like "not a git repo" does abort).
#   1. refuse outside a git repo; refuse on non-darwin.
#   2. copy config.example.json -> <repo>/.claude-codex-loops.json (only if absent).
#   3. append <stateDir>/ to <repo>/.gitignore (grep-first).
#   4. copy the three skills into the consumer skills dir (hash-skip unchanged).
#   5. deep-merge the hook fragments into <repo>/.claude/settings.json AND
#      <repo>/.codex/hooks.json (node JSON merge, .bak.<ts> backup, printed diff).
#   6. append the marker-fenced AGENTS review-contract into <repo>/AGENTS.md.
#   7. render + load the launchd plist (unique per-clone label; interval floored).
#   8. run ONE smoke tick and assert a claude-status.json is produced.
#   9. print a green summary.
#
# Usage: ./install.sh [--repo <path>] [--skills-dir <path>] [--no-launchd]

set -euo pipefail

# ── resolve pack root (dir of this script), absolutely ────────────────────────
PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="node"

# ABSOLUTE node interpreter path for the launchd plist. launchd starts jobs with
# a minimal PATH (no Homebrew), so `/usr/bin/env node` inside the plist would not
# find node and every scheduled tick would silently fail. Bake in the absolute
# path resolved here (fall back to the bare name only if resolution fails).
NODE_ABS="$(command -v "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"

log()   { printf '%s\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31minstall: %s\033[0m\n' "$*" >&2; exit 1; }

# ── args ───────────────────────────────────────────────────────────────────────
REPO_ARG=""
SKILLS_DIR_ARG=""
DO_LAUNCHD=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)       REPO_ARG="${2:-}"; shift 2 ;;
    --repo=*)     REPO_ARG="${1#--repo=}"; shift ;;
    --skills-dir) SKILLS_DIR_ARG="${2:-}"; shift 2 ;;
    --skills-dir=*) SKILLS_DIR_ARG="${1#--skills-dir=}"; shift ;;
    --no-launchd) DO_LAUNCHD=0; shift ;;
    *) shift ;;
  esac
done

# ── 1a. refuse on non-darwin (launchd-only in v0.1.0) ─────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
if [ "$OS" != "Darwin" ]; then
  die "launchd-only in v0.1.0; Linux/cron is v0.2 (detected: $OS)"
fi

# ── 1b. resolve + refuse outside a git repo ───────────────────────────────────
if [ -n "$REPO_ARG" ]; then
  [ -d "$REPO_ARG" ] || die "not a directory: $REPO_ARG"
  REPO_ROOT="$(cd "$REPO_ARG" && git rev-parse --show-toplevel 2>/dev/null || true)"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$REPO_ROOT" ] || die "not inside a git repository (run from a repo, or pass --repo <path>)"
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"

log "install: pack   = $PACK_ROOT"
log "install: target = $REPO_ROOT"

# ── 0. doctor preflight (informational) ───────────────────────────────────────
if [ -f "$PACK_ROOT/bin/doctor.mjs" ]; then
  log "install: running doctor preflight (informational)…"
  if ! "$NODE_BIN" "$PACK_ROOT/bin/doctor.mjs" --repo "$REPO_ROOT"; then
    warn "install: doctor reported preflight failures above — continuing (re-run \`node bin/doctor.mjs\` after install to re-check)."
  fi
fi

# ── derived values via node (relpath, label hash, config) ─────────────────────
# All string data — no secrets. node does the path/hash math so we don't depend
# on shasum/jq flavors.
# Canonicalize BOTH sides before computing the relative path: on macOS a repo
# reached via /var/folders resolves to /private/var/folders under git, and a
# /var-vs-/private/var symlink split would otherwise inject a spurious upward
# traversal (and a home-shaped absolute path) into the relative pack path.
# realpathSync on both sides makes REL_PACK a clean, minimal relative path
# whenever the pack is vendored inside the repo.
REL_PACK="$("$NODE_BIN" -e 'const p=require("node:path"),fs=require("node:fs");const rp=(x)=>{try{return fs.realpathSync(x)}catch{return x}};process.stdout.write(p.relative(rp(process.argv[1]),rp(process.argv[2]))||".")' "$REPO_ROOT" "$PACK_ROOT")"
# The label's human segment is the repo basename; a space (or any non
# [A-Za-z0-9._-] char) in the repo path would make a malformed launchd Label, so
# sanitize the basename to that charset. The hash8 is still over the FULL,
# unsanitized abspath, so per-clone uniqueness is preserved (doctor.mjs and
# uninstall.sh sanitize identically so all three agree on the label).
LABEL="$("$NODE_BIN" -e 'const c=require("node:crypto"),p=require("node:path");const r=process.argv[1];const h=c.createHash("sha256").update(r).digest("hex").slice(0,8);const b=p.basename(r).replace(/[^A-Za-z0-9._-]/g,"-");process.stdout.write("com.claude-codex-loops."+b+"-"+h)' "$REPO_ROOT")"

# Config-derived interval + stateDir (loadConfig is the single source of truth).
CFG_JSON="$("$NODE_BIN" -e '
import("file://"+process.argv[2]+"/core/loop-config.mjs").then(m=>{
  const cfg=m.loadConfig(process.env);
  const interval=Math.max(60, cfg.intervalSeconds|0);
  process.stdout.write(JSON.stringify({interval, stateDir: cfg.stateDir}));
}).catch(e=>{process.stdout.write(JSON.stringify({interval:600, stateDir:".agent-loops"}));});
' -- "$PACK_ROOT")"
INTERVAL="$("$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).interval))' "$CFG_JSON")"
STATE_DIR="$("$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stateDir))' "$CFG_JSON")"

log "install: pack path (from repo root) = $REL_PACK"
log "install: launchd label             = $LABEL"
log "install: interval / stateDir       = ${INTERVAL}s / $STATE_DIR"

TS="$(date +%Y%m%d%H%M%S)"

# ── 2. config.example.json -> <repo>/.claude-codex-loops.json (never clobber) ──
CONFIG_DEST="$REPO_ROOT/.claude-codex-loops.json"
if [ -e "$CONFIG_DEST" ]; then
  log "install: config already present ($CONFIG_DEST) — left untouched"
else
  cp "$PACK_ROOT/config.example.json" "$CONFIG_DEST"
  log "install: wrote $CONFIG_DEST from config.example.json"
fi

# ── 3. append <stateDir>/ to .gitignore (grep-first) ──────────────────────────
GITIGNORE="$REPO_ROOT/.gitignore"
IGNORE_LINE="$STATE_DIR/"
if [ -f "$GITIGNORE" ] && grep -qxF "$IGNORE_LINE" "$GITIGNORE"; then
  log "install: .gitignore already ignores $IGNORE_LINE"
else
  printf '\n# claude-codex-loops per-clone loop state\n%s\n' "$IGNORE_LINE" >> "$GITIGNORE"
  log "install: appended $IGNORE_LINE to .gitignore"
fi

# ── 4. copy skills (hash-skip unchanged) ──────────────────────────────────────
if [ -n "$SKILLS_DIR_ARG" ]; then
  SKILLS_DEST="$SKILLS_DIR_ARG"
else
  SKILLS_DEST="$REPO_ROOT/.claude/skills"
fi
mkdir -p "$SKILLS_DEST"
# ALL FIVE skills ship + install: the two ping-pong wrappers, the PR skill, and
# the flagship general (/ccl-loop) + research (/research-loop) loops.
for skill in pingpong pingpong-pr pingpong-install ccl-loop research-loop; do
  SRC="$PACK_ROOT/skills/$skill"
  DST="$SKILLS_DEST/$skill"
  [ -d "$SRC" ] || continue
  mkdir -p "$DST"
  for f in "$SRC"/*; do
    base="$(basename "$f")"
    if [ -f "$DST/$base" ] && "$NODE_BIN" -e '
      const c=require("node:crypto"),fs=require("node:fs");
      const h=(p)=>c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      process.exit(h(process.argv[1])===h(process.argv[2])?0:1);
    ' "$f" "$DST/$base"; then
      : # identical — hash-skip
    else
      cp "$f" "$DST/$base"
      log "install: skill file $skill/$base copied"
    fi
  done
  # A copied skill .mjs resolves its two-up PACK_ROOT to <repo>/.claude, NOT the
  # pack, so drop a marker holding the ABSOLUTE installed pack dir. The skill
  # reads it (CCL_PACK_ROOT env > marker > two-up) so BIN()/core resolve to the
  # real pack. Written idempotently (only when the content would change).
  MARKER="$DST/.ccl-pack-root"
  if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER" 2>/dev/null)" != "$PACK_ROOT" ]; then
    printf '%s\n' "$PACK_ROOT" > "$MARKER"
    log "install: wrote pack-root marker $skill/.ccl-pack-root"
  fi
done
log "install: skills present under $SKILLS_DEST"

# ── 5. deep-merge hook fragments (node JSON merge, backup, printed diff) ───────
MERGE="$PACK_ROOT/schedule/merge-json.mjs"
merge_hook() {
  target="$1"; fragment="$2"
  if [ -f "$target" ]; then
    # Skip the backup when the target is ALREADY ccl-tagged: that means this is a
    # re-install and the on-disk file already contains our merge, so a backup of
    # it preserves nothing recoverable and just accumulates. Only back up a file
    # we are about to touch for the FIRST time (no _ccl marker yet). The backup
    # name carries the PID too, so two re-runs in the same clock-second can't
    # clobber each other's backup ($TS is second-granularity).
    if grep -qF '"_ccl"' "$target" 2>/dev/null; then
      log "install: $target already ccl-tagged — skipping backup (re-install)"
    else
      BAK="$target.bak.$TS.$$"
      cp "$target" "$BAK"
      log "install: backed up $target -> $BAK"
    fi
  fi
  "$NODE_BIN" "$MERGE" merge "$target" "$fragment" "$REL_PACK"
}
merge_hook "$REPO_ROOT/.claude/settings.json" "$PACK_ROOT/hooks/claude.settings.fragment.json"
merge_hook "$REPO_ROOT/.codex/hooks.json"     "$PACK_ROOT/hooks/codex.hooks.fragment.json"

# ── 6. append the marker-fenced AGENTS review-contract (grep-first) ───────────
AGENTS="$REPO_ROOT/AGENTS.md"
CONTRACT_SRC="$PACK_ROOT/codex/AGENTS.review-contract.md"
BEGIN_MARK="<!-- ccl:begin -->"
END_MARK="<!-- ccl:end -->"
if [ -f "$AGENTS" ] && grep -qF "$BEGIN_MARK" "$AGENTS"; then
  log "install: AGENTS.md already carries the ccl review-contract block — left as-is"
else
  # Extract the fenced block (inclusive) from the contract source and append it.
  "$NODE_BIN" -e '
    const fs=require("node:fs");
    const src=fs.readFileSync(process.argv[1],"utf8");
    const b=src.indexOf(process.argv[2]);
    const e=src.indexOf(process.argv[3]);
    if(b<0||e<0){console.error("install: contract markers not found in source");process.exit(2);}
    const block=src.slice(b, e+process.argv[3].length);
    const dest=process.argv[4];
    const prefix=fs.existsSync(dest)?fs.readFileSync(dest,"utf8"):"# AGENTS\n";
    const sep=prefix.endsWith("\n")?"\n":"\n\n";
    fs.writeFileSync(dest, prefix+sep+block+"\n","utf8");
  ' "$CONTRACT_SRC" "$BEGIN_MARK" "$END_MARK" "$AGENTS"
  log "install: appended the ccl review-contract block to AGENTS.md"
fi

# ── 7. render + load the launchd plist ────────────────────────────────────────
if [ "$DO_LAUNCHD" -eq 1 ]; then
  # The plist has RunAtLoad=true and points StandardOut/ErrorPath into the state
  # dir, so the FIRST tick fires the instant launchctl loads it. Create the state
  # dir up front — before rendering/loading — or that first tick's log writes land
  # in a directory that does not exist yet.
  mkdir -p "$REPO_ROOT/$STATE_DIR"
  LA_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LA_DIR"
  PLIST_DEST="$LA_DIR/$LABEL.plist"
  "$NODE_BIN" -e '
    const fs=require("node:fs");
    let t=fs.readFileSync(process.argv[1],"utf8");
    const sub={LABEL:process.argv[2],NODE_BIN:process.argv[3],PACK_ROOT:process.argv[4],REPO_ROOT:process.argv[5],INTERVAL:process.argv[6],STATE_DIR:process.argv[7]};
    for(const [k,v] of Object.entries(sub)){ t=t.split("{"+"{"+k+"}"+"}").join(v); }
    fs.writeFileSync(process.argv[8], t, "utf8");
  ' "$PACK_ROOT/schedule/launchd.plist.template" "$LABEL" "$NODE_ABS" "$PACK_ROOT" "$REPO_ROOT" "$INTERVAL" "$STATE_DIR" "$PLIST_DEST"
  log "install: rendered launchd plist -> $PLIST_DEST"
  if command -v launchctl >/dev/null 2>&1; then
    launchctl unload "$PLIST_DEST" >/dev/null 2>&1 || true
    if launchctl load "$PLIST_DEST" >/dev/null 2>&1; then
      log "install: launchd job loaded ($LABEL)"
    else
      warn "install: could not launchctl load $PLIST_DEST (load it manually, or re-run in a login session)"
    fi
  else
    warn "install: launchctl not found — plist written but not loaded"
  fi
else
  log "install: --no-launchd → skipped plist render/load"
fi

# ── 8. one smoke tick → assert claude-status.json produced ────────────────────
log "install: running one smoke tick…"
CCL_STATE_DIR="$STATE_DIR" "$NODE_BIN" "$PACK_ROOT/bin/loop-tick.mjs" --agent claude --repo "$REPO_ROOT" || true
# Build the status path with node path.join — the SAME way loop-tick.mjs derives
# it (join(repoRoot, stateDir, "bridge", "claude-status.json")) — so a trailing
# slash or other separator quirk in STATE_DIR can't make the installer assert a
# different path than the tick actually wrote.
STATUS_FILE="$("$NODE_BIN" -e 'const p=require("node:path");process.stdout.write(p.join(process.argv[1],process.argv[2],"bridge","claude-status.json"))' "$REPO_ROOT" "$STATE_DIR")"
if [ -f "$STATUS_FILE" ]; then
  log "install: smoke tick OK — $STATUS_FILE produced"
else
  die "smoke tick did not produce $STATUS_FILE"
fi

# ── 9. green summary ──────────────────────────────────────────────────────────
green "install: DONE"
log   "  • config:   $CONFIG_DEST"
log   "  • skills:   $SKILLS_DEST/{pingpong,pingpong-pr,pingpong-install,ccl-loop,research-loop}"
log   "  • hooks:    .claude/settings.json + .codex/hooks.json (ccl entries merged)"
log   "  • contract: AGENTS.md (ccl:begin/ccl:end block)"
if [ "$DO_LAUNCHD" -eq 1 ]; then
  log "  • schedule: launchd label $LABEL every ${INTERVAL}s"
fi
log   "  • state:    $REPO_ROOT/$STATE_DIR/"
log   ""
log   "Next: open a Claude session (SessionStart prints the loop status) and a Codex"
log   "session (it follows the AGENTS.md contract). Uninstall with ./uninstall.sh."
