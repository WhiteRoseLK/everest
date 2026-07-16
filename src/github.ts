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

/** Creates and checks out a new branch for an issue being processed for the first time. */
export async function createBranch(branch: string, cwd: string): Promise<void> {
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
