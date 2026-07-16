import type { Config } from './config.js';
import {
  listOpenIssues,
  branchNameFor,
  createBranch,
  checkoutBranch,
  pushBranch,
  openPullRequest,
  commentOnIssue,
  type Issue,
} from './github.js';
import { runClaudeCode, type ClaudeResult } from './claude.js';
import { saveState, loadState, clearState, type HarnessState } from './state.js';
import { buildPrompt } from './prompt.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Selects the next issue to process: oldest first (FIFO). */
export function pickNextIssue(issues: Issue[]): Issue | null {
  if (issues.length === 0) return null;
  return [...issues].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
}

async function handleIssue(
  issue: Issue,
  state: HarnessState | null,
  config: Config,
  cwd: string,
): Promise<void> {
  let branch: string;
  let retryCount: number;

  if (state && state.issueNumber === issue.number) {
    branch = state.branch;
    retryCount = state.retryCount;
    await checkoutBranch(branch, cwd);
  } else {
    branch = branchNameFor(issue);
    retryCount = 0;
    await createBranch(branch, cwd);
    saveState(
      { issueNumber: issue.number, branch, startedAt: new Date().toISOString(), retryCount },
      cwd,
    );
  }

  const result: ClaudeResult = await runClaudeCode(
    buildPrompt(issue),
    cwd,
    config.maxBudgetUsdPerIssue,
  );

  if (result.rateLimited) {
    retryCount += 1;
    const delay = Math.min(config.baseRetryDelayMs * 2 ** retryCount, config.maxRetryDelayMs);
    saveState(
      { issueNumber: issue.number, branch, startedAt: new Date().toISOString(), retryCount },
      cwd,
    );
    console.log(`Rate limited on issue #${issue.number}, retrying in ${delay}ms`);
    await sleep(delay);
    return;
  }

  if (result.success) {
    await pushBranch(branch, cwd);
    await openPullRequest(config.githubRepo, issue, branch, cwd);
    console.log(`Opened PR for issue #${issue.number}`);
  } else {
    await commentOnIssue(
      config.githubRepo,
      issue,
      `Le harnais n'a pas pu traiter cette issue automatiquement : ${result.errorSummary}`,
    );
    console.log(`Failed to process issue #${issue.number}: ${result.errorSummary}`);
  }

  clearState(cwd);
}

/** Runs the harness loop: poll for the next issue, process it, repeat, for `iterations` cycles. */
export async function runLoop(config: Config, cwd: string, iterations = Infinity): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    const state = loadState(cwd);

    let issue: Issue | null;
    if (state) {
      const issues = await listOpenIssues(config.githubRepo);
      issue = issues.find((candidate) => candidate.number === state.issueNumber) ?? null;
    } else {
      const issues = await listOpenIssues(config.githubRepo);
      issue = pickNextIssue(issues);
    }

    if (!issue) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    await handleIssue(issue, state, config, cwd);
  }
}
