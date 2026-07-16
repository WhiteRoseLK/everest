import 'dotenv/config';

export interface Config {
  githubRepo: string;
  maxBudgetUsdPerIssue: number;
  pollIntervalMs: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
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
    pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 60_000),
    baseRetryDelayMs: numberEnv('BASE_RETRY_DELAY_MS', 60_000),
    maxRetryDelayMs: numberEnv('MAX_RETRY_DELAY_MS', 3_600_000),
  };
}
