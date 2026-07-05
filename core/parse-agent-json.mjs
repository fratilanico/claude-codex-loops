// parseAgentJSON — tolerant JSON parse for agent replies.
//
// Agents are asked for STRICT JSON but frequently wrap it in a ```json fenced
// block and/or add trailing whitespace/newlines. This helper strips an
// optional opening ```json / ``` fence and an optional closing ``` fence
// (tolerating trailing whitespace after it), trims surrounding whitespace,
// then JSON.parses. On any failure it returns `fallback` instead of throwing.
//
// Extracted from pr-review-triage.js where the same fence-strip + parse ran in
// three places (collect / triage / re-gate).
export function parseAgentJSON(raw, fallback) {
  const cleaned = String(raw)
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '') // opening fence, optional "json"
    .replace(/\n?```\s*$/, '')          // closing fence + any trailing space
    .trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return fallback
  }
}
