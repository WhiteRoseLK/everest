import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Resolve the `.env` path relative to this module's location, not `process.cwd()`. Since
// `everest` is installed via `npm link`, invoking it from a directory outside the project
// root (e.g. `cd ~ && everest`) would otherwise silently fail to find the project's `.env`
// (see issue #31).
const moduleDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(moduleDir, '..', '.env') });

export interface Config {
  githubRepo: string;
  maxBudgetUsdPerIssue: number;
  maxBudgetUsdPerReview: number;
  maxReviewCycles: number;
  pollIntervalMs: number;
  watchPollIntervalMs: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  maxRetryCount: number;
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
    watchPollIntervalMs: numberEnv('WATCH_POLL_INTERVAL_MS', 30_000),
    baseRetryDelayMs: numberEnv('BASE_RETRY_DELAY_MS', 60_000),
    maxRetryDelayMs: numberEnv('MAX_RETRY_DELAY_MS', 3_600_000),
    maxRetryCount: numberEnv('MAX_RETRY_COUNT', 10),
  };
}
