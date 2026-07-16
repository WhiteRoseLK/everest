import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLoop } from '../src/loop.js';
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
    };

    await runLoop(config, workDir, 1);

    expect(existsSync(prMarker)).toBe(true);
    const prArgs = readFileSync(prMarker, 'utf-8');
    expect(prArgs).toContain('Test issue');

    const branches = execFileSync('git', ['branch', '-a'], { cwd: originDir, encoding: 'utf-8' });
    expect(branches).toContain('harness/issue-1-test-issue');
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
});
