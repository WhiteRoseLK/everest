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
  getPullRequestState,
  getPullRequestLabels,
  NEEDS_FIXUP_LABEL,
  NEEDS_HUMAN_LABEL,
  findResumablePullRequest,
  markPullRequestNeedsHuman,
  markIssueNeedsHuman,
  commitWorkInProgress,
  remoteMainCommit,
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
 * Excludes issues already labeled {@link NEEDS_HUMAN_LABEL}. Applied once the harness has given up
 * on an issue (see `markIssueNeedsHuman` calls throughout this file): without it, an issue that
 * never got as far as opening a PR stayed invisible to {@link filterOutIssuesWithOpenPr} and got
 * re-picked on every poll, burning a full sprint per cycle for no benefit until a human intervenes
 * - see issue #60. A plain in-memory filter, not an extra API call: {@link listOpenIssues} already
 * returns each issue's labels.
 */
function filterOutIssuesNeedingHuman(issues: Issue[]): Issue[] {
  return issues.filter((issue) => !issue.labels.includes(NEEDS_HUMAN_LABEL));
}

/**
 * Runs code-reviewer against the branch. code-reviewer merges directly once it decides a PR is
 * ready (see .claude/agents/code-reviewer.md - it can't formally --approve its own PR, so it
 * merges instead). If it's not ready, code-reviewer applies {@link NEEDS_FIXUP_LABEL} (not
 * `gh pr review --request-changes`, which also fails on your own PR); this re-invokes
 * issue-worker with the feedback and re-reviews - repeating until merged or `maxReviewCycles`
 * is reached (a launch budget, so a stuck disagreement can't loop forever).
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

    const labels = await getPullRequestLabels(config.githubRepo, branch);
    if (!labels.includes(NEEDS_FIXUP_LABEL)) {
      console.log(
        `PR for issue #${issue.number} not merged yet (state: ${prState}, no fixup requested)`,
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

    try {
      await pushBranch(branch, cwd);
    } catch (error) {
      // Unlike the budget-exceeded checkpoint push (which retries with a fresh sprint - see
      // retryFreshSprintOrGiveUp), a PR already exists here and the fixup commit is already in
      // place locally: retrying the sprint would redo already-finished work for no benefit if the
      // push failure is persistent (e.g. issue #54 - a missing `workflow` OAuth scope rejects any
      // push touching `.github/workflows/*` on every attempt). Escalate straight away instead of
      // silently looping: left unguarded, this throw used to propagate out of runReviewLoop and
      // get swallowed by runLoop's per-iteration try/catch, leaving state.json untouched so the
      // next iteration retried the whole sprint from scratch, forever, without ever commenting or
      // labeling the PR.
      console.error(`Failed to push fixup for issue #${issue.number}:`, error);
      await commentOnIssue(
        config.githubRepo,
        issue,
        `Le harnais n'a pas pu pousser les corrections de review (échec de push répété) — intervention humaine nécessaire.`,
      );
      await markPullRequestNeedsHuman(config.githubRepo, branch);
      await markIssueNeedsHuman(config.githubRepo, issue);
      return;
    }
  }

  await commentOnIssue(
    config.githubRepo,
    issue,
    `Le harnais a atteint la limite de ${config.maxReviewCycles} cycles de review sans approbation — intervention humaine nécessaire.`,
  );
  await markPullRequestNeedsHuman(config.githubRepo, branch);
  await markIssueNeedsHuman(config.githubRepo, issue);
}

/**
 * Saves a bumped `retryCount` for another fresh sprint on the same branch, or gives up (comments
 * on the issue and clears state) once `maxRetryCount` is exceeded. Shared by the budget-exceeded
 * fallback paths (nothing to checkpoint, or the checkpoint push itself failed) and the
 * finished-work push failure in {@link handleIssue}, so a stuck issue can't retry forever
 * regardless of which failure mode recurs.
 */
async function retryFreshSprintOrGiveUp(
  issue: Issue,
  branch: string,
  config: Config,
  cwd: string,
  retryCount: number,
  reason: string,
): Promise<void> {
  const nextRetryCount = retryCount + 1;

  if (nextRetryCount > config.maxRetryCount) {
    console.log(
      `Issue #${issue.number} ${reason} across ${config.maxRetryCount} sprints, giving up`,
    );
    await commentOnIssue(
      config.githubRepo,
      issue,
      `Le harnais a atteint la limite de ${config.maxRetryCount} tentatives sans produire de travail exploitable — intervention humaine nécessaire.`,
    );
    await markIssueNeedsHuman(config.githubRepo, issue);
    clearState(cwd);
    return;
  }

  saveState(
    {
      issueNumber: issue.number,
      branch,
      startedAt: new Date().toISOString(),
      retryCount: nextRetryCount,
    },
    cwd,
  );
  console.log(
    `Issue #${issue.number} sprint ${nextRetryCount}: ${reason}, retrying with a fresh sprint`,
  );
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
      await markIssueNeedsHuman(config.githubRepo, issue);
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

  if (result.budgetExceeded) {
    // The per-invocation budget is a guardrail on the subagent's sprint, not a verdict on the
    // issue: checkpoint whatever exists and let the review loop (already built for exactly this
    // "not done yet" situation) decide whether to continue, rather than abandoning the issue.
    const committed = await commitWorkInProgress(
      cwd,
      `WIP checkpoint: issue #${issue.number} (budget reached)`,
    );

    if (!committed) {
      await retryFreshSprintOrGiveUp(
        issue,
        branch,
        config,
        cwd,
        retryCount,
        'hit its budget with nothing to checkpoint',
      );
      return;
    }

    console.log(
      `Issue #${issue.number} hit its per-sprint budget; checkpointed progress, handing off to review`,
    );

    try {
      // --no-verify: this is an admittedly-incomplete checkpoint, not finished agent work - it
      // must bypass the repo's own Husky pre-push (lint+test), which it would likely fail.
      await pushBranch(branch, cwd, { noVerify: true });
    } catch (error) {
      console.error(`Failed to push WIP checkpoint for issue #${issue.number}:`, error);
      await retryFreshSprintOrGiveUp(
        issue,
        branch,
        config,
        cwd,
        retryCount,
        'failed to push its WIP checkpoint',
      );
      return;
    }

    if (!(await hasOpenPullRequest(config.githubRepo, branch))) {
      await openPullRequest(config.githubRepo, issue, branch, cwd);
      console.log(`Opened WIP PR for issue #${issue.number}`);
    }
    await runReviewLoop(issue, branch, config, cwd);
  } else if (result.success) {
    try {
      await pushBranch(branch, cwd);
    } catch (error) {
      // Same reasoning as the WIP checkpoint push a few lines up: a push failure here (e.g. issue
      // #54 - a missing `workflow` OAuth scope rejects any push touching `.github/workflows/*`)
      // used to propagate unguarded out of handleIssue, get swallowed by runLoop's per-iteration
      // try/catch, and leave state.json untouched. The branch's local commit survived, so the
      // next sprint saw nothing new to commit, commented "no new commit produced", cleared state,
      // and the loop picked the same issue again from scratch - forever, without ever hitting
      // maxRetryCount or posting needs-human. Routing through retryFreshSprintOrGiveUp bounds the
      // retries and escalates like every other push-failure path.
      console.error(`Failed to push branch for issue #${issue.number}:`, error);
      await retryFreshSprintOrGiveUp(
        issue,
        branch,
        config,
        cwd,
        retryCount,
        'failed to push its finished work',
      );
      return;
    }
    await openPullRequest(config.githubRepo, issue, branch, cwd);
    console.log(`Opened PR for issue #${issue.number}`);

    await runReviewLoop(issue, branch, config, cwd);
  } else {
    // Bounded by maxRetryCount via retryFreshSprintOrGiveUp instead of unconditionally
    // commenting and clearing state on every single failure: this branch also covers
    // "no new commit produced" (see runClaudeCode in claude.ts), which the agent can hit
    // repeatedly on the same issue (e.g. it keeps exploring without ever committing). Clearing
    // state unconditionally here reset retryCount to 0 every time, so the loop re-picked the
    // same issue, recreated the branch from scratch, and repeated the same "no new commit
    // produced" comment forever without ever reaching maxRetryCount or giving up - see issue
    // #57 (a recurrence of the same class of bug as #54's push-failure case).
    console.log(`Failed to process issue #${issue.number}: ${result.errorSummary}`);
    await retryFreshSprintOrGiveUp(
      issue,
      branch,
      config,
      cwd,
      retryCount,
      `failed to process (${result.errorSummary})`,
    );
    return;
  }

  clearState(cwd);
}

/**
 * Resumes the review loop on an already-open harness PR labeled {@link NEEDS_FIXUP_LABEL}, e.g.
 * because the harness stopped between opening the PR and it getting merged. Returns whether
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
  const withoutOpenPr = await filterOutIssuesWithOpenPr(issues, config.githubRepo);
  const candidates = filterOutIssuesNeedingHuman(withoutOpenPr);
  const issue: Issue | null = pickNextIssue(candidates);

  if (!issue) {
    await sleep(config.pollIntervalMs);
    return;
  }

  await handleIssue(issue, state, config, cwd);
}

/**
 * Checks whether `origin/main` has advanced past `startupMainCommit` and, if so, exits the
 * process via `exitProcess` (real usage: `process.exit`, injected as a mock in tests). The
 * harness never reloads its own modules mid-run - Node's ESM loader caches each module the
 * first time it's imported, so `git pull` alone (already done by {@link checkoutMain} on every
 * new issue) updates the files on disk but not the code actually executing in memory. Left
 * unaddressed, a merge produced by code-reviewer (including one fixing a bug in the harness
 * itself) would silently keep running under the old, buggy code indefinitely - see issue #43,
 * where this happened in practice with the fix from #39. Exiting relies on the container's
 * restart policy (`restart: unless-stopped` in docker-compose.yml) to relaunch `npm start` with
 * the merged code from the bind-mounted source tree. No in-flight progress is lost: an issue's
 * state lives in `.harness/state.json` (see state.ts), on disk rather than in process memory, so
 * the next process picks up exactly where this one left off.
 */
async function restartIfMainAdvanced(
  cwd: string,
  startupMainCommit: string,
  exitProcess: (code: number) => void,
): Promise<boolean> {
  const latest = await remoteMainCommit(cwd);
  if (latest === startupMainCommit) return false;
  console.log(
    `origin/main advanced from ${startupMainCommit} to ${latest}; exiting so the container can restart with fresh code`,
  );
  exitProcess(0);
  return true;
}

/**
 * Fetches `origin/main`'s current commit, logging a warning instead of throwing if it fails (a
 * transient network blip, e.g. right as the container comes up). Callers treat `null` as "not
 * captured yet" and retry on a later iteration rather than giving up for the process's whole
 * lifetime - see {@link runLoop}.
 */
async function tryCaptureMainCommit(cwd: string): Promise<string | null> {
  return remoteMainCommit(cwd).catch((error: unknown) => {
    console.error(
      'Failed to fetch origin/main to capture the startup commit; self-restart detection stays disabled until this succeeds:',
      error,
    );
    return null;
  });
}

/** Runs the harness loop: poll for the next issue, process it, repeat, for `iterations` cycles. */
export async function runLoop(
  config: Config,
  cwd: string,
  iterations = Infinity,
  exitProcess: (code: number) => void = process.exit,
): Promise<void> {
  // Captured once per process, not per iteration: this is "the code currently loaded in memory",
  // which only changes when the process itself restarts - see restartIfMainAdvanced. If the
  // initial fetch fails, it's retried lazily below on subsequent iterations rather than left
  // permanently null - otherwise a transient blip at boot would silently disable the self-restart
  // safety net for the process's whole lifetime, reintroducing the exact bug this loop exists to
  // fix.
  let startupMainCommit = await tryCaptureMainCommit(cwd);

  for (let i = 0; i < iterations; i += 1) {
    // A single iteration failing (an unexpected git/gh error, a crashed subprocess, ...) must
    // never take down the whole process - that turns one bad issue into total downtime instead
    // of one skipped cycle. Seen in practice: a stale local branch from a budget-exhausted
    // attempt made the next `git checkout -b` throw, killing the container.
    try {
      if (startupMainCommit === null) {
        startupMainCommit = await tryCaptureMainCommit(cwd);
      }
      if (startupMainCommit && (await restartIfMainAdvanced(cwd, startupMainCommit, exitProcess))) {
        return;
      }
      await runIteration(config, cwd);
    } catch (error) {
      console.error('Unhandled error during loop iteration, continuing after a short delay:');
      console.error(error);
      await sleep(config.pollIntervalMs);
    }
  }
}
