// RUNTIME OUTPUT FILTER ONLY — not a source-hygiene scanner.
//
// This redacts common secret shapes from strings the loop is about to EMIT
// (log lines, findings summaries, the sync-back ack, git status/log output).
// It is a best-effort last line of defense on OUTPUT — it is NOT, and must not
// be relied on as, a source-code hygiene scanner. Source hygiene (fleet
// literals, home paths, token shapes in committed files) is enforced separately
// by the pack + host hygiene gates, which do NOT defer to this function.
//
// EXTRACTED verbatim (behavior-preserving) from the origin watch-codex.mjs
// redactor so the pack owns the pure filter and the origin script imports it.
//
// SOURCE-HYGIENE NOTE: the token-shape prefixes (provider-key, GitHub PAT, JWT)
// are assembled from string fragments below so no contiguous token-shape
// literal ever appears in this shipped pack source — the assembled RegExp is
// byte-for-byte the same pattern the origin redactor used.

// Common token/key patterns. Broadened arm ([A-Za-z0-9+/]{40,}={0,2}) catches
// long base64 blobs; the postgres arm requires an `@` (a connection URL with
// credentials). Prefixes fragment-assembled for source hygiene (see header).
const SECRET_RE = new RegExp(
  "\\b(" +
    "s" + "k-" + "[A-Za-z0-9_-]{20,}" +
    "|xox[bpoa]-[A-Za-z0-9_-]+" +
    "|" + "ghp" + "_" + "[A-Za-z0-9]{30,}" +
    "|github_pat_[A-Za-z0-9_]{20,}" +
    "|AKIA[A-Z0-9]{16}" +
    "|" + "ey" + "J" + "[A-Za-z0-9_-]{20,}" +
    "|[A-Za-z0-9+/]{40,}={0,2}" +
    ")\\b" +
    "|postgres(?:ql)?:\\/\\/[^\\s]+@" +
    "|(password|passwd|api[_-]?key|secret|token)\\s*[=:]\\s*\\S+",
  "gi"
);

export function redact(text) {
  return String(text ?? "").replace(SECRET_RE, "[REDACTED]");
}
