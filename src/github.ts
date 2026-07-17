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

/**
 * Label code-reviewer applies to signal "not ready, issue-worker needs to address my findings".
 *
 * Not `gh pr review --request-changes`: GitHub rejects that too on your own PR ("Can not
 * request changes on your own pull request"), the same restriction that blocks `--approve`.
 * Only plain comments are allowed on your own PR, so a label is the actual machine-readable
 * signal - the review findings themselves are still posted as a PR comment for a human to read.
 */
export const NEEDS_FIXUP_LABEL = 'needs-fixup';

const HARNESS_BRANCH_ISSUE_PATTERN = /^harness\/issue-(\d+)-/;

export interface ResumablePullRequest {
  branch: string;
  issueNumber: number;
}

/**
 * Finds an open harness PR (branch prefixed `harness/`) labeled {@link NEEDS_FIXUP_LABEL}, so
 * the harness can resume its review loop on restart instead of leaving it stuck. PRs already
 * labeled {@link NEEDS_HUMAN_LABEL} (review budget exhausted) are skipped.
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
    'headRefName,labels',
  ]);
  const prs = JSON.parse(stdout) as Array<{
    headRefName: string;
    labels: Array<{ name: string }>;
  }>;

  for (const pr of prs) {
    const labelNames = pr.labels.map((label) => label.name);
    if (!labelNames.includes(NEEDS_FIXUP_LABEL)) continue;
    if (labelNames.includes(NEEDS_HUMAN_LABEL)) continue;
    const match = HARNESS_BRANCH_ISSUE_PATTERN.exec(pr.headRefName);
    if (!match) continue;
    return { branch: pr.headRefName, issueNumber: Number(match[1]) };
  }
  return null;
}

/** Creates `label` on `repo` if it doesn't exist yet, then adds it to the PR for `branch`. */
async function addLabel(
  repo: string,
  branch: string,
  label: string,
  color: string,
  description: string,
): Promise<void> {
  await execFileAsync('gh', [
    'label',
    'create',
    label,
    '--repo',
    repo,
    '--color',
    color,
    '--description',
    description,
    '--force',
  ]);
  await execFileAsync('gh', ['pr', 'edit', branch, '--repo', repo, '--add-label', label]);
}

/**
 * Labels a PR as needing a fixup pass from issue-worker, used by code-reviewer in place of
 * `gh pr review --request-changes` (blocked on your own PR - see {@link NEEDS_FIXUP_LABEL}).
 */
export async function markPullRequestNeedsFixup(repo: string, branch: string): Promise<void> {
  await addLabel(
    repo,
    branch,
    NEEDS_FIXUP_LABEL,
    'D93F0B',
    'code-reviewer requested changes; issue-worker should address them.',
  );
}

/**
 * Labels a PR as needing human attention, used once the review loop has exhausted its cycle
 * budget without reaching approval.
 */
export async function markPullRequestNeedsHuman(repo: string, branch: string): Promise<void> {
  await addLabel(
    repo,
    branch,
    NEEDS_HUMAN_LABEL,
    'B60205',
    'Needs human intervention, the harness could not resolve this automatically.',
  );
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

/**
 * Commits any uncommitted changes as a checkpoint (harness-authored, not gated by the quality
 * hooks that apply to agent commits - it's explicitly WIP, not a finished unit of work), so
 * progress survives a budget-exhausted sprint instead of being discarded. Returns whether there
 * was anything to commit.
 */
export async function commitWorkInProgress(cwd: string, message: string): Promise<boolean> {
  // Excludes .harness/ (runtime state) via pathspec rather than relying solely on .gitignore -
  // otherwise a missing/misconfigured .gitignore would make the harness "checkpoint" its own
  // state.json as if it were agent work.
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '--', '.', ':!.harness'],
    { cwd },
  );
  if (stdout.trim() === '') return false;

  await setGitIdentity('everest-harness', 'harness@everest.local', cwd);
  await execFileAsync('git', ['add', '-A', '--', '.', ':!.harness'], { cwd });
  await execFileAsync('git', ['commit', '-m', message], { cwd });
  return true;
}

/**
 * Pushes the branch to `origin`, done by the harness itself rather than the agent. `noVerify`
 * skips the repo's Husky `pre-push` hook (lint+test) - needed for WIP checkpoint pushes
 * (`commitWorkInProgress`), which are explicitly incomplete/unvetted by design and would
 * otherwise be rejected by the same quality gate meant for finished agent work.
 */
export async function pushBranch(
  branch: string,
  cwd: string,
  { noVerify = false }: { noVerify?: boolean } = {},
): Promise<void> {
  const args = ['push', '-u', 'origin', branch];
  if (noVerify) args.push('--no-verify');
  await execFileAsync('git', args, { cwd });
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

/**
 * Reads the PR's current labels. Used to check for {@link NEEDS_FIXUP_LABEL} - GitHub's
 * `reviewDecision` can't be used for this since `gh pr review` (approve or request-changes)
 * both fail on your own PR, so `reviewDecision` never becomes `CHANGES_REQUESTED` here.
 */
export async function getPullRequestLabels(repo: string, branch: string): Promise<string[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'view',
    branch,
    '--repo',
    repo,
    '--json',
    'labels',
  ]);
  const { labels } = JSON.parse(stdout) as { labels: Array<{ name: string }> };
  return labels.map((label) => label.name);
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

/**
 * Creates a new GitHub issue via `gh issue create`, used by the `everest ask` CLI command so
 * work can be handed to the harness without dropping into `gh` by hand. When `priority` is set,
 * ensures the corresponding `priority:<level>` label exists (mirroring {@link addLabel}) and
 * applies it, so {@link Issue.labels}-based sorting (see `pickNextIssue` in `src/loop.ts`) picks
 * it up correctly. Returns the URL of the created issue, as printed by `gh`.
 */
export async function createIssue(
  repo: string,
  message: string,
  priority?: string,
): Promise<string> {
  const args = ['issue', 'create', '--repo', repo, '--title', message, '--body', message];

  if (priority) {
    const label = `priority:${priority}`;
    await execFileAsync('gh', [
      'label',
      'create',
      label,
      '--repo',
      repo,
      '--color',
      'BFD4F2',
      '--description',
      `Priority: ${priority}`,
      '--force',
    ]);
    args.push('--label', label);
  }

  const { stdout } = await execFileAsync('gh', args);
  return stdout.trim();
}

/** Status of a harness PR as surfaced by `everest status`, derived from its labels. */
export type HarnessPullRequestStatus = 'open' | 'needs-fixup' | 'needs-human';

export interface HarnessPullRequestSummary {
  number: number;
  branch: string;
  issueNumber: number;
  status: HarnessPullRequestStatus;
}

/**
 * Lists open harness PRs (branch prefixed `harness/issue-<n>-`) with a status derived from their
 * labels (`needs-human` takes precedence over `needs-fixup`, otherwise plain `open`), used by
 * `everest status`.
 */
export async function listHarnessPullRequests(repo: string): Promise<HarnessPullRequestSummary[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,headRefName,labels',
  ]);
  const prs = JSON.parse(stdout) as Array<{
    number: number;
    headRefName: string;
    labels: Array<{ name: string }>;
  }>;

  const summaries: HarnessPullRequestSummary[] = [];
  for (const pr of prs) {
    const match = HARNESS_BRANCH_ISSUE_PATTERN.exec(pr.headRefName);
    if (!match) continue;
    const labelNames = pr.labels.map((label) => label.name);
    const status: HarnessPullRequestStatus = labelNames.includes(NEEDS_HUMAN_LABEL)
      ? 'needs-human'
      : labelNames.includes(NEEDS_FIXUP_LABEL)
        ? 'needs-fixup'
        : 'open';
    summaries.push({
      number: pr.number,
      branch: pr.headRefName,
      issueNumber: Number(match[1]),
      status,
    });
  }
  return summaries;
}

export interface ClosedIssueSummary {
  number: number;
  title: string;
  closedAt: string;
}

/**
 * Lists issues closed within the last `hours` hours, used by `everest status` to show what the
 * harness has recently finished without requiring the caller to page through all closed issues.
 */
export async function listRecentlyClosedIssues(
  repo: string,
  hours: number,
): Promise<ClosedIssueSummary[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'closed',
    '--json',
    'number,title,closedAt',
    '--limit',
    '50',
  ]);
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    closedAt: string | null;
  }>;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return raw
    .filter((issue) => issue.closedAt !== null && new Date(issue.closedAt).getTime() >= cutoff)
    .map((issue) => ({ number: issue.number, title: issue.title, closedAt: issue.closedAt! }));
}

export interface Blocker {
  number: number;
  title: string;
  branch: string;
  lastComment: string | null;
}

/**
 * Lists open PRs labeled {@link NEEDS_HUMAN_LABEL} along with their most recent comment, used by
 * `everest blockers` so a human knows what needs attention and why without opening GitHub.
 */
export async function listBlockers(repo: string): Promise<Blocker[]> {
  const { stdout } = await execFileAsync('gh', [
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--label',
    NEEDS_HUMAN_LABEL,
    '--json',
    'number,title,headRefName,comments',
  ]);
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    comments: Array<{ body: string }>;
  }>;
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    lastComment: pr.comments.length > 0 ? pr.comments[pr.comments.length - 1].body : null,
  }));
}
