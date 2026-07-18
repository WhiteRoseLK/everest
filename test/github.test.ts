import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createBranch,
  deriveIssueTitle,
  commitWorkInProgress,
  splitIntoTopics,
  inferLabels,
  formatIssueBody,
  createIssuesFromMessage,
} from '../src/github.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('createBranch', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'everest-github-test-'));
    git(['init'], repoDir);
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
      repoDir,
    );
    git(['branch', '-m', 'main'], repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates a new branch', async () => {
    await createBranch('feature-x', repoDir);

    const current = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(current).toBe('feature-x');
  });

  it('does not throw when a stale local branch of the same name already exists', async () => {
    // Simulates a previous attempt that created the branch but never pushed it (e.g. it hit the
    // budget cap before committing) - the next attempt must be able to start over cleanly.
    git(['checkout', '-b', 'feature-x'], repoDir);
    git(['checkout', 'main'], repoDir);

    await expect(createBranch('feature-x', repoDir)).resolves.not.toThrow();

    const current = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(current).toBe('feature-x');
  });
});

describe('commitWorkInProgress', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'everest-github-test-'));
    git(['init'], repoDir);
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
      repoDir,
    );
    git(['branch', '-m', 'main'], repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('commits uncommitted changes and returns true', async () => {
    writeFileSync(join(repoDir, 'file.txt'), 'wip content');

    const committed = await commitWorkInProgress(repoDir, 'WIP checkpoint');

    expect(committed).toBe(true);
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim();
    expect(log).toBe('WIP checkpoint');
  });

  it('returns false when there is nothing to commit', async () => {
    const committed = await commitWorkInProgress(repoDir, 'WIP checkpoint');
    expect(committed).toBe(false);
  });

  it('does not throw and excludes .harness/ when it is listed in .gitignore (issue #39)', async () => {
    // Regression test: `git add -A -- . ':!.harness'` fails with "paths are ignored by one of
    // your .gitignore files" once .harness/ is actually covered by .gitignore, because git
    // treats the negated pathspec as an explicit reference to an ignored path.
    writeFileSync(join(repoDir, '.gitignore'), '.harness/\n');
    git(['add', '.gitignore'], repoDir);
    git(
      ['-c', 'user.email=test@test.local', '-c', 'user.name=Test', 'commit', '-m', 'gitignore'],
      repoDir,
    );
    mkdirSync(join(repoDir, '.harness'));
    writeFileSync(join(repoDir, '.harness', 'state.json'), '{}');
    writeFileSync(join(repoDir, 'file.txt'), 'wip content');

    const committed = await commitWorkInProgress(repoDir, 'WIP checkpoint');

    expect(committed).toBe(true);
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    expect(tracked).not.toContain('.harness');
    expect(tracked).toContain('file.txt');
  });

  it('excludes .harness/ from the commit even without a .gitignore entry', async () => {
    mkdirSync(join(repoDir, '.harness'));
    writeFileSync(join(repoDir, '.harness', 'state.json'), '{}');
    writeFileSync(join(repoDir, 'file.txt'), 'wip content');

    const committed = await commitWorkInProgress(repoDir, 'WIP checkpoint');

    expect(committed).toBe(true);
    const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    expect(tracked).not.toContain('.harness');
    expect(tracked).toContain('file.txt');
  });
});

describe('deriveIssueTitle', () => {
  it('returns the message unchanged when it is already short', () => {
    expect(deriveIssueTitle('Add dark mode')).toBe('Add dark mode');
  });

  it('returns "Untitled issue" for an empty message', () => {
    expect(deriveIssueTitle('')).toBe('Untitled issue');
    expect(deriveIssueTitle('   \n more text')).toBe('Untitled issue');
  });

  it('only considers the first line of a multi-line message', () => {
    expect(deriveIssueTitle('Add dark mode\n\nSome longer explanation here.')).toBe(
      'Add dark mode',
    );
  });

  it('cuts at the first sentence boundary when one falls within the limit', () => {
    const message =
      'Fix the bug. It has been crashing the whole app for a while now and nobody noticed.';
    expect(deriveIssueTitle(message)).toBe('Fix the bug.');
  });

  it('truncates at a word boundary with an ellipsis when there is no early sentence break', () => {
    const message =
      'This is a very long single-sentence issue description with no punctuation at all ' +
      'that keeps going well past the eighty character title limit that GitHub effectively ' +
      'enforces for readability';

    const title = deriveIssueTitle(message);

    expect(title.length).toBeLessThanOrEqual(81); // 80 chars + ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(message.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('never produces a title anywhere close to the GitHub 256-character limit', () => {
    const message = 'x'.repeat(5000);

    expect(deriveIssueTitle(message).length).toBeLessThan(256);
  });
});

describe('splitIntoTopics', () => {
  it('returns the trimmed message unchanged when it is plain prose', () => {
    expect(splitIntoTopics('Add dark mode to the settings page')).toEqual([
      'Add dark mode to the settings page',
    ]);
  });

  it('leaves a message with a single list item unsplit', () => {
    expect(splitIntoTopics('Please also:\n- add dark mode')).toEqual([
      'Please also:\n- add dark mode',
    ]);
  });

  it('splits a bulleted list of independent asks into separate topics', () => {
    const message = '- add dark mode\n- fix the flaky login test\n- update the README';
    expect(splitIntoTopics(message)).toEqual([
      'add dark mode',
      'fix the flaky login test',
      'update the README',
    ]);
  });

  it('splits a numbered list and folds continuation lines into the preceding item', () => {
    const message = '1. Add dark mode\n   for the settings page\n2. Fix the flaky login test';
    expect(splitIntoTopics(message)).toEqual([
      'Add dark mode for the settings page',
      'Fix the flaky login test',
    ]);
  });
});

describe('inferLabels', () => {
  it('infers "bug" from crash/error wording', () => {
    expect(inferLabels('The app crashes every time I click submit')).toEqual(['bug']);
  });

  it('infers "documentation" from docs/readme wording', () => {
    expect(inferLabels('The README is out of date, please update the docs')).toEqual([
      'documentation',
    ]);
  });

  it('infers "question" from a message phrased as a question', () => {
    expect(inferLabels('Why does the retry loop use exponential backoff?')).toEqual(['question']);
  });

  it('defaults to "enhancement" when nothing else matches', () => {
    expect(inferLabels('Add dark mode to the settings page')).toEqual(['enhancement']);
  });

  it('adds priority:critical for urgent/blocking wording', () => {
    expect(inferLabels('This is urgent, it breaks production')).toEqual([
      'enhancement',
      'priority:critical',
    ]);
  });

  it('adds priority:high for important/soon wording', () => {
    expect(inferLabels('This is important, please do it soon')).toEqual([
      'enhancement',
      'priority:high',
    ]);
  });
});

describe('formatIssueBody', () => {
  it('wraps the topic under a Request heading with no related issues', () => {
    const body = formatIssueBody('Add dark mode');
    expect(body).toContain('## Request');
    expect(body).toContain('Add dark mode');
    expect(body).not.toContain('see also');
  });

  it('cross-links related issues when provided', () => {
    const body = formatIssueBody('Add dark mode', [12, 13]);
    expect(body).toContain('see also #12, #13');
  });
});

describe('createIssuesFromMessage', () => {
  let originalPath: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-create-issues-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_ISSUE_CREATE_MARKER;
    delete process.env.FAKE_GH_COMMENT_MARKER;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates a single issue with an inferred label when the message is not a list', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;

    const created = await createIssuesFromMessage('fake/repo', 'The app crashes on submit');

    expect(created).toHaveLength(1);
    const args = readFileSync(marker, 'utf-8');
    expect(args).toContain('--label bug');
    expect(args).toContain('## Request');
  });

  it('lets an explicit priority override the inferred one', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;

    await createIssuesFromMessage('fake/repo', 'This is urgent, please fix', 'low');

    const args = readFileSync(marker, 'utf-8');
    expect(args).toContain('--label priority:low');
    expect(args).not.toContain('priority:critical');
  });

  it('splits a bulleted multi-topic message into separate cross-linked issues', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    const commentMarker = join(tmpRoot, 'comment.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;
    process.env.FAKE_GH_COMMENT_MARKER = commentMarker;

    const message = '- add dark mode\n- fix the flaky login test';
    const created = await createIssuesFromMessage('fake/repo', message);

    expect(created).toHaveLength(2);
    const createCalls = readFileSync(marker, 'utf-8')
      .split('---FAKE_GH_ISSUE_CREATE_END---')
      .map((call) => call.trim())
      .filter((call) => call.length > 0);
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]).toContain('add dark mode');
    expect(createCalls[1]).toContain('fix the flaky login test');

    expect(existsSync(commentMarker)).toBe(true);
    const comments = readFileSync(commentMarker, 'utf-8');
    expect(comments).toContain('see also');
    expect(comments).toContain(String(created[0].number));
    expect(comments).toContain(String(created[1].number));
  });
});
