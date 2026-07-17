import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regression test for issue #31: `everest` (installed globally via `npm link`) used to load
// `.env` via `dotenv/config`, which resolves relative to `process.cwd()`. Invoking `everest`
// from any directory other than the project root then failed with "Missing required env var:
// GITHUB_REPO" even though `.env` existed at the project root. `src/config.ts` must resolve
// `.env` relative to its own module location instead.

const PROJECT_ROOT = join(import.meta.dirname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const BIN_PATH = join(PROJECT_ROOT, 'bin/everest.js');
const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('config .env resolution (issue #31)', () => {
  let tmpRoot: string;
  let envExisted: boolean;
  let envBackup: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-config-e2e-'));
    envExisted = existsSync(ENV_PATH);
    envBackup = envExisted ? readFileSync(ENV_PATH, 'utf-8') : '';
    writeFileSync(ENV_PATH, 'GITHUB_REPO=fake/repo\n');
  });

  afterEach(() => {
    if (envExisted) writeFileSync(ENV_PATH, envBackup);
    else rmSync(ENV_PATH, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads .env relative to the project root, not the invoking cwd', () => {
    const envWithoutRepo = { ...process.env };
    delete envWithoutRepo.GITHUB_REPO;

    const result = spawnSync(process.execPath, [BIN_PATH, 'status'], {
      cwd: tmpRoot,
      env: { ...envWithoutRepo, PATH: `${FAKE_BIN}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8',
    });

    expect(result.stderr).not.toContain('Missing required env var: GITHUB_REPO');
    expect(result.stdout).toContain('Open harness pull requests:');
    expect(result.status).toBe(0);
  });
});
