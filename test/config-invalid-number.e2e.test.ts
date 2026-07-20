import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression test for issue #86: `numberEnv` (src/config.ts) used to coerce any non-numeric
// `.env` value via `Number(value)` without checking for `NaN`, so a typo like
// `MAX_RETRY_COUNT=ten` silently produced `NaN` instead of failing fast. `NaN` then propagates
// into places like retry-count comparisons or `setTimeout` delays, which behave in confusing,
// hard-to-diagnose ways (e.g. `NaN < maxRetryCount` is always `false`) rather than surfacing the
// misconfiguration immediately.
//
// Deliberately does not touch the shared project-root `.env` file (unlike
// `test/config.e2e.test.ts`, which needs it to test `.env` resolution itself): vitest runs
// separate test files concurrently by default, so two files both mutating the same `.env` in
// `beforeEach`/`afterEach` race on read/write and produce intermittent failures (observed on
// this issue's first PR revision). `process.env` values always win over `.env` per dotenv's
// default precedence, so passing `GITHUB_REPO`/`MAX_RETRY_COUNT` directly via `spawnSync`'s
// `env` option is sufficient here and avoids the shared-file mutation entirely.

const PROJECT_ROOT = join(import.meta.dirname, '..');
const BIN_PATH = join(PROJECT_ROOT, 'bin/everest.js');
const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('numberEnv rejects non-numeric values (issue #86)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-config-invalid-number-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fails fast with a clear error instead of silently producing NaN', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'status'], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        GITHUB_REPO: 'fake/repo',
        MAX_RETRY_COUNT: 'ten',
        PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid value for env var MAX_RETRY_COUNT');
  });

  it('still falls back to the default when the env var is unset or empty', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'status'], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        GITHUB_REPO: 'fake/repo',
        MAX_RETRY_COUNT: '',
        PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Open harness pull requests:');
  });
});
