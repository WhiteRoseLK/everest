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
  pushRetryCount: number;
  pushRetryDelayMs: number;
  dashboardPort: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  // `Number('')` is 0 and whitespace-only strings also coerce to 0, but any other non-numeric
  // value (typo, stray text) yields `NaN`, which would otherwise propagate silently into things
  // like `setTimeout` delays or budget comparisons that always evaluate to `false` (issue #86).
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid value for env var ${name}: ${JSON.stringify(value)} is not a number`);
  }
  return parsed;
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
    // A `git push` failure is often transient transport noise (a flaky server-side hook, a
    // momentary network blip) rather than a sign the commit itself is wrong - retrying the push
    // directly a few times is far cheaper than falling back to a whole fresh issue-worker sprint,
    // which would just find the working tree already correct and nothing new to commit (see
    // issue #59).
    pushRetryCount: numberEnv('PUSH_RETRY_COUNT', 3),
    pushRetryDelayMs: numberEnv('PUSH_RETRY_DELAY_MS', 5_000),
    // Port for the read-only status dashboard (see src/dashboard.ts, issue #65). Started
    // alongside the loop by src/index.ts and published by docker-compose.yml so it's reachable
    // from the host without needing a shell in the container.
    dashboardPort: numberEnv('DASHBOARD_PORT', 3000),
  };
}
