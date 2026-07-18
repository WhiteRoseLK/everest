import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBranch, deriveIssueTitle } from '../src/github.js';

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
