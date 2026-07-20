import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression test for issue #86: `numberEnv` (src/config.ts) used to coerce any non-numeric
// `.env` value via `Number(value)` without checking for `NaN`, so a typo like
// `MAX_RETRY_COUNT=ten` silently produced `NaN` instead of failing fast. `NaN` then propagates
// into places like retry-count comparisons or `setTimeout` delays, which behave in confusing,
// hard-to-diagnose ways (e.g. `NaN < maxRetryCount` is always `false`) rather than surfacing the
// misconfiguration immediately.

const PROJECT_ROOT = join(import.meta.dirname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const BIN_PATH = join(PROJECT_ROOT, 'bin/everest.js');
const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('numberEnv rejects non-numeric values (issue #86)', () => {
  let tmpRoot: string;
  let envExisted: boolean;
  let envBackup: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-config-invalid-number-'));
    envExisted = existsSync(ENV_PATH);
    envBackup = envExisted ? readFileSync(ENV_PATH, 'utf-8') : '';
    writeFileSync(ENV_PATH, 'GITHUB_REPO=fake/repo\n');
  });

  afterEach(() => {
    if (envExisted) writeFileSync(ENV_PATH, envBackup);
    else rmSync(ENV_PATH, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('fails fast with a clear error instead of silently producing NaN', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'status'], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        GITHUB_REPO: undefined,
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
        GITHUB_REPO: undefined,
        MAX_RETRY_COUNT: '',
        PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Open harness pull requests:');
  });
});
