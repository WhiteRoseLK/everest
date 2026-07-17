import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Directory (relative to the primary checkout) under which per-issue worktrees are created. */
const WORKTREES_DIR = '.worktrees';

/**
 * Creates an isolated git worktree, checked out on a new branch off `main`, so an issue can be
 * processed without sharing a working directory with other issues running concurrently. `cwd` is
 * the primary checkout (the one `main` lives in); callers should have it up to date (see
 * `checkoutMain`) before calling this. Returns the absolute path to the new worktree.
 */
export async function createWorktree(branch: string, cwd: string): Promise<string> {
  const path = join(cwd, WORKTREES_DIR, branch);
  await execFileAsync('git', ['worktree', 'add', '-b', branch, path, 'main'], { cwd });
  return path;
}

/**
 * Removes a worktree created by {@link createWorktree} and prunes its metadata, freeing the
 * directory for reuse. `--force` is used because the branch may still hold uncommitted or
 * unpushed state after a failed run - cleanup should not depend on it being pristine.
 */
export async function removeWorktree(worktreePath: string, cwd: string): Promise<void> {
  await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd });
}
