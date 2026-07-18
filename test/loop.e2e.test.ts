import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
    delete process.env.FAKE_GH_ISSUE_LIST_FAIL_ONCE;
    delete process.env.FAKE_CLAUDE_ADVANCE_ORIGIN_MAIN;
    delete process.env.FAKE_GH_PR_EDIT_MARKER;
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
    };

    // Iteration 1 hits the simulated `gh issue list` failure and must not crash the process;
    // iteration 2 should proceed normally and open the PR, proving runLoop recovered.
    await runLoop(config, workDir, 2);

    expect(existsSync(prMarker)).toBe(true);
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
    };

    await runLoop(config, workDir, 1);

    const commentMarker = process.env.FAKE_GH_COMMENT_MARKER!;
    expect(existsSync(commentMarker)).toBe(true);
    const commentArgs = readFileSync(commentMarker, 'utf-8');
    expect(commentArgs).toContain('échec de push répété');

    expect(existsSync(editMarker)).toBe(true);
    expect(readFileSync(editMarker, 'utf-8')).toContain('needs-human');
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
});
