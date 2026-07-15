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

export async function listOpenIssues(repo: string): Promise<Issue[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--json', 'number,title,labels,createdAt',
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

export function branchNameFor(issue: Issue): string {
  return `harness/issue-${issue.number}-${slugify(issue.title)}`;
}

export async function createBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', branch], { cwd });
}

export async function checkoutBranch(branch: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['checkout', branch], { cwd });
}

export async function currentCommit(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

export async function openPullRequest(
  repo: string,
  issue: Issue,
  branch: string,
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'create',
    '--repo', repo,
    '--title', issue.title,
    '--body', `Closes #${issue.number}`,
    '--head', branch,
  ], { cwd });
  return stdout.trim();
}

export async function commentOnIssue(repo: string, issue: Issue, body: string): Promise<void> {
  await execFileAsync('gh', [
    'issue', 'comment', String(issue.number),
    '--repo', repo,
    '--body', body,
  ]);
}
