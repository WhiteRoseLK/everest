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
  isMissingWorkflowScopeError,
  hasUnpushedCommit,
  isUnpushedCommitWipCheckpoint,
  createReviewClone,
  removeReviewClone,
  WIP_CHECKPOINT_PREFIX,
  type Issue,
} from './github.js';
import { runClaudeCode, runCodeReview, type ClaudeResult } from './claude.js';
import { saveState, loadState, clearState, type HarnessState } from './state.js';
import { buildPrompt, buildFixupPrompt } from './prompt.js';
import { recordIterationError } from './diagnostics.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A simple counting semaphore, used by {@link ReviewScheduler} to cap how many review/fixup
 * loops run concurrently (`config.maxConcurrentReviews`) - each one spawns its own `claude -p`
 * subprocess, so this is a resource/cost guardrail, not just a scheduling detail.
 */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available += 1;
  }
}

/**
 * Runs review/fixup loops in the background, decoupled from dev work (issue #96): before this,
 * `handleIssue` awaited `runReviewLoop` inline, so a PR stuck in review (possibly several fixup
 * cycles) blocked the whole harness from even looking at the next issue. `schedule` fires a review
 * off in its own throwaway clone (see `createReviewClone` in github.ts, needed because `claude -p`
 * invocations now run via async `spawn` instead of blocking `spawnSync` - see claude.ts - so a
 * concurrent dev sprint in `mainCwd` and a review in its clone can genuinely interleave) and
 * returns immediately; `waitForIdle` lets `runLoop` drain outstanding reviews before it returns
 * (tests) or before the process restarts (`restartIfMainAdvanced`), so in-flight review work isn't
 * silently dropped whenever avoidable.
 */
interface ReviewScheduler {
  schedule(issue: Issue, branch: string): void;
  waitForIdle(): Promise<void>;
}

/** Creates a {@link ReviewScheduler} bounded by `config.maxConcurrentReviews`. */
function createReviewScheduler(config: Config, mainCwd: string): ReviewScheduler {
  const active = new Map<string, Promise<void>>();
  const semaphore = new Semaphore(Math.max(1, config.maxConcurrentReviews));

  function schedule(issue: Issue, branch: string): void {
    if (active.has(branch)) return;

    const task = (async () => {
      await semaphore.acquire();
      let clonePath: string | null = null;
      try {
        clonePath = await createReviewClone(mainCwd, branch);
        await runReviewLoop(issue, branch, config, clonePath);
      } catch (error) {
        console.error(
          `Review task for issue #${issue.number} (branch ${branch}) failed unexpectedly:`,
          error,
        );
      } finally {
        if (clonePath) await removeReviewClone(clonePath);
        semaphore.release();
      }
    })().finally(() => {
      active.delete(branch);
    });

    active.set(branch, task);
  }

  async function waitForIdle(): Promise<void> {
    await Promise.allSettled([...active.values()]);
  }

  return { schedule, waitForIdle };
}

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
 * Builds the comment posted when a push fails specifically because `GH_TOKEN` lacks the OAuth
 * `workflow` scope (see {@link isMissingWorkflowScopeError} in github.ts / issue #55). Shared by
 * every push-failure catch below so the actionable ask (regenerate the token with the scope
 * added) is worded consistently regardless of which push failed.
 */
function missingWorkflowScopeMessage(): string {
  return (
    "Le push a été rejeté car `GH_TOKEN` n'a pas le scope OAuth `workflow` (nécessaire pour " +
    'toute branche touchant `.github/workflows/*`) — intervention humaine nécessaire pour ' +
    'régénérer le token avec ce scope (voir #55).'
  );
}

/**
 * Escalates straight to needs-human when a push failed specifically due to a missing `workflow`
 * OAuth scope, instead of routing through {@link retryFreshSprintOrGiveUp}'s bounded-retry
 * mechanism: unlike a transient failure, this rejection is deterministic - it fails identically
 * on every retry - so retrying would just burn up to `maxRetryCount` sprints on a push that can
 * never succeed until a human regenerates the token (see issue #55). No PR exists yet at either
 * call site (both catches sit before {@link openPullRequest}), so only the issue itself is
 * labeled and commented on.
 */
async function escalateMissingWorkflowScope(
  issue: Issue,
  config: Config,
  cwd: string,
): Promise<void> {
  console.log(
    `Issue #${issue.number}: push rejected for missing 'workflow' OAuth scope on GH_TOKEN, escalating immediately instead of retrying (issue #55)`,
  );
  await commentOnIssue(config.githubRepo, issue, missingWorkflowScopeMessage());
  await markIssueNeedsHuman(config.githubRepo, issue);
  clearState(cwd);
}

/**
 * Retries {@link pushBranch} directly, up to `config.pushRetryCount` attempts with
 * `config.pushRetryDelayMs` between them, before giving up. A push failure is often transient
 * transport noise (a flaky server-side hook, a momentary network blip) or a root cause that's
 * since been fixed (e.g. issue #55's missing `workflow` scope, once a human regenerates the
 * token) - in both cases the commit already sitting locally is correct and complete, so retrying
 * the push itself is far cheaper than falling back to a whole fresh issue-worker sprint, which
 * would just find the working tree already clean and report "no new commit produced" (see issue
 * #59). Stops immediately without spending remaining attempts when the failure is
 * {@link isMissingWorkflowScopeError}: that one fails identically on every retry, so burning the
 * local retry budget on it too would only delay the (already-immediate) needs-human escalation.
 */
async function pushBranchWithRetries(
  branch: string,
  cwd: string,
  config: Config,
  options: { noVerify?: boolean } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= config.pushRetryCount; attempt += 1) {
    try {
      await pushBranch(branch, cwd, options);
      return;
    } catch (error) {
      if (isMissingWorkflowScopeError(error) || attempt === config.pushRetryCount) throw error;
      console.log(
        `Push attempt ${attempt}/${config.pushRetryCount} failed for branch ${branch}, retrying push directly in ${config.pushRetryDelayMs}ms before falling back to a fresh sprint`,
      );
      await sleep(config.pushRetryDelayMs);
    }
  }
}

/**
 * Runs code-reviewer against the branch. code-reviewer merges directly once it decides a PR is
 * ready (see .claude/agents/code-reviewer.md - it can't formally --approve its own PR, so it
 * merges instead). If it's not ready, code-reviewer applies {@link NEEDS_FIXUP_LABEL} (not
 * `gh pr review --request-changes`, which also fails on your own PR); this re-invokes
 * issue-worker with the feedback and re-reviews - repeating until merged or `maxReviewCycles`
 * is reached (a launch budget, so a stuck disagreement can't loop forever). `cwd` is a dedicated
 * clone of the branch (see {@link createReviewClone}), not the main harness checkout - callers
 * run this in the background via a {@link ReviewScheduler} so it never blocks dev work on other
 * issues (issue #96).
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
      await pushBranchWithRetries(branch, cwd, config);
    } catch (error) {
      // pushBranchWithRetries already retried the push directly config.pushRetryCount times
      // (issue #59) before this catch is reached. Unlike the budget-exceeded checkpoint push
      // (which retries with a fresh sprint - see retryFreshSprintOrGiveUp), a PR already exists
      // here and the fixup commit is already in place locally: re-invoking a whole sprint would
      // redo already-finished work for no benefit if the push failure is persistent (e.g. issue
      // #54 - a missing `workflow` OAuth scope rejects any push touching `.github/workflows/*` on
      // every attempt). Escalate straight away instead of silently looping: left unguarded, this
      // throw used to propagate out of runReviewLoop and get swallowed by runLoop's per-iteration
      // try/catch, leaving state.json untouched so the next iteration retried the whole sprint
      // from scratch, forever, without ever commenting or labeling the PR.
      console.error(`Failed to push fixup for issue #${issue.number}:`, error);
      const message = isMissingWorkflowScopeError(error)
        ? missingWorkflowScopeMessage()
        : `Le harnais n'a pas pu pousser les corrections de review (échec de push répété) — intervention humaine nécessaire.`;
      await commentOnIssue(config.githubRepo, issue, message);
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
  scheduler: ReviewScheduler,
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

  if (await hasUnpushedCommit(branch, cwd)) {
    // A prior sprint on this branch already produced a commit, but its push failed (see the
    // pushBranchWithRetries call sites below - this is what leaves state.json pointing at a
    // branch in exactly this state). That commit is still correct/complete, it's just stuck
    // locally: re-invoking issue-worker here would find nothing left to do and report "no new
    // commit produced" for work that was actually already finished, burning a whole sprint and a
    // unit of retryCount on what's really just a push problem, not an agent problem (issue #61).
    // Retry the push directly instead. --no-verify only if the stuck commit is a WIP checkpoint
    // (see commitWorkInProgress) - a finished agent commit should still go through the normal
    // lint/test pre-push hook, same as it would on its first push attempt.
    const noVerify = await isUnpushedCommitWipCheckpoint(cwd);
    console.log(
      `Issue #${issue.number}: branch ${branch} already has an unpushed commit from a prior sprint, retrying its push instead of re-invoking issue-worker`,
    );

    try {
      await pushBranchWithRetries(branch, cwd, config, { noVerify });
    } catch (error) {
      console.error(`Failed to push previously committed work for issue #${issue.number}:`, error);
      if (isMissingWorkflowScopeError(error)) {
        await escalateMissingWorkflowScope(issue, config, cwd);
        return;
      }
      await retryFreshSprintOrGiveUp(
        issue,
        branch,
        config,
        cwd,
        retryCount,
        'failed to push a previously committed but unpushed commit',
      );
      return;
    }

    if (!(await hasOpenPullRequest(config.githubRepo, branch))) {
      await openPullRequest(config.githubRepo, issue, branch, cwd);
      console.log(`Opened PR for issue #${issue.number}`);
    }
    // Dev's work here is done: clear state and hand the branch off to a backgrounded review
    // (issue #96) instead of blocking on the whole review/fixup loop before this call returns -
    // that used to keep the harness from even looking at the next issue until this one merged.
    clearState(cwd);
    scheduler.schedule(issue, branch);
    return;
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
      `${WIP_CHECKPOINT_PREFIX} issue #${issue.number} (budget reached)`,
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
      await pushBranchWithRetries(branch, cwd, config, { noVerify: true });
    } catch (error) {
      console.error(`Failed to push WIP checkpoint for issue #${issue.number}:`, error);
      if (isMissingWorkflowScopeError(error)) {
        await escalateMissingWorkflowScope(issue, config, cwd);
        return;
      }
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
    clearState(cwd);
    scheduler.schedule(issue, branch);
    return;
  } else if (result.success) {
    try {
      await pushBranchWithRetries(branch, cwd, config);
    } catch (error) {
      // pushBranchWithRetries already retried the push directly config.pushRetryCount times
      // (issue #59) - what's left below is what to do once even that's exhausted. Same reasoning
      // as the WIP checkpoint push a few lines up: a push failure here used to propagate unguarded
      // out of handleIssue, get swallowed by runLoop's per-iteration try/catch, and leave
      // state.json untouched. The branch's local commit survived, so the next sprint saw nothing
      // new to commit, commented "no new commit produced", cleared state, and the loop picked the
      // same issue again from scratch - forever, without ever hitting maxRetryCount or posting
      // needs-human (issue #54). Routing through retryFreshSprintOrGiveUp bounds the retries and
      // escalates like every other push-failure path - except when it's a missing `workflow`
      // OAuth scope rejecting a push touching `.github/workflows/*` (issue #55): that fails
      // identically on every retry, so it skips the bounded-retry dance entirely and escalates
      // immediately instead (see isMissingWorkflowScopeError/escalateMissingWorkflowScope).
      console.error(`Failed to push branch for issue #${issue.number}:`, error);
      if (isMissingWorkflowScopeError(error)) {
        await escalateMissingWorkflowScope(issue, config, cwd);
        return;
      }
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

    clearState(cwd);
    scheduler.schedule(issue, branch);
    return;
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
}

/**
 * Resumes the review loop on an already-open harness PR labeled {@link NEEDS_FIXUP_LABEL}, e.g.
 * because the harness stopped between opening the PR and it getting merged. Scheduling is
 * idempotent (see `ReviewScheduler.schedule`) and non-blocking, so this can safely be called on
 * every iteration instead of only when no other work is happening (issue #96).
 */
async function resumePendingReview(
  config: Config,
  cwd: string,
  scheduler: ReviewScheduler,
): Promise<void> {
  const resumable = await findResumablePullRequest(config.githubRepo);
  if (!resumable) return;

  const issues = await listOpenIssues(config.githubRepo);
  const issue = issues.find((candidate) => candidate.number === resumable.issueNumber) ?? null;
  if (!issue) return;

  console.log(`Resuming review loop for issue #${issue.number} on branch ${resumable.branch}`);
  scheduler.schedule(issue, resumable.branch);
}

/**
 * Runs one iteration's worth of work: resume in-progress state, resume a pending review, or
 * pick up a new issue. Split out from {@link runLoop} so a single iteration's logic can be
 * wrapped in error isolation without nesting the whole poll loop inside a try/catch.
 */
async function runIteration(config: Config, cwd: string, scheduler: ReviewScheduler): Promise<void> {
  const state = loadState(cwd);

  if (state) {
    const issues = await listOpenIssues(config.githubRepo);
    const issue = issues.find((candidate) => candidate.number === state.issueNumber) ?? null;
    if (!issue) {
      // The in-progress issue is no longer open (closed by hand, or its PR merged and the issue
      // auto-closed while state.json still pointed at it). Leaving the stale checkpoint in place
      // made this branch fire every poll forever - `issue` stays null, so the loop just slept and
      // returned without ever clearing state or looking at any *other* eligible issue: the whole
      // loop was alive but permanently stuck on a ghost issue, invisible from the outside (issue
      // #82). Clear the dead checkpoint and fall through to normal issue selection instead.
      console.log(
        `Issue #${state.issueNumber} in state.json is no longer open; clearing stale checkpoint and resuming normal selection`,
      );
      clearState(cwd);
    } else {
      await handleIssue(issue, state, config, cwd, scheduler);
      return;
    }
  }

  // Non-blocking (issue #96): a review already in flight is a no-op here, and a newly-found one
  // is scheduled in the background - either way this never delays picking up the next issue.
  await resumePendingReview(config, cwd, scheduler);

  const issues = await listOpenIssues(config.githubRepo);
  const withoutOpenPr = await filterOutIssuesWithOpenPr(issues, config.githubRepo);
  const candidates = filterOutIssuesNeedingHuman(withoutOpenPr);
  const issue: Issue | null = pickNextIssue(candidates);

  if (!issue) {
    await sleep(config.pollIntervalMs);
    return;
  }

  await handleIssue(issue, state, config, cwd, scheduler);
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
 * the merged code from the bind-mounted source tree. Dev progress is never lost: an issue's state
 * lives in `.harness/state.json` (see state.ts), on disk rather than in process memory. Review
 * progress (backgrounded since issue #96) has no local checkpoint, only the PR's GitHub labels -
 * so `scheduler.waitForIdle()` is awaited first, giving any in-flight review/fixup cycle a chance
 * to reach a stable, resumable state before the process exits, rather than risking an abrupt kill
 * mid-review.
 */
async function restartIfMainAdvanced(
  cwd: string,
  startupMainCommit: string,
  exitProcess: (code: number) => void,
  scheduler: ReviewScheduler,
): Promise<boolean> {
  const latest = await remoteMainCommit(cwd);
  if (latest === startupMainCommit) return false;
  console.log(
    `origin/main advanced from ${startupMainCommit} to ${latest}; draining in-flight reviews before exiting so the container can restart with fresh code`,
  );
  await scheduler.waitForIdle();
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
  // Decouples dev from review (issue #96): review/fixup loops run in the background through this
  // scheduler instead of blocking handleIssue, so the poll loop below can move on to the next
  // issue's dev work immediately after opening/updating a PR.
  const scheduler = createReviewScheduler(config, cwd);

  for (let i = 0; i < iterations; i += 1) {
    // A single iteration failing (an unexpected git/gh error, a crashed subprocess, ...) must
    // never take down the whole process - that turns one bad issue into total downtime instead
    // of one skipped cycle. Seen in practice: a stale local branch from a budget-exhausted
    // attempt made the next `git checkout -b` throw, killing the container.
    try {
      if (startupMainCommit === null) {
        startupMainCommit = await tryCaptureMainCommit(cwd);
      }
      if (
        startupMainCommit &&
        (await restartIfMainAdvanced(cwd, startupMainCommit, exitProcess, scheduler))
      ) {
        return;
      }
      await runIteration(config, cwd, scheduler);
    } catch (error) {
      console.error('Unhandled error during loop iteration, continuing after a short delay:');
      console.error(error);
      // Also persist it under .harness/ (best-effort): the container's stdout isn't reachable
      // once the harness is pid 1, so a console.error alone is invisible from `everest chat`.
      // This durable trace is what makes a silent-stall episode diagnosable after the fact via
      // `everest doctor`, without needing docker access (issue #82).
      recordIterationError(error, cwd);
      await sleep(config.pollIntervalMs);
    }
  }

  // Bounded test runs (and, in principle, a graceful process shutdown) wait for any background
  // review work scheduled during the loop to settle, so the final on-disk/GitHub state reflects
  // everything the run actually did instead of leaving it dangling in an unawaited promise.
  await scheduler.waitForIdle();
}
