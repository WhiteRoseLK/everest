import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
    delete process.env.FAKE_GH_ISSUE_LIST;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('processes an issue end to end: branch, commit, push, PR', async () => {
    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      maxRetryCount: 10,
      maxParallelIssues: 1,
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

  it('resumes the review loop for an already-open PR left with CHANGES_REQUESTED', async () => {
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
        reviewDecision: 'CHANGES_REQUESTED',
        labels: [],
      },
    ]);
    process.env.FAKE_GH_PR_VIEW = JSON.stringify({ reviewDecision: 'APPROVED' });

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      maxRetryCount: 10,
      maxParallelIssues: 1,
    };

    await runLoop(config, workDir, 1);

    // The resumed review loop invoked code-reviewer, saw it's now approved, and did not
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
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
      maxRetryCount: 2,
      maxParallelIssues: 1,
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

  it('processes multiple independent issues concurrently, each in its own worktree', async () => {
    process.env.FAKE_GH_ISSUE_LIST = JSON.stringify([
      { number: 1, title: 'Test issue', labels: [], createdAt: '2024-01-01T00:00:00Z' },
      { number: 2, title: 'Second issue', labels: [], createdAt: '2024-01-02T00:00:00Z' },
    ]);

    const config: Config = {
      githubRepo: 'fake/repo',
      maxBudgetUsdPerIssue: 1,
      maxBudgetUsdPerReview: 1,
      maxReviewCycles: 3,
      pollIntervalMs: 100,
      baseRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      maxRetryCount: 10,
      maxParallelIssues: 2,
    };

    await runLoop(config, workDir, 1);

    // Both issues got their own branch, pushed and PR'd.
    const branches = execFileSync('git', ['branch', '-a'], { cwd: originDir, encoding: 'utf-8' });
    expect(branches).toContain('harness/issue-1-test-issue');
    expect(branches).toContain('harness/issue-2-second-issue');

    const prArgs = readFileSync(prMarker, 'utf-8');
    expect(prArgs).toContain('Test issue');
    expect(prArgs).toContain('Second issue');

    // The primary checkout is left on main, untouched by either worktree's branch.
    const currentBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    expect(currentBranch).toBe('main');

    // Worktrees are cleaned up once their issue is done: only the primary checkout remains.
    const worktrees = execFileSync('git', ['worktree', 'list'], {
      cwd: workDir,
      encoding: 'utf-8',
    });
    expect(worktrees.trim().split('\n')).toHaveLength(1);
  });
});
