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

/**
 * Creates `label` on `repo` if it doesn't exist yet, then adds it to a PR (`target.type === 'pr'`,
 * `target.ref` is the branch) or an issue (`target.type === 'issue'`, `target.ref` is the issue
 * number as a string) via `gh pr edit`/`gh issue edit` respectively.
 */
async function addLabel(
  repo: string,
  target: { type: 'pr' | 'issue'; ref: string },
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
  await execFileAsync('gh', [
    target.type,
    'edit',
    target.ref,
    '--repo',
    repo,
    '--add-label',
    label,
  ]);
}

/**
 * Labels a PR as needing a fixup pass from issue-worker, used by code-reviewer in place of
 * `gh pr review --request-changes` (blocked on your own PR - see {@link NEEDS_FIXUP_LABEL}).
 */
export async function markPullRequestNeedsFixup(repo: string, branch: string): Promise<void> {
  await addLabel(
    repo,
    { type: 'pr', ref: branch },
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
    { type: 'pr', ref: branch },
    NEEDS_HUMAN_LABEL,
    'B60205',
    'Needs human intervention, the harness could not resolve this automatically.',
  );
}

/**
 * Labels the issue itself (not just a PR) as needing human attention. Applied wherever the
 * harness gives up on an issue and posts an "intervention humaine nécessaire" comment
 * ({@link retryFreshSprintOrGiveUp} in loop.ts and its callers): without it, an issue that never
 * got as far as opening a PR was invisible to {@link hasOpenPullRequest} and kept getting picked
 * up again on every poll, burning a full sprint per cycle for no benefit until a human noticed -
 * see issue #60. {@link listOpenIssues} already returns each issue's labels, so filtering these
 * out is a plain in-memory check (see `filterOutIssuesNeedingHuman` in loop.ts), no extra API call
 * needed.
 */
export async function markIssueNeedsHuman(repo: string, issue: Issue): Promise<void> {
  await addLabel(
    repo,
    { type: 'issue', ref: String(issue.number) },
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
 * Fetches and returns the current commit SHA of `origin/main`, without touching the local
 * checkout (unlike {@link checkoutMain}). Used to detect when `origin/main` has advanced past
 * the commit that was live when this process started, so the harness can restart itself and
 * pick up merged code changes instead of running stale, already-loaded modules forever - ESM
 * only loads a module once per process, so `git pull` alone never takes effect (see issue #43).
 */
export async function remoteMainCommit(cwd: string): Promise<string> {
  await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'origin/main'], { cwd });
  return stdout.trim();
}

/**
 * Prefix used for harness-authored WIP checkpoint commit messages (see
 * {@link commitWorkInProgress}). Shared with {@link isUnpushedCommitWipCheckpoint} so a retried
 * push (see {@link hasUnpushedCommit}) can tell whether it needs `--no-verify`, matching whichever
 * flag the original, failed push attempt used.
 */
export const WIP_CHECKPOINT_PREFIX = 'WIP checkpoint:';

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
  // `git add -A -- . ':!.harness'` fails with "paths are ignored by one of your .gitignore
  // files" once .harness/ is actually listed in .gitignore (git treats the negated pathspec as
  // an explicit reference to an ignored path and refuses it, even though it's an exclusion, not
  // an inclusion). Add everything (.gitignore already keeps .harness/ out in the normal case),
  // then explicitly unstage .harness/ as a fallback for a missing/misconfigured .gitignore -
  // `git reset` doesn't error on paths that were never staged.
  await execFileAsync('git', ['add', '-A', '--', '.'], { cwd });
  await execFileAsync('git', ['reset', '--', '.harness'], { cwd }).catch(() => undefined);
  // `--no-verify` skips the repo's Husky `pre-commit` hook (lint+test, added in issue #85 as the
  // non-bypassable backstop for enforce-quality-before-commit.sh) - required here for the same
  // reason `pushBranch`'s `noVerify` skips `pre-push`: this checkpoint is explicitly
  // incomplete/unvetted by design and must survive even when lint/test are currently failing.
  await execFileAsync('git', ['commit', '--no-verify', '-m', message], { cwd });
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

/**
 * Matches GitHub's rejection message for a push that touches `.github/workflows/*` without the
 * OAuth `workflow` scope on the pushing token/PAT, e.g.:
 * `refusing to allow an OAuth App to create or update workflow \`.github/workflows/ci.yml\`
 * without \`workflow\` scope`. Used by {@link isMissingWorkflowScopeError}.
 */
const WORKFLOW_SCOPE_ERROR_PATTERN =
  /refusing to allow an OAuth App to create or update workflow.*without\s+`workflow`\s+scope/is;

/**
 * Detects whether a failed `git push` (as thrown by {@link pushBranch}) was rejected specifically
 * because `GH_TOKEN` lacks the OAuth `workflow` scope required to touch `.github/workflows/*`
 * (see issue #55). Unlike a transient network blip or a flaky server-side hook, this rejection is
 * deterministic - it fails identically on every retry until a human regenerates the token with
 * the scope added - so callers can skip the bounded retry loop entirely and escalate straight to
 * a human instead of burning `maxRetryCount` sprints on a push that can never succeed.
 */
export function isMissingWorkflowScopeError(error: unknown): boolean {
  const stderr =
    error !== null && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
  return WORKFLOW_SCOPE_ERROR_PATTERN.test(stderr);
}

/**
 * Returns whether `branch`'s local HEAD already carries a commit that `origin` doesn't have yet
 * - either because `origin` has no ref for the branch at all, or its ref points somewhere else.
 * Lets callers tell "a prior sprint's commit is already correct/complete but stuck locally
 * because its push failed" apart from "no commit exists yet on this branch" (fresh branch, or a
 * sprint that genuinely produced nothing): re-invoking issue-worker in the former case finds
 * nothing left to do and misreports "no new commit produced" for work that was actually already
 * finished - see issue #61. Returns `false` when HEAD matches `origin/main`, i.e. no commit has
 * been made on the branch yet.
 */
export async function hasUnpushedCommit(branch: string, cwd: string): Promise<boolean> {
  const [local, main] = await Promise.all([currentCommit(cwd), remoteMainCommit(cwd)]);
  if (local === main) return false;

  const { stdout } = await execFileAsync('git', ['ls-remote', 'origin', branch], { cwd });
  const remote = stdout.split(/\s+/)[0]?.trim() ?? '';
  return remote !== local;
}

/**
 * Returns whether the branch's current HEAD is a harness-authored WIP checkpoint commit (see
 * {@link commitWorkInProgress}) rather than a finished commit produced by issue-worker. Used
 * alongside {@link hasUnpushedCommit} to decide whether retrying its push needs `--no-verify`,
 * matching whichever flag the original (failed) push attempt used.
 */
export async function isUnpushedCommitWipCheckpoint(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s'], { cwd });
  return stdout.trim().startsWith(WIP_CHECKPOINT_PREFIX);
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
 * Maximum length (in characters) of a title derived by {@link deriveIssueTitle}. Well under
 * GitHub's 256-character hard limit, but generous enough to keep the first sentence/clause of
 * most messages intact.
 */
const MAX_ISSUE_TITLE_LENGTH = 80;

/**
 * Matches a leading filler phrase (`"please"`, `"so"`, `"I think"`, `"could you"`, ...) that adds
 * no information to a title, so {@link deriveIssueTitle} can strip it before truncating. This is
 * still a heuristic, not real summarization (see issue #44) — it only removes conversational
 * throat-clearing so the truncation/sentence-boundary logic below has more of the actual content
 * to work with, rather than spending the character budget on words like "please".
 */
const FILLER_PREFIX_PATTERN =
  /^(?:please|so|hey|well|i think|i believe|i guess|you know|just wanted to (?:say|mention|note) that|it would be (?:nice|great) if|can you|could you|we should|you should)\b[,:]?\s+/i;

/**
 * Derives a short issue title from a free-form message, so `gh issue create --title` never
 * receives the full (potentially very long) message — GitHub rejects titles over 256 characters
 * with "Title is too long". This remains a deterministic truncation heuristic, not real LLM
 * summarization (tracked as a known limitation in issue #44 for callers with no LLM in the loop,
 * e.g. the plain non-chat `everest ask` CLI path) — callers that do have judgment available (the
 * `chat` agent) should compose a title themselves and pass it explicitly instead (see
 * {@link createIssuesFromMessage}'s `title` parameter). Strips a leading filler phrase (see
 * {@link FILLER_PREFIX_PATTERN}), then uses the first line, cut at the first sentence boundary
 * (`.`, `!`, `?`) if one falls within {@link MAX_ISSUE_TITLE_LENGTH}, otherwise truncated at the
 * nearest word boundary with an ellipsis appended.
 */
export function deriveIssueTitle(message: string): string {
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return 'Untitled issue';

  let stripped = firstLine;
  // Repeats since fillers are sometimes chained ("so I think we should add dark mode"): a single
  // pass would only remove "so ", leaving "I think we should ..." still in the title.
  while (true) {
    const next = stripped.replace(FILLER_PREFIX_PATTERN, '').trim();
    if (next === stripped) break;
    stripped = next;
  }
  const candidate =
    stripped.length > 0 ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : firstLine;
  if (candidate.length <= MAX_ISSUE_TITLE_LENGTH) return candidate;

  const truncated = candidate.slice(0, MAX_ISSUE_TITLE_LENGTH);
  const sentenceEnd = /[.!?]/.exec(truncated);
  if (sentenceEnd) return truncated.slice(0, sentenceEnd.index + 1);

  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trimEnd()}…`;
}

/**
 * Matches a single line that opens a bullet or numbered list item (`- `, `* `, `1.`, `2)`, ...),
 * capturing the item's text. Used by {@link splitIntoTopics} to recognize a free-form message
 * that bundles several independent asks into one list rather than prose.
 */
const LIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/;

/**
 * Splits a free-form message into independent topics when it's clearly a list of separate asks
 * (each line starting with `-`, `*`, or `1.`/`1)`), so {@link createIssuesFromMessage} can file
 * one issue per topic instead of one oversized issue bundling unrelated work (see issue #38).
 * Continuation lines (non-empty, non-list lines following a list item) are appended to that
 * item, so a topic can still wrap across multiple lines. Returns a single-element array
 * containing the trimmed original message when fewer than two list items are found — this is a
 * heuristic, not a guarantee every multi-topic message gets split, so plain prose without list
 * markers is always left as one issue.
 */
export function splitIntoTopics(message: string): string[] {
  const lines = message.split('\n');
  const items: string[] = [];
  let inList = false;

  for (const line of lines) {
    const match = LIST_ITEM_PATTERN.exec(line);
    if (match) {
      inList = true;
      items.push(match[1].trim());
    } else if (inList && line.trim() !== '') {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    }
  }

  if (items.length < 2) return [message.trim()];
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** Keyword patterns used by {@link inferLabels} to guess the right `type` label for a message. */
const BUG_PATTERN = /\b(bug|broken|crash(?:es|ing)?|fails?|failing|error|regression)\b/i;
const DOCS_PATTERN = /\b(docs?|documentation|readme|typo)\b/i;
const QUESTION_PATTERN = /\?\s*$|^\s*(why|how|what|when|should|does|is it possible)\b/i;
const CRITICAL_URGENCY_PATTERN = /\b(urgent|asap|critical|blocking|breaks? production)\b/i;
const HIGH_URGENCY_PATTERN = /\b(important|high priority|soon)\b/i;

/**
 * Colors/descriptions for the labels {@link inferLabels} can produce, used to `gh label create
 * --force` each one before applying it (idempotent - creates it if missing, updates it to this
 * canonical color/description if it already exists) so `gh issue create --label` never fails on
 * a nonexistent label.
 */
const LABEL_METADATA: Record<string, { color: string; description: string }> = {
  bug: { color: 'd73a4a', description: "Something isn't working" },
  enhancement: { color: 'a2eeef', description: 'New feature or request' },
  documentation: { color: '0075ca', description: 'Improvements or additions to documentation' },
  question: { color: 'd876e3', description: 'Further information is requested' },
};

/**
 * Infers which existing repo labels apply to a free-form message: exactly one `type` label
 * (`bug`, `documentation`, `question`, defaulting to `enhancement` when nothing else matches) and
 * optionally a `priority:<level>` label when the wording implies urgency (`urgent`/`critical` →
 * `priority:critical`, `important`/`soon` → `priority:high`). Used by
 * {@link createIssuesFromMessage} so `everest ask` no longer requires `--priority` to be passed
 * by hand to get a reasonable label, per issue #38. Keyword-based, not exhaustive - explicit
 * `--priority` always takes precedence over the inferred one (see
 * {@link createIssuesFromMessage}).
 */
export function inferLabels(message: string): string[] {
  const labels: string[] = [];
  if (BUG_PATTERN.test(message)) labels.push('bug');
  else if (DOCS_PATTERN.test(message)) labels.push('documentation');
  else if (QUESTION_PATTERN.test(message)) labels.push('question');
  else labels.push('enhancement');

  if (CRITICAL_URGENCY_PATTERN.test(message)) labels.push('priority:critical');
  else if (HIGH_URGENCY_PATTERN.test(message)) labels.push('priority:high');

  return labels;
}

/**
 * Ensures `label` exists on `repo` (creating or updating it via `gh label create --force`) then
 * returns it unchanged, so callers can chain this into a `--label` argument list. `priority:*`
 * labels use a shared blue/`Priority: <level>` convention since they're generated, not one of the
 * fixed {@link LABEL_METADATA} entries.
 */
async function ensureLabelExists(repo: string, label: string): Promise<string> {
  const metadata = LABEL_METADATA[label];
  const [color, description] = metadata
    ? [metadata.color, metadata.description]
    : label.startsWith('priority:')
      ? ['BFD4F2', `Priority: ${label.slice('priority:'.length)}`]
      : ['ededed', label];

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
  return label;
}

/**
 * Formats a topic (a full message, or one item from {@link splitIntoTopics}) into a structured
 * issue body instead of dumping raw text with no scaffolding, per issue #38. `relatedIssues`
 * cross-links sibling issues created from the same originally-bundled request (see
 * {@link createIssuesFromMessage}), so context isn't lost when a multi-topic message gets split.
 */
export function formatIssueBody(topic: string, relatedIssues: number[] = []): string {
  const lines = ['## Request', '', topic];
  if (relatedIssues.length > 0) {
    lines.push(
      '',
      '---',
      `Part of a split multi-topic request — see also ${relatedIssues.map((n) => `#${n}`).join(', ')}.`,
    );
  }
  lines.push('', '---', 'Filed via `everest ask`.');
  return lines.join('\n');
}

/**
 * Creates a new GitHub issue via `gh issue create` with an already-resolved title/body/labels.
 * Internal building block for {@link createIssuesFromMessage}; ensures every label exists first
 * (see {@link ensureLabelExists}) so the `--label` flags never fail on a nonexistent label.
 * Returns the created issue's number (parsed from the URL `gh` prints) and that URL.
 */
async function createIssueRaw(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<{ number: number; url: string }> {
  for (const label of labels) await ensureLabelExists(repo, label);

  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  for (const label of labels) args.push('--label', label);

  const { stdout } = await execFileAsync('gh', args);
  const url = stdout.trim();
  const match = /\/issues\/(\d+)/.exec(url);
  return { number: match ? Number(match[1]) : NaN, url };
}

/**
 * Creates a new GitHub issue via `gh issue create`, used by the `everest ask` CLI command so
 * work can be handed to the harness without dropping into `gh` by hand. The title is derived
 * from `message` via {@link deriveIssueTitle} (never the full message — see that function's
 * doc) while the full `message` is always used as the issue body. When `priority` is set,
 * ensures the corresponding `priority:<level>` label exists (mirroring {@link ensureLabelExists})
 * and applies it, so {@link Issue.labels}-based sorting (see `pickNextIssue` in `src/loop.ts`)
 * picks it up correctly. Returns the URL of the created issue, as printed by `gh`.
 */
export async function createIssue(
  repo: string,
  message: string,
  priority?: string,
): Promise<string> {
  const labels = priority ? [`priority:${priority}`] : [];
  const { url } = await createIssueRaw(repo, deriveIssueTitle(message), message, labels);
  return url;
}

/** One issue created by {@link createIssuesFromMessage}: its number and the URL `gh` printed. */
export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * Files one or more GitHub issues from a free-form message, applying the title/label/splitting
 * improvements from issue #38 instead of the bare {@link createIssue}: title via
 * {@link deriveIssueTitle} unless `title` is given explicitly (see below), a structured body via
 * {@link formatIssueBody}, type/priority labels via {@link inferLabels} (an explicit `priority`
 * argument, e.g. from `everest ask --priority`, overrides the inferred priority rather than
 * stacking with it), and - when `message` bundles multiple independent asks as a list (see
 * {@link splitIntoTopics}) - one issue per topic, cross-linked via a follow-up comment on each
 * ("see also #x, #y") so the split context isn't lost. Used by `runAsk` (`src/cli.ts`); the
 * single-issue path stays available as {@link createIssue} for callers that don't want
 * inference/splitting.
 *
 * `title`, when given, is used verbatim instead of the {@link deriveIssueTitle} heuristic — this
 * is how callers with actual judgment available (e.g. the `chat` agent, which is a live LLM
 * session unlike the plain non-interactive `everest ask` CLI path) can give a real summarized
 * title instead of a truncated one (see issue #44). Only applies when `message` resolves to a
 * single topic: an explicit title can't sensibly apply to every issue from a multi-topic split,
 * so it's ignored (with a warning) and each topic falls back to its own derived title.
 */
export async function createIssuesFromMessage(
  repo: string,
  message: string,
  priority?: string,
  title?: string,
): Promise<CreatedIssue[]> {
  const topics = splitIntoTopics(message);
  const explicitTitle = title?.trim();
  if (explicitTitle && topics.length > 1) {
    console.error(
      'everest ask: --title is ignored for a message that splits into multiple issues; ' +
        'each topic uses its own derived title instead.',
    );
  }
  const created: CreatedIssue[] = [];

  for (const topic of topics) {
    const inferred = inferLabels(topic);
    const labels = inferred.filter((label) => !label.startsWith('priority:'));
    const priorityLabel = priority
      ? `priority:${priority}`
      : inferred.find((label) => label.startsWith('priority:'));
    if (priorityLabel) labels.push(priorityLabel);

    const issueTitle =
      explicitTitle && topics.length === 1 ? explicitTitle : deriveIssueTitle(topic);
    const issue = await createIssueRaw(repo, issueTitle, formatIssueBody(topic), labels);
    created.push(issue);
  }

  if (created.length > 1) {
    for (const issue of created) {
      const others = created
        .filter((other) => other.number !== issue.number)
        .map((other) => other.number);
      if (others.length === 0 || Number.isNaN(issue.number)) continue;
      await execFileAsync('gh', [
        'issue',
        'comment',
        String(issue.number),
        '--repo',
        repo,
        '--body',
        `Part of a split multi-topic request — see also ${others.map((n) => `#${n}`).join(', ')}.`,
      ]);
    }
  }

  return created;
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

export interface OpenedIssueSummary {
  number: number;
  title: string;
  createdAt: string;
}

/**
 * Lists issues opened since `sinceIso`, used by `everest catchup` (see `src/catchup.ts`) to
 * surface new work filed since the user last checked in - including issues issue-worker itself
 * opens as out-of-scope discoveries during the self-improvement loop (see CLAUDE.md's
 * Architecture Overview). There's no reliable way to attribute *who* opened an issue via the
 * `gh` CLI - issue-worker and `everest ask` both create issues under the same GH_TOKEN-owned
 * account (see CLAUDE.md's Agent Identities) - so this simply lists everything opened in the
 * window without claiming a specific author.
 */
export async function listIssuesOpenedSince(
  repo: string,
  sinceIso: string,
): Promise<OpenedIssueSummary[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,createdAt',
    '--limit',
    '50',
  ]);
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    createdAt: string;
  }>;
  const cutoff = new Date(sinceIso).getTime();
  return raw.filter((issue) => new Date(issue.createdAt).getTime() >= cutoff);
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
