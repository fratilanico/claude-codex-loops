// codex-pass core — PURE builders for driving the Codex peer headlessly.
//
// Encodes the three live-proven `codex exec` hang traps (FOR-AGENTS §4) as
// data, so every caller gets them by construction instead of by folklore:
//   1. stdin: "ignore" — a non-TTY never-closing stdin makes `codex exec`
//      print "Reading additional input from stdin..." and block forever
//      BEFORE creating a session (no rollout file, silent hang);
//   2. --dangerously-bypass-hook-trust — the pack's own installed
//      .codex/hooks.json triggers a trust prompt an unattended run can't answer;
//   3. --ignore-user-config — heavy user-level MCP servers stall exec startup
//      for minutes; repo AGENTS.md (the ccl contract) still loads.
// Pure module: no process, no fs, no spawn — the bin does the spawning.

/** The one-pass review prompt matching codex/AGENTS.review-contract.md. */
export function buildCodexPassPrompt({ confirm } = {}) {
  const base =
    "You are the Codex peer in the claude-codex-loops review ping-pong. " +
    "Execute exactly ONE review pass now, strictly per the 'Claude <-> Codex " +
    "review loop' contract in this repo's AGENTS.md (inside the ccl:begin/" +
    "ccl:end markers): (a) read the latest Claude packet under the pack state " +
    "dir and record its lastAckSha; (b) review ONLY git diff lastAckSha..HEAD; " +
    "(c) emit each finding as its own 'CCL-FINDING [HIGH] ...' or " +
    "'CCL-FINDING [NORMAL] ...' line, then exactly one 'CCL-EXIT <state>' " +
    "line last; (d) no secrets or absolute paths in findings. Then stop.";
  if (!confirm) return base;
  return (
    "You are the Codex peer in the claude-codex-loops review ping-pong, on a " +
    `follow-up confirmation pass. Your previous pass emitted: '${confirm}'. ` +
    "The Claude peer has since answered it. " +
    base.replace("Execute exactly ONE review pass now", "Execute exactly ONE review pass now, judging whether your prior finding is resolved (use 'converged' if the diff is clean and you agree with it)")
  );
}

/**
 * argv + stdio directive for `codex exec` with every safeguard baked in.
 * Returns { argv, stdin } — the bin spawns `codex` with argv and MUST wire
 * stdin per the directive (spawn stdio, not a shell redirect).
 */
export function buildCodexPassArgs(repoRoot, prompt) {
  return {
    argv: [
      "exec",
      "--ignore-user-config",
      "-s",
      "read-only",
      "-C",
      repoRoot,
      "--dangerously-bypass-hook-trust",
      prompt,
    ],
    stdin: "ignore",
  };
}
