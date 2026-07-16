import type { Config } from './config.js';
import {
  listOpenIssues,
  branchNameFor,
  createBranch,
  checkoutBranch,
  pushBranch,
  openPullRequest,
  commentOnIssue,
  hasOpenPullRequest,
  getReviewDecision,
  findResumablePullRequest,
  markPullRequestNeedsHuman,
  type Issue,
} from './github.js';
import { runClaudeCode, runCodeReview, type ClaudeResult } from './claude.js';
import { saveState, loadState, clearState, type HarnessState } from './state.js';
import { buildPrompt, buildFixupPrompt } from './prompt.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HIGH_PRIORITY_LABEL = 'priority:high';

/**
 * Selects the next issue to process: issues labeled `priority:high` come first,
 * regardless of creation date. Within each priority tier, issues are ordered
 * oldest first (FIFO).
 */
export function pickNextIssue(issues: Issue[]): Issue | null {
  if (issues.length === 0) return null;
  return [...issues].sort((a, b) => {
    const aPriority = a.labels.includes(HIGH_PRIORITY_LABEL) ? 0 : 1;
    const bPriority = b.labels.includes(HIGH_PRIORITY_LABEL) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  })[0];
}

/**
 * Excludes issues that already have an open PR against their harness branch. An issue stays
 * "open" on GitHub until its PR merges, so without this the loop would retry it forever and
 * collide with the branch it already created.
 */
async function filterOutIssuesWithOpenPr(issues: Issue[], repo: string): Promise<Issue[]> {
  const flags = await Promise.all(
    issues.map((issue) => hasOpenPullRequest(repo, branchNameFor(issue))),
  );
  return issues.filter((_, index) => !flags[index]);
}

/**
 * Runs code-reviewer against the branch and, if it requests changes, re-invokes issue-worker
 * with the review feedback and re-reviews - repeating until approved or `maxReviewCycles` is
 * reached (a launch budget, so a stuck disagreement can't loop forever).
 */
async function runReviewLoop(
  issue: Issue,
  branch: string,
  config: Config,
  cwd: string,
): Promise<void> {
  for (let cycle = 0; cycle < config.maxReviewCycles; cycle += 1) {
    const review = await runCodeReview(branch, cwd, config.maxBudgetUsdPerReview);
    if (!review.success) {
      console.log(`Code review failed for issue #${issue.number}: ${review.errorSummary}`);
      return;
    }

    const decision = await getReviewDecision(config.githubRepo, branch);
    if (decision !== 'CHANGES_REQUESTED') {
      console.log(`PR for issue #${issue.number} review decision: ${decision ?? 'none'}`);
      return;
    }

    console.log(
      `Review cycle ${cycle + 1}/${config.maxReviewCycles}: changes requested for issue #${issue.number}, re-invoking issue-worker`,
    );
    const fixup = await runClaudeCode(buildFixupPrompt(branch), cwd, config.maxBudgetUsdPerIssue);
    if (!fixup.success) {
      console.log(`Fixup attempt failed for issue #${issue.number}: ${fixup.errorSummary}`);
      return;
    }
    await pushBranch(branch, cwd);
  }

  await commentOnIssue(
    config.githubRepo,
    issue,
    `Le harnais a atteint la limite de ${config.maxReviewCycles} cycles de review sans approbation — intervention humaine nécessaire.`,
  );
  await markPullRequestNeedsHuman(config.githubRepo, branch);
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

    await runReviewLoop(issue, branch, config, cwd);
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

/**
 * Resumes the review loop on an already-open harness PR left with `CHANGES_REQUESTED`, e.g.
 * because the harness stopped between opening the PR and it getting approved. Returns whether
 * a PR was found and resumed, so the caller can skip picking a new issue this iteration.
 */
async function resumePendingReview(config: Config, cwd: string): Promise<boolean> {
  const resumable = await findResumablePullRequest(config.githubRepo);
  if (!resumable) return false;

  const issues = await listOpenIssues(config.githubRepo);
  const issue = issues.find((candidate) => candidate.number === resumable.issueNumber) ?? null;
  if (!issue) return false;

  console.log(`Resuming review loop for issue #${issue.number} on branch ${resumable.branch}`);
  await checkoutBranch(resumable.branch, cwd);
  await runReviewLoop(issue, resumable.branch, config, cwd);
  return true;
}

/** Runs the harness loop: poll for the next issue, process it, repeat, for `iterations` cycles. */
export async function runLoop(config: Config, cwd: string, iterations = Infinity): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    const state = loadState(cwd);

    if (state) {
      const issues = await listOpenIssues(config.githubRepo);
      const issue = issues.find((candidate) => candidate.number === state.issueNumber) ?? null;
      if (!issue) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      await handleIssue(issue, state, config, cwd);
      continue;
    }

    if (await resumePendingReview(config, cwd)) continue;

    const issues = await listOpenIssues(config.githubRepo);
    const candidates = await filterOutIssuesWithOpenPr(issues, config.githubRepo);
    const issue: Issue | null = pickNextIssue(candidates);

    if (!issue) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    await handleIssue(issue, state, config, cwd);
  }
}
