import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Issue {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

/** Lists open issues on `repo` via the `gh` CLI, sorted as returned by GitHub (not prioritized). */
export async function listOpenIssues(repo: string): Promise<Issue[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,labels,createdAt',
  ]);
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    createdAt: string;
  }>;
  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    createdAt: issue.createdAt,
  }));
}

/**
 * Sets the git author identity (repo-local, not global) used for the next commit. Called before
 * invoking each subagent so commits are attributed to the agent that made them (e.g.
 * `everest-issue-worker`) instead of a single shared identity.
 */
export async function setGitIdentity(name: string, email: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['config', 'user.name', name], { cwd });
  await execFileAsync('git', ['config', 'user.email', email], { cwd });
}

/** Derives the deterministic branch name the harness uses for a given issue. */
export function branchNameFor(issue: Issue): string {
  return `harness/issue-${issue.number}-${slugify(issue.title)}`;
}

/**
 * Checks whether a branch already has an open PR against it. An issue stays "open" on GitHub
 * until its PR is merged, so without this check the harness would retry the same issue on every
 * loop iteration and collide with the branch it already created.
 */
export async function hasOpenPullRequest(repo: string, branch: string): Promise<boolean> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  const prs = JSON.parse(stdout) as Array<{ number: number }>;
  return prs.length > 0;
}

/** Label applied to a harness PR once it has exhausted its review cycles without approval, so it's not picked up again for automatic resumption until a human intervenes. */
export const NEEDS_HUMAN_LABEL = 'needs-human';

const HARNESS_BRANCH_ISSUE_PATTERN = /^harness\/issue-(\d+)-/;

export interface ResumablePullRequest {
  branch: string;
  issueNumber: number;
}

/**
 * Finds an open harness PR (branch prefixed `harness/`) whose review was left with
 * `CHANGES_REQUESTED`, so the harness can resume its review loop on restart instead of leaving
 * it stuck. PRs already labeled {@link NEEDS_HUMAN_LABEL} (review budget exhausted) are skipped.
 */
export async function findResumablePullRequest(repo: string): Promise<ResumablePullRequest | null> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'headRefName,reviewDecision,labels',
  ]);
  const prs = JSON.parse(stdout) as Array<{
    headRefName: string;
    reviewDecision: string | null;
    labels: Array<{ name: string }>;
  }>;

  for (const pr of prs) {
    if (pr.reviewDecision !== 'CHANGES_REQUESTED') continue;
    if (pr.labels.some((label) => label.name === NEEDS_HUMAN_LABEL)) continue;
    const match = HARNESS_BRANCH_ISSUE_PATTERN.exec(pr.headRefName);
    if (!match) continue;
    return { branch: pr.headRefName, issueNumber: Number(match[1]) };
  }
  return null;
}

/**
 * Labels a PR as needing human attention (creating the label first if it doesn't exist yet),
 * used once the review loop has exhausted its cycle budget without reaching approval.
 */
export async function markPullRequestNeedsHuman(repo: string, branch: string): Promise<void> {
  await execFileAsync('gh', [
    'label',
    'create',
    NEEDS_HUMAN_LABEL,
    '--repo',
    repo,
    '--color',
    'B60205',
    '--description',
    'Needs human intervention, the harness could not resolve this automatically.',
    '--force',
  ]);
  await execFileAsync('gh', [
    'pr',
    'edit',
    branch,
    '--repo',
    repo,
    '--add-label',
    NEEDS_HUMAN_LABEL,
  ]);
}

/**
 * Checks out `main` and fast-forwards it to `origin/main`. Called before creating a new issue
 * branch so it always branches from up-to-date main, not from whatever branch a previous issue
 * left checked out (which may since have been merged and deleted on the remote).
 */
export async function checkoutMain(cwd: string): Promise<void> {
  await execFileAsync('git', ['checkout', 'main'], { cwd });
  await execFileAsync('git', ['pull', '--ff-only', 'origin', 'main'], { cwd });
}

/**
 * Creates and checks out a new branch for an issue being processed for the first time. Deletes
 * any stale local branch of the same name first (never pushed, so safe to discard) - left over
 * from a previous attempt that failed before committing, e.g. hitting the per-issue budget cap.
 */
export async function createBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['branch', '-D', branch], { cwd }).catch(() => undefined);
  await execFileAsync('git', ['checkout', '-b', branch], { cwd });
}

/** Checks out an existing branch, used when resuming an issue after a rate-limit retry. */
export async function checkoutBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['checkout', branch], { cwd });
}

/** Returns the current HEAD commit SHA, used to detect whether the agent committed anything. */
export async function currentCommit(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

/** Pushes the branch to `origin`, done by the harness itself rather than the agent. */
export async function pushBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['push', '-u', 'origin', branch], { cwd });
}

/** Opens a PR for the branch via `gh`, referencing the issue so merging closes it. */
export async function openPullRequest(
  repo: string,
  issue: Issue,
  branch: string,
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      repo,
      '--title',
      issue.title,
      '--body',
      `Closes #${issue.number}`,
      '--head',
      branch,
    ],
    { cwd },
  );
  return stdout.trim();
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

/** Reads the PR's current review decision, used to drive the issue-worker/code-reviewer loop. */
export async function getReviewDecision(repo: string, branch: string): Promise<ReviewDecision> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'view',
    branch,
    '--repo',
    repo,
    '--json',
    'reviewDecision',
  ]);
  const { reviewDecision } = JSON.parse(stdout) as { reviewDecision: string | null };
  return (reviewDecision as ReviewDecision) || null;
}

export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * Reads the PR's current state (open/merged/closed). code-reviewer merges directly once it
 * decides a PR is ready (see .claude/agents/code-reviewer.md), so the harness checks this -
 * rather than review decisions alone - to know whether a PR is actually done.
 */
export async function getPullRequestState(repo: string, branch: string): Promise<PullRequestState> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'view',
    branch,
    '--repo',
    repo,
    '--json',
    'state',
  ]);
  const { state } = JSON.parse(stdout) as { state: PullRequestState };
  return state;
}

/** Posts a comment on the issue, used to report processing failures back to GitHub. */
export async function commentOnIssue(repo: string, issue: Issue, body: string): Promise<void> {
  await execFileAsync('gh', [
    'issue',
    'comment',
    String(issue.number),
    '--repo',
    repo,
    '--body',
    body,
  ]);
}
