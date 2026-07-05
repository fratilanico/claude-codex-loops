// classifyCollectRound — decide what a pr-review-triage Collect reply means.
//
// The Collect agent is asked for STRICT JSON describing every untriaged bot
// finding. Three outcomes must be told apart:
//   1. collect-parse-error — the reply is not a usable plan (bad model output,
//      an API error surfaced as prose, a truncated/empty reply, or the literal
//      `null`). This is a COLLECTOR FAILURE and must NOT be reported as quiet:
//      doing so silently masks real findings that were never triaged.
//   2. quiet — a VALID parsed plan with no untriaged findings. Genuinely
//      nothing to do this round.
//   3. work — a valid parsed plan with at least one untriaged finding.
//
// A sentinel object is used (not `null` as fallback) so a parsed literal
// `null` — which JSON.parse accepts but is not a plan — is classified as a
// parse failure, not a quiet round. (PR #183 regression guard.)
import { parseAgentJSON } from './parse-agent-json.mjs'

const PARSE_FAILED = Symbol('parse-failed')

export function classifyCollectRound(collected) {
  const raw = String(collected)
  const plan = parseAgentJSON(collected, PARSE_FAILED)

  // Not a usable object (parse threw, or parsed to null/primitive/array).
  if (plan === PARSE_FAILED || plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    return { quiet: false, error: 'collect-parse-error', raw }
  }

  const hasUntriaged = Array.isArray(plan.prs) && plan.prs.some((p) => p?.untriaged?.length)
  if (!hasUntriaged) {
    return { quiet: true, raw }
  }

  return { quiet: false, plan }
}
