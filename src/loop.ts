import { join } from 'node:path';
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
  createRemoteMainCommitCache,
  isMissingWorkflowScopeError,
  hasUnpushedCommit,
  isUnpushedCommitWipCheckpoint,
  WIP_CHECKPOINT_PREFIX,
  type Issue,
  type RemoteMainCommitCache,
} from './github.js';
import { runClaudeCode, runCodeReview, type ClaudeResult } from './claude.js';
import { saveState, loadState, clearState, type HarnessState } from './state.js';
import { buildPrompt, buildFixupPrompt } from './prompt.js';
import { recordIterationError, checkGitWritable, checkHarnessWritable } from './diagnostics.js';

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
      // A failed/budget-exhausted review invocation used to be a dead end: logged to the
      // container's stdout (invisible outside `docker logs`) and nothing else, leaving the PR
      // stuck forever with zero trace on GitHub - see issue #78 (observed in practice on PRs #70
      // and #49). Escalate the same way every other give-up path in this file does.
      console.log(`Code review failed for issue #${issue.number}: ${review.errorSummary}`);
      await commentOnIssue(
        config.githubRepo,
        issue,
        `Le cycle de review a échoué (${review.errorSummary}) — intervention humaine nécessaire.`,
      );
      await markPullRequestNeedsHuman(config.githubRepo, branch);
      await markIssueNeedsHuman(config.githubRepo, issue);
      return;
    }

    const prState = await getPullRequestState(config.githubRepo, branch);
    if (prState === 'MERGED') {
      console.log(`PR for issue #${issue.number} merged by code-reviewer`);
      return;
    }

    const labels = await getPullRequestLabels(config.githubRepo, branch);
    if (!labels.includes(NEEDS_FIXUP_LABEL)) {
      // code-reviewer is supposed to always either merge the PR or leave it labeled
      // NEEDS_FIXUP_LABEL with an explanatory comment (CLAUDE.md, Code Review). Landing here means
      // it did neither - e.g. it forgot the `gh pr edit --add-label` call after commenting (PR
      // #25), or it never got that far at all. Without an explicit escalation this used to be a
      // silent console.log, leaving the PR stuck indefinitely with no trace on GitHub for a human
      // to notice (issue #78) - treat it as the anomaly it is instead.
      console.log(
        `PR for issue #${issue.number} not merged and not labeled '${NEEDS_FIXUP_LABEL}' (state: ${prState}) - treating as a stalled review and escalating`,
      );
      await commentOnIssue(
        config.githubRepo,
        issue,
        `Le code-reviewer a terminé son passage sans merger la PR ni poser le label \`${NEEDS_FIXUP_LABEL}\` (état de la PR : ${prState}) — cas anormal, intervention humaine nécessaire.`,
      );
      await markPullRequestNeedsHuman(config.githubRepo, branch);
      await markIssueNeedsHuman(config.githubRepo, issue);
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
      // Used to `return` unconditionally here, which left the PR open and still labeled
      // NEEDS_FIXUP_LABEL with nothing tracking how many times this had already happened: the
      // next poll's resumePendingReview found the same PR, re-invoked code-reviewer (a paid call)
      // from a fresh `cycle = 0`, hit the same fixup failure, and returned again - looping forever
      // without ever reaching the escalation below or consuming `maxReviewCycles` (issue #83, same
      // class of bug as #54/#57/#60). Falling through instead of returning lets *this* cycle count
      // against the for-loop's own bound, so the run naturally reaches the post-loop escalation
      // once `maxReviewCycles` is exhausted - no separate persisted counter needed, since the
      // bound is consumed within this single invocation rather than reset by each external re-poll.
      console.log(
        `Fixup attempt ${cycle + 1}/${config.maxReviewCycles} failed for issue #${issue.number}: ${fixup.errorSummary}`,
      );
      if (fixup.rateLimited) {
        // Rate limits recover over time, unlike a deterministic "no new commit produced" - give it
        // a growing backoff before spending the next cycle's review+fixup pair, same policy as the
        // pre-review sprint retries in handleIssue.
        const delay = Math.min(config.baseRetryDelayMs * 2 ** cycle, config.maxRetryDelayMs);
        console.log(
          `Fixup rate-limited for issue #${issue.number}, waiting ${delay}ms before retrying`,
        );
        await sleep(delay);
      }
      continue;
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
  mainCommitCache: RemoteMainCommitCache,
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

  if (await hasUnpushedCommit(branch, cwd, mainCommitCache)) {
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
    await runReviewLoop(issue, branch, config, cwd);
    clearState(cwd);
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
    await runReviewLoop(issue, branch, config, cwd);
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
    if (!(await hasOpenPullRequest(config.githubRepo, branch))) {
      await openPullRequest(config.githubRepo, issue, branch, cwd);
      console.log(`Opened PR for issue #${issue.number}`);
    }

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
async function runIteration(
  config: Config,
  cwd: string,
  mainCommitCache: RemoteMainCommitCache,
): Promise<void> {
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
      await handleIssue(issue, state, config, cwd, mainCommitCache);
      return;
    }
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

  await handleIssue(issue, state, config, cwd, mainCommitCache);
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
 * the next process picks up exactly where this one left off. Reads through `mainCommitCache`
 * rather than fetching directly, so it shares its fetch with any other call site (e.g.
 * `hasUnpushedCommit`) that needs the same answer within the same loop iteration - see issue #87.
 */
async function restartIfMainAdvanced(
  cwd: string,
  startupMainCommit: string,
  exitProcess: (code: number) => void,
  mainCommitCache: RemoteMainCommitCache,
): Promise<boolean> {
  const latest = await mainCommitCache.get(cwd);
  if (latest === startupMainCommit) return false;
  console.log(
    `origin/main advanced from ${startupMainCommit} to ${latest}; exiting so the container can restart with fresh code`,
  );
  exitProcess(0);
  return true;
}

/**
 * Fetches `origin/main`'s current commit (through `mainCommitCache`, see issue #87), logging a
 * warning instead of throwing if it fails (a transient network blip, e.g. right as the container
 * comes up). Callers treat `null` as "not captured yet" and retry on a later iteration rather than
 * giving up for the process's whole lifetime - see {@link runLoop}.
 */
async function tryCaptureMainCommit(
  cwd: string,
  mainCommitCache: RemoteMainCommitCache,
): Promise<string | null> {
  return mainCommitCache.get(cwd).catch((error: unknown) => {
    console.error(
      'Failed to fetch origin/main to capture the startup commit; self-restart detection stays disabled until this succeeds:',
      error,
    );
    return null;
  });
}

/**
 * Verifies, once before the poll loop starts, that `.git` and `.harness/` are actually writable by
 * this process. Without this, an unwritable path (the bind-mount ownership bug of issue #84) only
 * surfaces inside the per-iteration try/catch below: `checkoutMain` throws EACCES on `runIteration`'s
 * very first move, every single iteration, forever - the loop stays "alive" (a new line appended to
 * `.harness/errors.jsonl` every poll) but never makes any progress, and that fact is invisible
 * without running `everest doctor` by hand (issue #82). Failing fast here instead turns that into an
 * explicit, actionable message on the very first `docker compose logs`, and a non-zero exit that
 * `restart: unless-stopped` will retry - so a transient glitch (e.g. the entrypoint hasn't finished
 * chowning yet) still recovers on its own, but a persistent misconfiguration is loud rather than
 * silent (issue #94). Returns `false` when it exited (or would have, via the injected `exitProcess`
 * mock in tests) so {@link runLoop} knows not to enter the loop at all.
 */
function runStartupWritabilityPreflight(cwd: string, exitProcess: (code: number) => void): boolean {
  const problems: string[] = [];
  const git = checkGitWritable(cwd);
  if (!git.writable) {
    problems.push(`'${join(cwd, '.git')}' is not writable by the current user (${git.error})`);
  }
  const harness = checkHarnessWritable(cwd);
  if (!harness.writable) {
    problems.push(
      `'${join(cwd, '.harness')}' is not writable by the current user (${harness.error})`,
    );
  }
  if (problems.length === 0) return true;

  console.error('FATAL: startup writability preflight failed - the harness cannot make progress:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '  This is almost always the bind-mount ownership issue - see issue #84 (the container user ' +
      "does not own these paths; the entrypoint's chown should fix this on the next container " +
      'start). Exiting now instead of looping silently on the same error every poll interval - ' +
      'see issue #94.',
  );
  recordIterationError(
    new Error(`Startup writability preflight failed: ${problems.join('; ')}`),
    cwd,
  );
  exitProcess(1);
  return false;
}

/** Runs the harness loop: poll for the next issue, process it, repeat, for `iterations` cycles. */
export async function runLoop(
  config: Config,
  cwd: string,
  iterations = Infinity,
  exitProcess: (code: number) => void = process.exit,
): Promise<void> {
  if (!runStartupWritabilityPreflight(cwd, exitProcess)) return;

  // Captured once per process, not per iteration: this is "the code currently loaded in memory",
  // which only changes when the process itself restarts - see restartIfMainAdvanced. If the
  // initial fetch fails, it's retried lazily below on subsequent iterations rather than left
  // permanently null - otherwise a transient blip at boot would silently disable the self-restart
  // safety net for the process's whole lifetime, reintroducing the exact bug this loop exists to
  // fix.
  let startupMainCommit = await tryCaptureMainCommit(cwd, createRemoteMainCommitCache());

  for (let i = 0; i < iterations; i += 1) {
    // A single iteration failing (an unexpected git/gh error, a crashed subprocess, ...) must
    // never take down the whole process - that turns one bad issue into total downtime instead
    // of one skipped cycle. Seen in practice: a stale local branch from a budget-exhausted
    // attempt made the next `git checkout -b` throw, killing the container.
    try {
      // One cache per iteration, shared by every call site below that asks "what commit is
      // origin/main at right now" - mutualizes what would otherwise be several redundant
      // `git fetch origin main` calls per iteration (issue #87). Created fresh each iteration so a
      // real advance of origin/main between iterations is still picked up.
      const mainCommitCache = createRemoteMainCommitCache();
      if (startupMainCommit === null) {
        startupMainCommit = await tryCaptureMainCommit(cwd, mainCommitCache);
      }
      if (
        startupMainCommit &&
        (await restartIfMainAdvanced(cwd, startupMainCommit, exitProcess, mainCommitCache))
      ) {
        return;
      }
      await runIteration(config, cwd, mainCommitCache);
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
}
