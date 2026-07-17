import 'dotenv/config';

export interface Config {
  githubRepo: string;
  maxBudgetUsdPerIssue: number;
  maxBudgetUsdPerReview: number;
  maxReviewCycles: number;
  pollIntervalMs: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxRetryCount: number;
  maxParallelIssues: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? Number(value) : fallback;
}

/** Loads and validates harness configuration from environment variables (see .env.example). */
export function loadConfig(): Config {
  return {
    githubRepo: required('GITHUB_REPO'),
    maxBudgetUsdPerIssue: numberEnv('MAX_BUDGET_USD_PER_ISSUE', 2),
    maxBudgetUsdPerReview: numberEnv('MAX_BUDGET_USD_PER_REVIEW', 1),
    maxReviewCycles: numberEnv('MAX_REVIEW_CYCLES', 3),
    pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 60_000),
    baseRetryDelayMs: numberEnv('BASE_RETRY_DELAY_MS', 60_000),
    maxRetryDelayMs: numberEnv('MAX_RETRY_DELAY_MS', 3_600_000),
    maxRetryCount: numberEnv('MAX_RETRY_COUNT', 10),
    // Defaults to 1 (strictly sequential, identical to the harness's original behavior): the
    // launch budget for concurrent issues, each processed in its own git worktree (see
    // src/worktree.ts). Deliberately opt-in rather than on-by-default - see issue #15, which
    // explicitly cautions against building this out unless sequential throughput is a real
    // bottleneck.
    maxParallelIssues: numberEnv('MAX_PARALLEL_ISSUES', 1),
  };
}
