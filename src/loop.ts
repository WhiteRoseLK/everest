import type { Config } from './config.js';
import {
  listOpenIssues,
  branchNameFor,
  checkoutMain,
  createBranch,
  checkoutBranch,
  pushBranch,
  openPullRequest,
  commentOnIssue,
  hasOpenPullRequest,
  getReviewDecision,
  getPullRequestState,
  findResumablePullRequest,
  markPullRequestNeedsHuman,
  type Issue,
} from './github.js';
import { runClaudeCode, runCodeReview, type ClaudeResult } from './claude.js';
import { saveState, loadState, clearState, type HarnessState } from './state.js';
import { buildPrompt, buildFixupPrompt } from './prompt.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Priority tiers, ranked from most to least urgent. An issue's rank is the lowest (most urgent)
 * index among the priority labels it carries. Issues without any of these labels fall back to
 * the `priority:medium` rank, matching the old behavior where unlabeled issues sat below
 * `priority:high` in FIFO order.
 */
const PRIORITY_TIERS = ['priority:critical', 'priority:high', 'priority:medium', 'priority:low'];

const DEFAULT_PRIORITY_RANK = PRIORITY_TIERS.indexOf('priority:medium');

/** Returns the priority rank of an issue (lower is more urgent); see {@link PRIORITY_TIERS}. */
function priorityRank(issue: Issue): number {
  const ranks = issue.labels
    .map((label) => PRIORITY_TIERS.indexOf(label))
    .filter((rank) => rank !== -1);
  return ranks.length > 0 ? Math.min(...ranks) : DEFAULT_PRIORITY_RANK;
}

/**
 * Selects the next issue to process: issues are ordered by priority tier (see
 * {@link PRIORITY_TIERS}, most urgent first), then oldest first (FIFO) within each tier.
 */
export function pickNextIssue(issues: Issue[]): Issue | null {
  if (issues.length === 0) return null;
  return [...issues].sort((a, b) => {
    const aPriority = priorityRank(a);
    const bPriority = priorityRank(b);
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
 * Runs code-reviewer against the branch. code-reviewer merges directly once it decides a PR is
 * ready (see .claude/agents/code-reviewer.md - it can't formally --approve its own PR, so it
 * merges instead of relying on a review decision). If it requests changes instead, this
 * re-invokes issue-worker with the feedback and re-reviews - repeating until merged or
 * `maxReviewCycles` is reached (a launch budget, so a stuck disagreement can't loop forever).
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

    const prState = await getPullRequestState(config.githubRepo, branch);
    if (prState === 'MERGED') {
      console.log(`PR for issue #${issue.number} merged by code-reviewer`);
      return;
    }

    const decision = await getReviewDecision(config.githubRepo, branch);
    if (decision !== 'CHANGES_REQUESTED') {
      console.log(
        `PR for issue #${issue.number} not merged yet (state: ${prState}, decision: ${decision ?? 'none'})`,
      );
      return;
    }

    console.log(
      `Review cycle ${cycle + 1}/${config.maxReviewCycles}: changes requested for issue #${issue.number}, re-invoking issue-worker`,
    );
    const fixup = await runClaudeCode(
      buildFixupPrompt(branch, cwd),
      cwd,
      config.maxBudgetUsdPerIssue,
      `issue-#${issue.number}-fixup`,
    );
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
    await checkoutMain(cwd);
    await createBranch(branch, cwd);
    saveState(
      { issueNumber: issue.number, branch, startedAt: new Date().toISOString(), retryCount },
      cwd,
    );
  }

  const result: ClaudeResult = await runClaudeCode(
    buildPrompt(issue, cwd),
    cwd,
    config.maxBudgetUsdPerIssue,
    `issue-#${issue.number}`,
  );

  if (result.rateLimited) {
    retryCount += 1;

    if (retryCount > config.maxRetryCount) {
      console.log(
        `Issue #${issue.number} hit the rate-limit retry cap (${config.maxRetryCount}), giving up`,
      );
      await commentOnIssue(
        config.githubRepo,
        issue,
        `Le harnais a atteint la limite de ${config.maxRetryCount} tentatives après rate-limit sans succès — intervention humaine nécessaire.`,
      );
      clearState(cwd);
      return;
    }

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

/**
 * Runs one iteration's worth of work: resume in-progress state, resume a pending review, or
 * pick up a new issue. Split out from {@link runLoop} so a single iteration's logic can be
 * wrapped in error isolation without nesting the whole poll loop inside a try/catch.
 */
async function runIteration(config: Config, cwd: string): Promise<void> {
  const state = loadState(cwd);

  if (state) {
    const issues = await listOpenIssues(config.githubRepo);
    const issue = issues.find((candidate) => candidate.number === state.issueNumber) ?? null;
    if (!issue) {
      await sleep(config.pollIntervalMs);
      return;
    }
    await handleIssue(issue, state, config, cwd);
    return;
  }

  if (await resumePendingReview(config, cwd)) return;

  const issues = await listOpenIssues(config.githubRepo);
  const candidates = await filterOutIssuesWithOpenPr(issues, config.githubRepo);
  const issue: Issue | null = pickNextIssue(candidates);

  if (!issue) {
    await sleep(config.pollIntervalMs);
    return;
  }

  await handleIssue(issue, state, config, cwd);
}

/** Runs the harness loop: poll for the next issue, process it, repeat, for `iterations` cycles. */
export async function runLoop(config: Config, cwd: string, iterations = Infinity): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    // A single iteration failing (an unexpected git/gh error, a crashed subprocess, ...) must
    // never take down the whole process - that turns one bad issue into total downtime instead
    // of one skipped cycle. Seen in practice: a stale local branch from a budget-exhausted
    // attempt made the next `git checkout -b` throw, killing the container.
    try {
      await runIteration(config, cwd);
    } catch (error) {
      console.error('Unhandled error during loop iteration, continuing after a short delay:');
      console.error(error);
      await sleep(config.pollIntervalMs);
    }
  }
}
