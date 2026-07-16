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

// Isolated on purpose: the exact subtype/message used by `claude -p` to signal
// a rate limit is not officially documented. If it changes, only this
// function needs updating.
export function isRateLimitError(parsed: ClaudeJsonOutput | undefined, stderr: string): boolean {
  const haystack = `${parsed?.subtype ?? ''} ${(parsed?.errors ?? []).join(' ')} ${stderr}`.toLowerCase();
  return haystack.includes('rate_limit') || haystack.includes('usage_limit') || haystack.includes('usage limit');
}

export async function runClaudeCode(
  prompt: string,
  cwd: string,
  maxBudgetUsd: number,
): Promise<ClaudeResult> {
  const commitBefore = await currentCommit(cwd);

  // permissionMode and maxTurns live in .claude/agents/issue-worker.md
  // (versioned, reviewable) rather than as CLI flags here. bypassPermissions
  // is required there, not just acceptEdits: acceptEdits only auto-approves
  // file edits, but Bash (needed for `npm test` and `git commit`) still gets
  // silently denied in headless mode with no one to approve it. This is only
  // safe because the harness runs inside the Docker sandbox (see Dockerfile).
  const proc = spawnSync('claude', [
    '-p', prompt,
    '--agent', 'issue-worker',
    '--output-format', 'json',
    '--max-budget-usd', String(maxBudgetUsd),
  ], { cwd, encoding: 'utf-8' });

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

  return { success: hasNewCommit, rateLimited: false, errorSummary: hasNewCommit ? undefined : 'no new commit produced' };
}
