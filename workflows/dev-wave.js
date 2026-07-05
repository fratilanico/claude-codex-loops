// dev-wave — one bounded maker/checker build rung: TDD-red → implement → verify
// → 3-lens adversarial review → report.
//
// HARNESS-ONLY EXECUTION: this file is evaluated by the Claude Code Workflow
// harness, which supplies the globals agent()/parallel()/phase() and the `args`
// binding. It uses those globals — NOT node stdlib — and is NOT runnable under
// bare `npm test`. Its ONLY automated coverage is the CONTRACT test
// (__tests__/workflow-contract.test.ts): it parses this file as ESM text and
// asserts the required phases/config keys are present and that it imports
// nothing outside node:* + the harness globals. Do not import it in a unit test.
//
// MAKER/CHECKER SEPARATION: the maker legs (TDD-red, Implement) and the checker
// legs (Verify, Review) run as separate agents. This workflow NEVER commits and
// NEVER mutates live/production systems — the invoking session owns commits.
//
// Config (all optional, read from env / an injected `args.config` object; every
// key has a neutral default here):
//   checks           — array of check commands run in Verify; DEFAULT
//                      ['npx vitest run', 'npx tsc --noEmit']
//   lenses           — array of review-lens prompts; DEFAULT the three generic
//                      lenses below (safety-guard / silent-failure / correctness)
//   models.implementHard / models.implementStd / models.review — model labels
//                      (no keys); routed by args.difficulty
//   review.safetyLens — override for the generic safety lens wording

export const meta = {
  name: 'dev-wave',
  description: 'One DEV-WAVE rung: TDD-red → implement (by difficulty) → verify → 3-lens adversarial review → report. Maker/checker separated; never commits.',
  whenToUse: 'Every non-trivial build rung. The orchestrator plans, passes a goal spec via args, and judges the result — this workflow runs the maker/checker legs.',
  phases: [
    { title: 'TDD-red', detail: 'author failing tests first' },
    { title: 'Implement', detail: 'hard → implementHard model, standard → implementStd model' },
    { title: 'Verify', detail: 'run the named checks, capture real output' },
    { title: 'Review', detail: 'adversarial 3-lens (safety-guard, silent-failure, correctness)' },
  ],
}

// args = { goal, worktree, difficulty: 'hard'|'standard', files: [...], checks: [...],
//          constraints: [...], config: {...} }  — supplied by the orchestrator per rung.
// Some invocation paths deliver args as a JSON string — normalize before validating.
let a = args
if (typeof a === 'string') { try { a = JSON.parse(a) } catch { /* fall through to the guard */ } }
if (!a || !a.goal || !a.worktree) throw new Error(`dev-wave needs args {goal, worktree, ...} — got ${typeof args}: ${JSON.stringify(args)?.slice(0, 120)}`)

// ── config resolution (harness-safe: no static import; env + injected object) ─
const cfg = (a && typeof a.config === 'object' && a.config) || {}
const env = (typeof process !== 'undefined' && process.env) || {}
const IMPL_HARD = { model: a.models?.implementHard || env.CCL_IMPL_HARD_MODEL || cfg.models?.implementHard || 'opus', effort: 'max' }
const IMPL_STD = { model: a.models?.implementStd || env.CCL_IMPL_STD_MODEL || cfg.models?.implementStd || 'sonnet' }
const REVIEW_MODEL = a.models?.review || env.CCL_REVIEW_MODEL || cfg.models?.review || 'opus'
const impl = a.difficulty === 'hard' ? IMPL_HARD : IMPL_STD

const ctx = [
  `Worktree (work ONLY here): ${a.worktree}`,
  `Goal: ${a.goal}`,
  a.files?.length ? `Files in scope: ${a.files.join(', ')}` : '',
  a.constraints?.length ? `Hard constraints: ${a.constraints.join(' · ')}` : '',
  'Never commit. Never mutate live/production systems. No provider SDKs or API keys in application code.',
].filter(Boolean).join('\n')

phase('TDD-red')
const red = await agent(
  `${ctx}\n\nWrite the FAILING tests for this goal first (matching repo test conventions). Run them, confirm they fail for the right reason, and return: test file paths + the exact failing assertion summary. Do NOT implement the fix.`,
  { label: 'tdd-red', ...IMPL_STD, phase: 'TDD-red' },
)

phase('Implement')
const built = await agent(
  `${ctx}\n\nTDD-red state from the previous stage:\n${red}\n\nImplement the minimal correct change to turn these tests green. Match surrounding code style. Run the tests + \`npx tsc --noEmit\`. Return: files changed, test counts, tsc status, anything you flagged.`,
  { label: `implement:${impl.model}`, ...impl, phase: 'Implement' },
)

phase('Verify')
const checks = (a.checks?.length ? a.checks : (cfg.checks?.length ? cfg.checks : ['npx vitest run', 'npx tsc --noEmit']))
const verified = await agent(
  `Worktree: ${a.worktree}\nImplementation report:\n${built}\n\nRun each named check and report PASS/FAIL with the real tail of each output (no summarizing a failure away):\n${checks.map((c) => `- ${c}`).join('\n')}`,
  { label: 'verify', ...IMPL_STD, phase: 'Verify' },
)

phase('Review')
// GENERIC adversarial lenses — no vertical/product specifics. The safety lens
// asks whether the change could weaken ANY guard or authorization/emergency
// path; override review.safetyLens in config for a domain-specific phrasing.
const SAFETY_LENS = a.review?.safetyLens || env.CCL_SAFETY_LENS || cfg.review?.safetyLens
  || 'safety-guard (could this weaken any authorization check, emergency/abort path, input validation, or other safety guard?)'
const LENSES = (a.lenses?.length ? a.lenses : (cfg.lenses?.length ? cfg.lenses : [
  SAFETY_LENS,
  'silent-failure (swallowed errors, partial-apply, fail-open paths?)',
  'correctness (does the diff actually satisfy the goal + tests pin behavior?)',
]))
const reviews = await parallel(LENSES.map((lens) => () =>
  agent(
    `Adversarially review the UNCOMMITTED diff in ${a.worktree} (git diff + untracked) through ONE lens: ${lens}. Goal was: ${a.goal}. Try to REFUTE that the change is safe/correct. Report findings HIGH/MED/LOW with file:line, or 'CLEAN'. Read-only.`,
    { label: `review:${String(lens).split(' ')[0]}`, model: REVIEW_MODEL, effort: 'high', phase: 'Review' },
  )))

return { red, built, verified, reviews: reviews.filter(Boolean) }
