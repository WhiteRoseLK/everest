import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLoop } from '../src/loop.js';
import { loadCostLog } from '../src/cost.js';
import type { Config } from '../src/config.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('runLoop end-to-end', () => {
  let tmpRoot: string;
  let originDir: string;
  let workDir: string;
  let prMarker: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-e2e-'));
    originDir = join(tmpRoot, 'origin.git');
    workDir = join(tmpRoot, 'work');
    prMarker = join(tmpRoot, 'pr-marker.txt');

    git(['init', '--bare', originDir], tmpRoot);
    git(['init', workDir], tmpRoot);
    git(
      [
        '-c',
        'user.email=test@test.local',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      workDir,
    );
    git(['branch', '-m', 'main'], workDir);
    git(['remote', 'add', 'origin', originDir], workDir);
    git(['push', '-u', 'origin', 'main'], workDir);

    originalPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
    process.env.FAKE_GH_PR_MARKER = prMarker;
    process.env.FAKE_GH_COMMENT_MARKER = join(tmpRoot, 'comment-marker.txt');
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_VIEW;
    delete process.env.FAKE_CLAUDE_RATE_LIMITED;
    delete process.env.FAKE_CLAUDE_BUDGET_EXCEEDED;
    delete process.env.FAKE_CLAUDE_BUDGET_EXCEEDED_WITH_WIP;
    delete process.env.FAKE_CLAUDE_NO_COMMIT;
    delete process.env.FAKE_GH_ISSUE_LIST_FAIL_ONCE;
    delete process.env.FAKE_CLAUDE_ADVANCE_ORIGIN_MAIN;
    delete process.env.FAKE_GH_PR_EDIT_MARKER;
    delete process.env.FAKE_GH_ISSUE_LIST;
    delete process.env.FAKE_GH_ISSUE_EDIT_MARKER;
    delete process.env.FAKE_CODE_REVIEWER_FAIL;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('processes an issue end to end: branch, commit, push, PR', async () => {
    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    expect(existsSync(prMarker)).toBe(true);
    const prArgs = readFileSync(prMarker, 'utf-8');
    expect(prArgs).toContain('Test issue');

    const branches = execFileSync('git', ['branch', '-a'], { cwd: originDir, encoding: 'utf-8' });
    expect(branches).toContain('harness/issue-1-test-issue');

    // The fake claude binary reports total_cost_usd: 0.01 - the harness should record it,
    // tagged with the issue, so token cost can be measured before ever considering a
    // context-compression tool like Headroom (see issue #13).
    const costLog = loadCostLog(workDir);
    expect(costLog).toContainEqual(
      expect.objectContaining({ agent: 'issue-worker', label: 'issue-#1', totalCostUsd: 0.01 }),
    );
  });

  it('resumes the review loop for an already-open PR labeled needs-fixup', async () => {
    const reviewerMarker = '/tmp/fake-code-reviewer-invoked.marker';
    rmSync(reviewerMarker, { force: true });

    // Simulate a previous run that already opened the PR for issue #1: the branch exists,
    // has a commit, and is pushed - but the harness stopped before the review loop resolved.
    git(['checkout', '-b', 'harness/issue-1-test-issue'], workDir);
    git(
      [
        '-c',
        'user.email=test@test.local',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-m',
        'existing PR commit',
      ],
      workDir,
    );
    git(['push', '-u', 'origin', 'harness/issue-1-test-issue'], workDir);
    git(['checkout', 'main'], workDir);

    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        headRefName: 'harness/issue-1-test-issue',
        labels: [{ name: 'needs-fixup' }],
      },
    ]);
    // Simulates code-reviewer deciding to merge on this resumed pass.
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({ state: 'MERGED', labels: [] });

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // The resumed review loop invoked code-reviewer, saw it's now merged, and did not
    // recreate the PR (openPullRequest is only called from the fresh-issue path).
    expect(existsSync(reviewerMarker)).toBe(true);
    expect(existsSync(prMarker)).toBe(false);

    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    expect(currentBranch).toBe('harness/issue-1-test-issue');
  });

  it('gives up after maxRetryCount consecutive rate limits instead of retrying forever', async () => {
    process.env.FAKE_CLAUDE_RATE_LIMITED = '1';

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 2,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // maxRetryCount = 2 means 3 total attempts (retryCount goes 1, 2, 3) before giving up;
    // one runLoop iteration per attempt since a persisted state is resumed directly.
    await runLoop(config, workDir, 3);

    expect(existsSync(prMarker)).toBe(false);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('limite de 2 tentatives');

    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);
  });

  it('labels the issue itself needs-human on give-up, and stops re-picking it (issue #60)', async () => {
    // Before the fix: an issue that never got as far as opening a PR was invisible to
    // filterOutIssuesWithOpenPr once the harness gave up on it, so pickNextIssue kept re-selecting
    // it on every poll - burning a full sprint per cycle for no benefit until a human noticed (see
    // issue #47 in practice). Fix: the harness also labels the issue itself needs-human at
    // give-up, and excludes such issues from the candidate pool up front.
    process.env.FAKE_CLAUDE_RATE_LIMITED = '1';
    const issueEditMarker = join(tmpRoot, 'issue-edit-marker.txt');
    process.env.FAKE_GH_ISSUE_EDIT_MARKER = issueEditMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 1,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // maxRetryCount = 1 means 2 total attempts before giving up.
    await runLoop(config, workDir, 2);

    expect(existsSync(issueEditMarker)).toBe(true);
    const issueEditArgs = readFileSync(issueEditMarker, 'utf-8');
    expect(issueEditArgs).toContain('issue edit 1');
    expect(issueEditArgs).toContain('needs-human');

    // Simulate GitHub now reporting the issue as labeled needs-human (as the previous call would
    // have caused) and run another iteration: the issue must not be picked up again - no branch
    // is created, no rate-limit retry is attempted, nothing new is written to state.
    process.env.FAKE_GH_ISSUE_LIST = JSON.stringify([
      {
        number: 1,
        title: 'Test issue',
        labels: [{ name: 'needs-human' }],
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]);
    await runLoop(config, workDir, 1);

    expect(existsSync(prMarker)).toBe(false);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);
  });

  it('survives an unexpected error in one iteration and processes the issue on the next', async () => {
    const failMarker = join(tmpRoot, 'fail-once.marker');
    writeFileSync(failMarker, '');
    process.env.FAKE_GH_ISSUE_LIST_FAIL_ONCE = failMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // Iteration 1 hits the simulated `gh issue list` failure and must not crash the process;
    // iteration 2 should proceed normally and open the PR, proving runLoop recovered.
    await runLoop(config, workDir, 2);

    expect(existsSync(prMarker)).toBe(true);
  });

  it('clears a stale state.json pointing at a no-longer-open issue instead of stalling forever (issue #82)', async () => {
    // A prior run left state.json pointing at issue #999, which is no longer in the open-issue
    // list (closed by hand, or its PR merged and the issue auto-closed). Before the fix, runIteration
    // saw `issue === null` and just slept+returned every poll, never clearing the checkpoint and
    // never looking at the actually-eligible issue #1 - the loop was alive but permanently stuck.
    const statePath = join(workDir, '.harness/state.json');
    mkdirSync(join(workDir, '.harness'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        issueNumber: 999,
        branch: 'harness/issue-999-gone',
        startedAt: '2026-07-19T00:00:00Z',
        retryCount: 0,
      }),
    );
    // Default FAKE_GH_ISSUE_LIST returns only issue #1 (see fixtures/fake-bin/gh), so #999 is absent.

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // The stale checkpoint is gone and the harness resumed normal selection: issue #1 got a PR.
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(prMarker)).toBe(true);
    expect(readFileSync(prMarker, 'utf-8')).toContain('Test issue');
  });

  it('checkpoints WIP progress and hands off to review when the sprint budget is exhausted', async () => {
    process.env.FAKE_CLAUDE_BUDGET_EXCEEDED_WITH_WIP = '1';

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // The budget guardrail is on the sprint, not the issue: hitting it should not abandon the
    // issue - the harness commits the uncommitted "wip-file.txt" as a checkpoint, pushes, opens
    // a PR, and hands off to the normal review loop instead of giving up.
    await runLoop(config, workDir, 1);

    expect(existsSync(prMarker)).toBe(true);

    const log = execFileSync('git', ['log', '--oneline', 'harness/issue-1-test-issue'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(log).toContain('WIP checkpoint');
  });

  it('retries with a fresh sprint when the budget is exhausted with nothing to checkpoint', async () => {
    process.env.FAKE_CLAUDE_BUDGET_EXCEEDED = '1';

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // Nothing to checkpoint yet, so no PR - just a saved retry state for the next sprint.
    expect(existsSync(prMarker)).toBe(false);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.retryCount).toBe(1);
  });

  it('falls back to a bounded retry when pushing the WIP checkpoint itself fails', async () => {
    process.env.FAKE_CLAUDE_BUDGET_EXCEEDED_WITH_WIP = '1';
    // Force the checkpoint push to be rejected server-side, for a reason unrelated to client
    // hooks (--no-verify already bypasses those) - a pre-receive hook is a stand-in for any
    // server-side rejection (protected branch, network blip mid-push, etc). Added after the
    // initial `git push -u origin main` in beforeEach already succeeded, so only this test's
    // checkpoint push is affected - pull/fetch (used by checkoutMain) are untouched.
    writeFileSync(join(originDir, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // The push failure must not crash the loop or open a PR for an unpushed branch - it falls
    // back to the same bounded retry-with-cap semantics as "nothing to checkpoint".
    expect(existsSync(prMarker)).toBe(false);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.retryCount).toBe(1);

    // The checkpoint commit itself still exists locally even though the push failed.
    const log = execFileSync('git', ['log', '--oneline', 'harness/issue-1-test-issue'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(log).toContain('WIP checkpoint');
  });

  it('falls back to a bounded retry when pushing finished work fails (issue #54)', async () => {
    // Simulates a persistent push failure on an otherwise-successful sprint - e.g. a missing
    // `workflow` OAuth scope rejecting a push that touches `.github/workflows/*` (the concrete
    // trigger reported in issue #54). Before the fix, this throw propagated unguarded out of
    // handleIssue's success branch, was swallowed by runLoop's per-iteration try/catch, and left
    // state.json untouched - the next iteration re-ran a fresh sprint on the same branch, saw
    // nothing new to commit, commented "no new commit produced", cleared state, and picked the
    // same issue again from scratch, forever, without ever hitting maxRetryCount.
    writeFileSync(join(originDir, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // No PR for an unpushed branch - it falls back to the same bounded retry-with-cap semantics
    // as the other push-failure paths, rather than crashing or looping silently.
    expect(existsSync(prMarker)).toBe(false);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.retryCount).toBe(1);

    // The finished-work commit itself still exists locally even though the push failed.
    const log = execFileSync('git', ['log', '--oneline', 'harness/issue-1-test-issue'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(log).toContain('Add feature.txt');
  });

  it('retries the push directly instead of spending a fresh sprint when a push transiently fails (issue #59)', async () => {
    // Rejects only the very first push attempt after this hook is installed, then succeeds from
    // the second attempt onward - simulating a transient failure (flaky server-side hook,
    // momentary network blip) rather than a persistent one. Before the fix, handleIssue treated
    // any push failure as a reason to spend a whole fresh issue-worker sprint on the same branch,
    // even though the already-committed work was correct and only the push transport hiccuped.
    const counterFile = join(tmpRoot, 'push-attempt-counter');
    writeFileSync(
      join(originDir, 'hooks/pre-receive'),
      `#!/bin/sh\ncount=$(( $(cat "${counterFile}" 2>/dev/null || echo 0) + 1 ))\necho "$count" > "${counterFile}"\n[ "$count" -ge 2 ]\n`,
      { mode: 0o755 },
    );

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 3,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // The push eventually succeeded (on its second direct attempt), so the PR was opened and
    // state was cleared - a single sprint sufficed, no retry-with-a-fresh-sprint needed.
    expect(existsSync(prMarker)).toBe(true);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);

    // Only one issue-worker sprint ran: a second fresh sprint (the old behavior) would have added
    // a second `issue-worker` cost-log entry for the same issue.
    const costLog = loadCostLog(workDir);
    const issueWorkerEntries = costLog.filter(
      (entry) => entry.agent === 'issue-worker' && entry.label === 'issue-#1',
    );
    expect(issueWorkerEntries).toHaveLength(1);
  });

  it('retries the push directly on the next sprint instead of re-invoking issue-worker for an already-committed but unpushed commit (issue #61)', async () => {
    // Rejects only the very first push attempt across the whole issue, then succeeds from the
    // second attempt onward - but unlike the issue #59 test above, pushRetryCount is 1 here, so
    // the first sprint's pushBranchWithRetries doesn't retry internally: it exhausts immediately
    // and falls back to a fresh sprint via retryFreshSprintOrGiveUp, leaving the finished commit
    // sitting locally, unpushed. Before the fix, the second sprint blindly re-invoked
    // issue-worker, which found nothing left to do and (depending on the agent) could report "no
    // new commit produced" for work that was already correct and complete - wasting a sprint and
    // a unit of retryCount on what was really just a push problem.
    const counterFile = join(tmpRoot, 'push-attempt-counter');
    writeFileSync(
      join(originDir, 'hooks/pre-receive'),
      `#!/bin/sh\ncount=$(( $(cat "${counterFile}" 2>/dev/null || echo 0) + 1 ))\necho "$count" > "${counterFile}"\n[ "$count" -ge 2 ]\n`,
      { mode: 0o755 },
    );

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // Two runLoop iterations: the first sprint commits and fails to push (exhausting its single
    // pushRetryCount attempt), saving state for a second sprint. The second iteration resumes
    // that state and should retry the push directly rather than spending another sprint.
    await runLoop(config, workDir, 2);

    // The second push attempt succeeded, so the PR was opened and state was cleared.
    expect(existsSync(prMarker)).toBe(true);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);

    // Only one issue-worker sprint ran across both iterations: the fix skips re-invoking
    // issue-worker once it detects the branch already carries an unpushed, correct commit.
    const costLog = loadCostLog(workDir);
    const issueWorkerEntries = costLog.filter(
      (entry) => entry.agent === 'issue-worker' && entry.label === 'issue-#1',
    );
    expect(issueWorkerEntries).toHaveLength(1);
  });

  it('escalates to needs-human after maxRetryCount repeated push failures on finished work (issue #54)', async () => {
    writeFileSync(join(originDir, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 2,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // maxRetryCount = 2 means 3 total sprints (retryCount goes 1, 2, 3) before giving up; one
    // runLoop iteration per sprint since a persisted state is resumed directly.
    await runLoop(config, workDir, 3);

    expect(existsSync(prMarker)).toBe(false);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('limite de 2 tentatives');

    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);
  });

  it('escalates to needs-human immediately (no retries) when the push fails for a missing workflow OAuth scope (issue #55)', async () => {
    // Unlike a generic push rejection (issue #54, tested above), GitHub's specific "missing
    // `workflow` OAuth scope" rejection is deterministic - it fails identically on every retry
    // until a human regenerates GH_TOKEN with the scope added - so it must skip the bounded
    // retry-with-cap dance entirely and escalate on the very first attempt.
    const issueEditMarker = join(tmpRoot, 'issue-edit-marker.txt');
    process.env.FAKE_GH_ISSUE_EDIT_MARKER = issueEditMarker;
    writeFileSync(
      join(originDir, 'hooks/pre-receive'),
      '#!/bin/sh\n' +
        'echo "error: refusing to allow an OAuth App to create or update workflow ' +
        '\\`.github/workflows/ci.yml\\` without \\`workflow\\` scope)" >&2\n' +
        'exit 1\n',
      { mode: 0o755 },
    );

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // A single iteration is enough: with the old generic-retry behavior this would only save a
    // retryCount of 1 and keep state.json around for another sprint (see the "falls back to a
    // bounded retry ... (issue #54)" test above) - the fix escalates and clears state right away.
    await runLoop(config, workDir, 1);

    expect(existsSync(prMarker)).toBe(false);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('workflow');
    expect(commentArgs).toContain('#55');

    expect(existsSync(issueEditMarker)).toBe(true);
    expect(readFileSync(issueEditMarker, 'utf-8')).toContain('needs-human');

    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);

    // The finished-work commit itself still exists locally even though the push failed.
    const log = execFileSync('git', ['log', '--oneline', 'harness/issue-1-test-issue'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(log).toContain('Add feature.txt');
  });

  it('retries with a fresh sprint when the agent reports success but produces no commit (issue #57)', async () => {
    process.env.FAKE_CLAUDE_NO_COMMIT = '1';

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    // No PR for a branch with no new commit - it falls back to the same bounded retry-with-cap
    // semantics as the other failure paths, on the same branch, rather than clearing state and
    // letting the next iteration recreate the branch from scratch with retryCount reset to 0.
    expect(existsSync(prMarker)).toBe(false);
    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.retryCount).toBe(1);
    expect(state.branch).toBe('harness/issue-1-test-issue');
  });

  it('escalates to needs-human after maxRetryCount repeated "no new commit" sprints (issue #57)', async () => {
    // Before the fix, this generic failure path unconditionally commented and cleared state on
    // every single sprint instead of routing through retryFreshSprintOrGiveUp - so the loop kept
    // re-picking the issue, recreating the branch from scratch (retryCount always 0), and
    // repeating the same "no new commit produced" comment forever, never reaching maxRetryCount
    // or giving up. Reported in production on issue #47: 4 repeats in 13 minutes.
    process.env.FAKE_CLAUDE_NO_COMMIT = '1';

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 2,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // maxRetryCount = 2 means 3 total sprints (retryCount goes 1, 2, 3) before giving up; one
    // runLoop iteration per sprint since a persisted state is resumed directly.
    await runLoop(config, workDir, 3);

    expect(existsSync(prMarker)).toBe(false);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('limite de 2 tentatives');

    const statePath = join(workDir, '.harness/state.json');
    expect(existsSync(statePath)).toBe(false);
  });

  it('escalates a PR to needs-human when pushing a review fixup fails repeatedly (issue #54)', async () => {
    // First review cycle: code-reviewer requests changes (needs-fixup). issue-worker's fixup
    // commit succeeds locally, but pushing it keeps failing (e.g. the same missing `workflow`
    // OAuth scope as issue #54) - this must escalate immediately rather than silently looping,
    // since (unlike a brand-new sprint) retrying wouldn't redo any missing work here.
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      state: 'OPEN',
      labels: [{ name: 'needs-fixup' }],
    });
    // Rejects every push starting from the second one, so the initial branch push (needed to
    // open the PR and enter the review loop in the first place) still succeeds, and only the
    // fixup push fails.
    const counterFile = join(tmpRoot, 'push-attempt-counter');
    writeFileSync(
      join(originDir, 'hooks/pre-receive'),
      `#!/bin/sh\ncount=$(( $(cat "${counterFile}" 2>/dev/null || echo 0) + 1 ))\necho "$count" > "${counterFile}"\n[ "$count" -lt 2 ]\n`,
      { mode: 0o755 },
    );
    const editMarker = join(tmpRoot, 'pr-edit-marker.txt');
    process.env.FAKE_GH_PR_EDIT_MARKER = editMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('échec de push répété');

    expect(existsSync(editMarker)).toBe(true);
    expect(readFileSync(editMarker, 'utf-8')).toContain('needs-human');
  });

  it('escalates to needs-human when a review fixup repeatedly produces no commit (issue #83)', async () => {
    // Simulate a previous run that already opened the PR for issue #1 and code-reviewer already
    // requested changes - the harness resumes straight into the review loop, same setup as the
    // "resumes the review loop" test above.
    git(['checkout', '-b', 'harness/issue-1-test-issue'], workDir);
    git(
      [
        '-c',
        'user.email=test@test.local',
        '-c',
        'user.name=Test',
        'commit',
        '--allow-empty',
        '-m',
        'existing PR commit',
      ],
      workDir,
    );
    git(['push', '-u', 'origin', 'harness/issue-1-test-issue'], workDir);
    git(['checkout', 'main'], workDir);

    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        headRefName: 'harness/issue-1-test-issue',
        labels: [{ name: 'needs-fixup' }],
      },
    ]);
    // The PR stays open and labeled needs-fixup on every review pass; issue-worker's fixup
    // attempt reports success but never commits anything (e.g. it explored the feedback and
    // concluded there was nothing to change) - runClaudeCode turns that into a failure. Before the
    // fix, runReviewLoop returned unconditionally on this failure without escalating, so the PR
    // stayed open+needs-fixup forever: the next poll's resumePendingReview re-invoked
    // code-reviewer from a fresh cycle=0 every single time (issue #83).
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({
      state: 'OPEN',
      labels: [{ name: 'needs-fixup' }],
    });
    process.env.FAKE_CLAUDE_NO_COMMIT = '1';

    const editMarker = join(tmpRoot, 'pr-edit-marker.txt');
    process.env.FAKE_GH_PR_EDIT_MARKER = editMarker;
    const issueEditMarker = join(tmpRoot, 'issue-edit-marker.txt');
    process.env.FAKE_GH_ISSUE_EDIT_MARKER = issueEditMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 2,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // A single runLoop iteration is enough: the fix bounds fixup-failure retries within one
    // continuous call to runReviewLoop's own cycle loop, rather than needing repeated external
    // polls that would each reset back to cycle=0.
    await runLoop(config, workDir, 1);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain(`limite de ${config.maxReviewCycles} cycles de review`);

    expect(existsSync(editMarker)).toBe(true);
    expect(readFileSync(editMarker, 'utf-8')).toContain('needs-human');

    expect(existsSync(issueEditMarker)).toBe(true);
    expect(readFileSync(issueEditMarker, 'utf-8')).toContain('needs-human');

    // code-reviewer was actually invoked maxReviewCycles times (once per cycle), proving the
    // cycles were genuinely consumed within this single call rather than short-circuited on the
    // very first fixup failure.
    const costLog = loadCostLog(workDir);
    const reviewInvocations = costLog.filter(
      (entry) =>
        entry.agent === 'code-reviewer' &&
        entry.label === 'code-reviewer:harness/issue-1-test-issue',
    );
    expect(reviewInvocations).toHaveLength(config.maxReviewCycles);
  });

  it('escalates to needs-human on the issue and PR when the review invocation itself fails (issue #78)', async () => {
    // Before the fix, a failed/budget-exhausted code-reviewer invocation was only logged to
    // stdout - the PR was left open forever with zero trace on GitHub (observed in practice on
    // PRs #70 and #49, which never got a single 'labeled' or 'commented' timeline event).
    process.env.FAKE_CODE_REVIEWER_FAIL = '1';
    const editMarker = join(tmpRoot, 'pr-edit-marker.txt');
    process.env.FAKE_GH_PR_EDIT_MARKER = editMarker;
    const issueEditMarker = join(tmpRoot, 'issue-edit-marker.txt');
    process.env.FAKE_GH_ISSUE_EDIT_MARKER = issueEditMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('review a échoué');

    expect(existsSync(editMarker)).toBe(true);
    expect(readFileSync(editMarker, 'utf-8')).toContain('needs-human');

    expect(existsSync(issueEditMarker)).toBe(true);
    expect(readFileSync(issueEditMarker, 'utf-8')).toContain('needs-human');
  });

  it('escalates to needs-human when code-reviewer neither merges nor labels the PR needs-fixup (issue #78)', async () => {
    // Simulates code-reviewer completing successfully but forgetting to apply the needs-fixup
    // label after commenting (observed in practice on PR #25). Before the fix, runReviewLoop just
    // logged this and returned, leaving the PR stuck open indefinitely with no signal on GitHub.
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({ state: 'OPEN', labels: [] });
    const editMarker = join(tmpRoot, 'pr-edit-marker.txt');
    process.env.FAKE_GH_PR_EDIT_MARKER = editMarker;
    const issueEditMarker = join(tmpRoot, 'issue-edit-marker.txt');
    process.env.FAKE_GH_ISSUE_EDIT_MARKER = issueEditMarker;

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    await runLoop(config, workDir, 1);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('needs-fixup');

    expect(existsSync(editMarker)).toBe(true);
    expect(readFileSync(editMarker, 'utf-8')).toContain('needs-human');

    expect(existsSync(issueEditMarker)).toBe(true);
    expect(readFileSync(issueEditMarker, 'utf-8')).toContain('needs-human');
  });

  it('restarts the process once origin/main advances mid-run, instead of running stale code forever', async () => {
    // The fake claude binary pushes a new commit straight to origin/main as a side effect,
    // simulating a concurrent merge (e.g. code-reviewer merging a different issue's PR) while
    // this sprint runs - see issue #43: the harness never reloads its own already-imported
    // modules, so it must notice origin/main moved and exit for the container to restart it.
    process.env.FAKE_CLAUDE_ADVANCE_ORIGIN_MAIN = '1';
    const exitProcess = vi.fn();

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      watchPollIntervalMs: 30_000,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 10,
      pushRetryCount: 1,
      pushRetryDelayMs: 1,
      dashboardPort: 0,
    };

    // Iteration 1 processes issue #1 end to end (origin/main advances as a side effect along
    // the way). Iteration 2's restart check must catch that before doing any further work -
    // 3 iterations gives it room to prove no further processing happens once exitProcess is
    // called (exitProcess is a mock here, so it doesn't actually terminate the test process).
    await runLoop(config, workDir, 3, exitProcess);

    expect(existsSync(prMarker)).toBe(true);
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it(
    'recovers from a failed startup fetch of origin/main instead of disabling the restart ' +
      'check for the rest of the process, and still detects a later advance',
    async () => {
      // The very first `git fetch origin main` (the startup capture in runLoop) fails once,
      // simulating a transient network blip right as the container comes up - see the review
      // feedback on issue #43: this must not silently disable self-restart detection forever.
      const fetchFailMarker = join(tmpRoot, 'git-fetch-fail-once.marker');
      writeFileSync(fetchFailMarker, '');
      process.env.FAKE_GIT_FETCH_MAIN_FAIL_ONCE = fetchFailMarker;
      // origin/main advances mid-sprint on iteration 1, same as the test above.
      process.env.FAKE_CLAUDE_ADVANCE_ORIGIN_MAIN = '1';
      const exitProcess = vi.fn();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const config: Config = {
        githubRepo: 'fake/repo',
        maxBudgetUsdPerIssue: 1,
        maxBudgetUsdPerReview: 1,
        maxReviewCycles: 3,
        watchPollIntervalMs: 30_000,
        pollIntervalMs: 1,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        maxRetryCount: 10,
        pushRetryCount: 1,
        pushRetryDelayMs: 1,
        dashboardPort: 0,
      };

      try {
        // Iteration 1: the startup fetch already failed before the loop began, so it retries
        // lazily here, succeeds (the marker is now gone), and processes issue #1 (advancing
        // origin/main as a side effect). Iteration 2 must still catch that advance and exit -
        // proving the one-time fetch failure didn't permanently disable the mechanism.
        await runLoop(config, workDir, 3, exitProcess);

        expect(existsSync(prMarker)).toBe(true);
        expect(exitProcess).toHaveBeenCalledTimes(1);
        expect(exitProcess).toHaveBeenCalledWith(0);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to fetch origin/main'),
          expect.anything(),
        );
      } finally {
        consoleErrorSpy.mockRestore();
        delete process.env.FAKE_GIT_FETCH_MAIN_FAIL_ONCE;
      }
    },
  );

  // chmod-based permission tests are meaningless as root (root bypasses file permissions).
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)(
    'fails fast with an explicit message instead of looping silently when .git is not writable (issue #94)',
    async () => {
      // Simulates the bind-mount ownership EACCES of issue #84: every iteration's very first move
      // is a git operation, so without a startup preflight this would fail identically forever,
      // one silent line in .harness/errors.jsonl per poll, instead of failing loudly once at boot.
      chmodSync(join(workDir, '.git'), 0o500); // read+execute, no write
      const exitProcess = vi.fn();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const config: Config = {
        githubRepo: 'fake/repo',
        maxBudgetUsdPerIssue: 1,
        maxBudgetUsdPerReview: 1,
        maxReviewCycles: 3,
        watchPollIntervalMs: 30_000,
        pollIntervalMs: 1,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        maxRetryCount: 10,
        pushRetryCount: 1,
        pushRetryDelayMs: 1,
        dashboardPort: 0,
      };

      try {
        // exitProcess is a mock here, so it doesn't actually terminate runLoop - the assertion
        // that matters is that no issue processing happened (no PR marker), proving the preflight
        // returned early instead of falling through into the poll loop.
        await runLoop(config, workDir, 3, exitProcess);

        expect(exitProcess).toHaveBeenCalledWith(1);
        expect(existsSync(prMarker)).toBe(false);
        const output = errorSpy.mock.calls.flat().map(String).join('\n');
        expect(output).toContain('not writable');
        expect(output).toContain('issue #84');
      } finally {
        chmodSync(join(workDir, '.git'), 0o755); // restore so afterEach can clean up
        errorSpy.mockRestore();
      }
    },
  );

  it.skipIf(isRoot)(
    'fails fast with an explicit message instead of looping silently when .harness/ is not writable (issue #94)',
    async () => {
      mkdirSync(join(workDir, '.harness'), { recursive: true });
      chmodSync(join(workDir, '.harness'), 0o500); // read+execute, no write
      const exitProcess = vi.fn();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const config: Config = {
        githubRepo: 'fake/repo',
        maxBudgetUsdPerIssue: 1,
        maxBudgetUsdPerReview: 1,
        maxReviewCycles: 3,
        watchPollIntervalMs: 30_000,
        pollIntervalMs: 1,
        baseRetryDelayMs: 1,
        maxRetryDelayMs: 1,
        maxRetryCount: 10,
        pushRetryCount: 1,
        pushRetryDelayMs: 1,
        dashboardPort: 0,
      };

      try {
        await runLoop(config, workDir, 3, exitProcess);

        expect(exitProcess).toHaveBeenCalledWith(1);
        expect(existsSync(prMarker)).toBe(false);
        const output = errorSpy.mock.calls.flat().map(String).join('\n');
        expect(output).toContain('not writable');
        expect(output).toContain('issue #84');
      } finally {
        chmodSync(join(workDir, '.harness'), 0o755); // restore so afterEach can clean up
        errorSpy.mockRestore();
      }
    },
  );
});
