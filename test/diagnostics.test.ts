import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordIterationError,
  loadIterationErrors,
  checkHarnessWritable,
  checkGitWritable,
} from '../src/diagnostics.js';

// chmod-based permission tests are meaningless as root (root bypasses file permissions), so skip
// them there rather than letting them fail spuriously in a root context.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('diagnostics', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'everest-diag-'));
  });

  afterEach(() => {
    // Restore write perms first so a test that chmod'd .harness/.git read-only can be cleaned up.
    try {
      chmodSync(join(cwd, '.harness'), 0o755);
    } catch {
      // ignore - .harness may not exist for every test
    }
    try {
      chmodSync(join(cwd, '.git'), 0o755);
    } catch {
      // ignore - .git may not exist for every test
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  it('persists an Error with message and stack, and reads it back', () => {
    recordIterationError(new Error('boom'), cwd);
    const errors = loadIterationErrors(cwd);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('boom');
    expect(errors[0].stack).toContain('boom');
    expect(errors[0].timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('persists a non-Error thrown value via String()', () => {
    recordIterationError('just a string', cwd);
    const errors = loadIterationErrors(cwd);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('just a string');
    expect(errors[0].stack).toBeUndefined();
  });

  it('appends across calls and returns them newest-last', () => {
    recordIterationError(new Error('first'), cwd);
    recordIterationError(new Error('second'), cwd);
    const errors = loadIterationErrors(cwd);
    expect(errors.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('caps the returned errors to the requested limit, keeping the most recent', () => {
    for (let i = 0; i < 5; i += 1) recordIterationError(new Error(`err-${i}`), cwd);
    const errors = loadIterationErrors(cwd, 2);
    expect(errors.map((e) => e.message)).toEqual(['err-3', 'err-4']);
  });

  it('returns an empty array when no errors have been recorded', () => {
    expect(loadIterationErrors(cwd)).toEqual([]);
  });

  it('skips a corrupt/truncated line instead of throwing', () => {
    mkdirSync(join(cwd, '.harness'), { recursive: true });
    writeFileSync(
      join(cwd, '.harness/errors.jsonl'),
      `${JSON.stringify({ timestamp: 't', message: 'good' })}\n{ this is not json\n`,
    );
    const errors = loadIterationErrors(cwd);
    expect(errors.map((e) => e.message)).toEqual(['good']);
  });

  it.skipIf(isRoot)('never throws when .harness/ is not writable, and reports it on stderr', () => {
    mkdirSync(join(cwd, '.harness'), { recursive: true });
    chmodSync(join(cwd, '.harness'), 0o500); // read+execute, no write
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => recordIterationError(new Error('boom'), cwd)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist an iteration error'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('checkHarnessWritable reports writable for a normal directory', () => {
    expect(checkHarnessWritable(cwd)).toEqual({ writable: true });
  });

  it.skipIf(isRoot)(
    'checkHarnessWritable reports not-writable with an error for a read-only .harness/',
    () => {
      mkdirSync(join(cwd, '.harness'), { recursive: true });
      chmodSync(join(cwd, '.harness'), 0o500);
      const result = checkHarnessWritable(cwd);
      expect(result.writable).toBe(false);
      expect(result.error).toBeTruthy();
    },
  );

  it('checkGitWritable reports not-writable when .git does not exist', () => {
    const result = checkGitWritable(cwd);
    expect(result.writable).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('checkGitWritable reports writable for a normal .git directory', () => {
    mkdirSync(join(cwd, '.git'), { recursive: true });
    expect(checkGitWritable(cwd)).toEqual({ writable: true });
  });

  it.skipIf(isRoot)('checkGitWritable reports not-writable for a read-only .git', () => {
    mkdirSync(join(cwd, '.git'), { recursive: true });
    chmodSync(join(cwd, '.git'), 0o500);
    const result = checkGitWritable(cwd);
    expect(result.writable).toBe(false);
    expect(result.error).toBeTruthy();
    chmodSync(join(cwd, '.git'), 0o755); // restore so afterEach can clean up
  });
});
