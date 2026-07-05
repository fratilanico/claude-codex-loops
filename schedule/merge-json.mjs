#!/usr/bin/env node
// merge-json — install/uninstall-time JSON DEEP-MERGE helper for the hook targets
// (<repo>/.claude/settings.json and <repo>/.codex/hooks.json).
//
// This is an INSTALLER helper, not a loop bin: it lives under schedule/ (outside
// bin/) so it is never part of the ferry runtime and is not subject to the
// model-free / exec-allowlist bin invariants. It touches JSON structurally with
// the real JSON parser — NEVER with sed — so a foreign hook entry is preserved
// byte-for-byte and the merge is idempotent.
//
// Usage:
//   node merge-json.mjs merge   <targetFile> <fragmentFile> <relPackPath>
//   node merge-json.mjs unmerge <targetFile>
//
// merge:   deep-merges every hook EVENT array from the fragment into the target.
//          Each fragment group is tagged `_ccl:true`. Before appending, ALL
//          existing `_ccl` groups for that event are removed, so a re-install is
//          a no-op (same content) and never accumulates duplicates. Foreign
//          (non-`_ccl`) groups are left exactly as-is. Command paths in the
//          fragment groups have their pack-relative prefix rewritten from the
//          shipped `./packages/claude-codex-loops/` to `<relPackPath>/` so the
//          command resolves from the consumer repo root wherever the pack sits.
//          The target file/dirs are created if absent. Prints a unified-ish diff
//          of the before/after JSON to stdout.
//
// unmerge: removes ONLY `_ccl`-tagged groups from every event array (and prunes
//          now-empty event arrays and an empty top-level `hooks`), leaving every
//          foreign entry untouched. Prints the diff.
//
// stdlib only (node:*).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SHIPPED_PREFIX = "./packages/claude-codex-loops/";

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    // A malformed target is a hard stop — we must never clobber a file we cannot
    // parse (that would risk destroying a foreign hook). Fail loudly.
    console.error(`merge-json: ${file} is not valid JSON — refusing to touch it (${e.message})`);
    process.exit(2);
  }
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// Rewrite the shipped pack-relative command prefix to the consumer-relative one.
function retargetCommand(command, relPackPath) {
  if (typeof command !== "string") return command;
  const wanted = relPackPath.endsWith("/") ? relPackPath : relPackPath + "/";
  return command.split(SHIPPED_PREFIX).join(wanted);
}

function retargetGroup(group, relPackPath) {
  const g = JSON.parse(JSON.stringify(group)); // deep clone
  g._ccl = true;
  if (Array.isArray(g.hooks)) {
    for (const h of g.hooks) {
      if (h && typeof h === "object" && "command" in h) {
        h.command = retargetCommand(h.command, relPackPath);
      }
    }
  }
  return g;
}

function ensureHooks(target) {
  if (!target.hooks || typeof target.hooks !== "object" || Array.isArray(target.hooks)) {
    target.hooks = {};
  }
  return target.hooks;
}

function stripCclGroups(arr) {
  return arr.filter((g) => !(g && typeof g === "object" && g._ccl === true));
}

function merge(targetFile, fragmentFile, relPackPath) {
  const before = existsSync(targetFile) ? readFileSync(targetFile, "utf8") : "";
  const target = readJson(targetFile, {});
  const fragment = readJson(fragmentFile, {});
  if (!fragment.hooks || typeof fragment.hooks !== "object") {
    console.error(`merge-json: fragment ${fragmentFile} has no hooks object`);
    process.exit(2);
  }

  const targetHooks = ensureHooks(target);
  for (const [event, groups] of Object.entries(fragment.hooks)) {
    if (!Array.isArray(groups)) continue;
    // A foreign, non-array value at this event (e.g. an object) is data we do not
    // understand and MUST NOT discard. Coercing it to [] would clobber it — the
    // exact failure this merge exists to prevent. Hard-stop instead (same posture
    // as a malformed target JSON: never touch a file we cannot safely merge).
    const current = targetHooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      // current is guaranteed non-array here (typeof reports object/string/etc).
      console.error(
        `merge-json: ${targetFile} hooks.${event} is a ${current === null ? "null" : typeof current}, not an array — refusing to overwrite it`
      );
      process.exit(2);
    }
    const existing = Array.isArray(current) ? current : [];
    // Drop our previous ccl groups (idempotency), keep every foreign group.
    const foreign = stripCclGroups(existing);
    const fresh = groups.map((g) => retargetGroup(g, relPackPath));
    targetHooks[event] = [...foreign, ...fresh];
  }

  mkdirSync(dirname(targetFile), { recursive: true });
  const after = serialize(target);
  writeFileSync(targetFile, after, "utf8");
  printDiff(targetFile, before, after);
}

function unmerge(targetFile) {
  if (!existsSync(targetFile)) {
    console.log(`merge-json: ${targetFile} absent — nothing to unmerge`);
    return;
  }
  const before = readFileSync(targetFile, "utf8");
  const target = readJson(targetFile, {});
  if (target.hooks && typeof target.hooks === "object" && !Array.isArray(target.hooks)) {
    for (const [event, groups] of Object.entries(target.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = stripCclGroups(groups);
      if (kept.length === 0) delete target.hooks[event];
      else target.hooks[event] = kept;
    }
    if (Object.keys(target.hooks).length === 0) delete target.hooks;
  }
  const after = serialize(target);
  writeFileSync(targetFile, after, "utf8");
  printDiff(targetFile, before, after);
}

// Minimal line-level diff (added/removed) so the installer can print what changed
// without shelling to `diff`.
function printDiff(file, before, after) {
  if (before === after) {
    console.log(`  (no change) ${file}`);
    return;
  }
  const b = before.split("\n");
  const a = after.split("\n");
  const bSet = new Set(b);
  const aSet = new Set(a);
  const removed = b.filter((l) => !aSet.has(l) && l.trim());
  const added = a.filter((l) => !bSet.has(l) && l.trim());
  console.log(`  changed ${file}:`);
  for (const l of removed.slice(0, 12)) console.log(`    - ${l.trim()}`);
  for (const l of added.slice(0, 12)) console.log(`    + ${l.trim()}`);
}

function main() {
  const [mode, targetFile, fragmentFile, relPackPath] = process.argv.slice(2);
  if (mode === "merge") {
    if (!targetFile || !fragmentFile || !relPackPath) {
      console.error("merge-json: usage — merge <targetFile> <fragmentFile> <relPackPath>");
      process.exit(2);
    }
    merge(targetFile, fragmentFile, relPackPath);
    return;
  }
  if (mode === "unmerge") {
    if (!targetFile) {
      console.error("merge-json: usage — unmerge <targetFile>");
      process.exit(2);
    }
    unmerge(targetFile);
    return;
  }
  console.error(`merge-json: unknown mode '${mode}' (expected merge|unmerge)`);
  process.exit(2);
}

main();
