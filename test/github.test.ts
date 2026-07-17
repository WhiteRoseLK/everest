import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBranch } from '../src/github.js';

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
