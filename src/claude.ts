import { spawnSync } from 'node:child_process';
import { currentCommit } from './github.js';

export interface ClaudeResult {
  success: boolean;
  rateLimited: boolean;
  errorSummary?: string;
}

interface ClaudeJsonOutput {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
}

/**
 * Detects whether a `claude -p` invocation was cut short by hitting a usage/rate limit.
 *
 * Isolated on purpose: the exact subtype/message used by `claude -p` to signal
 * a rate limit is not officially documented. If it changes, only this
 * function needs updating.
 */
export function isRateLimitError(parsed: ClaudeJsonOutput | undefined, stderr: string): boolean {
  const haystack =
    `${parsed?.subtype ?? ''} ${(parsed?.errors ?? []).join(' ')} ${stderr}`.toLowerCase();
  return (
    haystack.includes('rate_limit') ||
    haystack.includes('usage_limit') ||
    haystack.includes('usage limit')
  );
}

/**
 * Runs the `issue-worker` subagent headlessly against one issue prompt and reports
 * whether it produced a new commit, hit a rate limit, or failed outright.
 */
export async function runClaudeCode(
  prompt: string,
  cwd: string,
  maxBudgetUsd: number,
): Promise<ClaudeResult> {
  const commitBefore = await currentCommit(cwd);

  // maxTurns lives in .claude/agents/issue-worker.md, but permissionMode
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
      'issue-worker',
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

  if (isRateLimitError(parsed, proc.stderr ?? '')) {
    return { success: false, rateLimited: true };
  }

  if (!parsed || parsed.is_error) {
    return {
      success: false,
      rateLimited: false,
      errorSummary: parsed?.errors?.join('; ') ?? proc.stderr ?? 'unknown error',
    };
  }

  const commitAfter = await currentCommit(cwd);
  const hasNewCommit = commitAfter !== commitBefore;

  return {
    success: hasNewCommit,
    rateLimited: false,
    errorSummary: hasNewCommit ? undefined : 'no new commit produced',
  };
}
