import { spawnSync } from 'node:child_process';
import { currentCommit, setGitIdentity } from './github.js';
import { memorySection } from './prompt.js';
import { recordCost } from './cost.js';

export interface ClaudeResult {
  success: boolean;
  rateLimited: boolean;
  errorSummary?: string;
  totalCostUsd?: number;
}

interface ClaudeJsonOutput {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
}

interface AgentIdentity {
  name: string;
  email: string;
}

/**
 * Git author identity per subagent role, so commits and (where supported) API actions are
 * attributed to the agent that made them instead of a single shared "harness" identity.
 */
const AGENT_IDENTITIES: Record<string, AgentIdentity> = {
  'issue-worker': { name: 'everest-issue-worker', email: 'issue-worker@everest.local' },
  'code-reviewer': { name: 'everest-code-reviewer', email: 'code-reviewer@everest.local' },
};

/**
 * Substrings that, when found (case-insensitively) in the subtype/errors/stderr of a
 * `claude -p` invocation, indicate it was cut short by a usage/rate limit.
 *
 * Kept as a standalone list (rather than inlined) so new plausible formats can be added
 * without touching the matching logic itself.
 */
const RATE_LIMIT_PATTERNS = [
  'rate_limit',
  'rate limit',
  'usage_limit',
  'usage limit',
  '429',
  'too many requests',
];

/**
 * Detects whether a `claude -p` invocation was cut short by hitting a usage/rate limit.
 *
 * Isolated on purpose: the exact subtype/message used by `claude -p` to signal
 * a rate limit is not officially documented. If it changes, only this
 * function needs updating.
 */
export function isRateLimitError(parsed: ClaudeJsonOutput | undefined, stderr: string): boolean {
  const haystack = `${parsed?.subtype ?? ''} ${(parsed?.errors ?? []).join(' ')} ${
    parsed?.result ?? ''
  } ${stderr}`.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Gates whether `isRateLimitError` should even be consulted. It scans `result` (the agent's
 * free-text summary) alongside `subtype`/`errors`/`stderr`, so calling it on a *successful* run
 * risks a false positive if the summary happens to mention rate limits or "429" - exactly what
 * happened when code-reviewer analyzed this repo's own rate-limit-detection code and its own
 * summary triggered the heuristic. Only a run that already errored should be checked.
 */
export function shouldCheckRateLimit(parsed: ClaudeJsonOutput | undefined): boolean {
  return !parsed || parsed.is_error;
}

/**
 * Runs a named subagent (defined in `.claude/agents/`) headlessly, after setting the git
 * identity matching that agent. Returns whether it completed without error or hit a rate limit;
 * callers add their own success criteria on top (e.g. "did it produce a commit"). `label`
 * identifies what this invocation was for (e.g. an issue number or branch) and is only used to
 * tag the recorded cost entry (see `recordCost`).
 */
async function runAgent(
  agentName: string,
  prompt: string,
  cwd: string,
  maxBudgetUsd: number,
  label: string,
): Promise<ClaudeResult> {
  const identity = AGENT_IDENTITIES[agentName];
  await setGitIdentity(identity.name, identity.email, cwd);

  // maxTurns lives in .claude/agents/<agentName>.md, but permissionMode
  // there is NOT honored when the agent is the top-level session (only when
  // it's spawned as a subagent from within another session) - confirmed by
  // a debug run where every write/Bash call was denied despite the agent
  // definition declaring bypassPermissions. --permission-mode must be passed
  // explicitly here. bypassPermissions is required, not just acceptEdits:
  // acceptEdits only auto-approves file edits, but Bash (needed for `npm
  // test` and `git commit`) still gets silently denied in headless mode with
  // no one to approve it. This is only safe because the harness runs inside
  // the Docker sandbox (see Dockerfile).
  const proc = spawnSync(
    'claude',
    [
      '-p',
      prompt,
      '--agent',
      agentName,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'json',
      '--max-budget-usd',
      String(maxBudgetUsd),
    ],
    { cwd, encoding: 'utf-8' },
  );

  let parsed: ClaudeJsonOutput | undefined;
  try {
    parsed = JSON.parse(proc.stdout) as ClaudeJsonOutput;
  } catch {
    parsed = undefined;
  }

  // Recorded regardless of success/failure/rate-limit: even a failed or rate-limited attempt
  // can consume tokens, and this log is the measurement issue #13 requires before considering
  // a context-compression tool like Headroom - it must reflect actual total spend.
  if (typeof parsed?.total_cost_usd === 'number') {
    recordCost(
      {
        timestamp: new Date().toISOString(),
        agent: agentName,
        label,
        totalCostUsd: parsed.total_cost_usd,
      },
      cwd,
    );
  }

  if (shouldCheckRateLimit(parsed)) {
    if (isRateLimitError(parsed, proc.stderr ?? '')) {
      return { success: false, rateLimited: true, totalCostUsd: parsed?.total_cost_usd };
    }

    // The rate-limit heuristic in isRateLimitError() is undocumented and can miss real
    // rate-limit responses in a format it doesn't recognize yet. Logging the raw output here
    // makes it possible to spot those misses after the fact and extend RATE_LIMIT_PATTERNS.
    if (parsed?.is_error) {
      console.error('claude -p returned is_error=true but was not classified as rate-limited:');
      console.error(JSON.stringify(parsed));
      if (proc.stderr) console.error(`stderr: ${proc.stderr}`);
    }

    return {
      success: false,
      rateLimited: false,
      errorSummary: parsed?.errors?.join('; ') ?? proc.stderr ?? 'unknown error',
      totalCostUsd: parsed?.total_cost_usd,
    };
  }

  return { success: true, rateLimited: false, totalCostUsd: parsed?.total_cost_usd };
}

/**
 * Runs the `issue-worker` subagent against one issue prompt and reports whether it produced a
 * new commit, hit a rate limit, or failed outright. `label` tags the recorded cost entry (see
 * `recordCost`) - callers typically pass something identifying the issue, e.g. `issue-#42`.
 */
export async function runClaudeCode(
  prompt: string,
  cwd: string,
  maxBudgetUsd: number,
  label: string,
): Promise<ClaudeResult> {
  const commitBefore = await currentCommit(cwd);

  const result = await runAgent('issue-worker', prompt, cwd, maxBudgetUsd, label);
  if (!result.success) return result;

  const commitAfter = await currentCommit(cwd);
  const hasNewCommit = commitAfter !== commitBefore;

  return {
    success: hasNewCommit,
    rateLimited: false,
    errorSummary: hasNewCommit ? undefined : 'no new commit produced',
    totalCostUsd: result.totalCostUsd,
  };
}

/**
 * Runs the `code-reviewer` subagent against a PR branch. The agent posts its findings as a PR
 * review comment itself (see .claude/agents/code-reviewer.md) - this just reports whether the
 * review ran successfully, it never approves or merges on the harness's behalf.
 */
export async function runCodeReview(
  branch: string,
  cwd: string,
  maxBudgetUsd: number,
): Promise<ClaudeResult> {
  const prompt = `Review the open pull request for branch "${branch}" and post your findings as a PR review comment.${memorySection(cwd)}`;
  return runAgent('code-reviewer', prompt, cwd, maxBudgetUsd, `code-reviewer:${branch}`);
}
