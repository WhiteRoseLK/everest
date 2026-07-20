import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Exercises docker-entrypoint.sh directly (issue #84). There's no Docker daemon in the test
 * sandbox, so instead of spinning up the container we run the script with fake `id`, `find`, and
 * `gosu` binaries on PATH and assert on what it does: as root it realigns /app ownership (a `find
 * ... -exec chown node:node` pass) then drops to node via gosu; as a non-root user it just execs
 * the command unchanged. `find` is faked (rather than run for real) so the test doesn't depend on
 * BSD-vs-GNU `find` flags or on /app existing - the exact incantation is covered separately by a
 * content assertion in docker-compose.test.ts.
 */
const ENTRYPOINT = join(import.meta.dirname, '../docker-entrypoint.sh');

describe('docker-entrypoint.sh', () => {
  let fakeBin: string;
  let findMarker: string;
  let gosuMarker: string;

  function writeFake(name: string, body: string): void {
    const path = join(fakeBin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'everest-entrypoint-'));
    findMarker = join(fakeBin, 'find.marker');
    gosuMarker = join(fakeBin, 'gosu.marker');
    // Records the full argv the entrypoint passes to `find` (which carries the `-exec chown
    // node:node` realignment), then succeeds without touching the real filesystem.
    writeFake('find', `#!/usr/bin/env bash\necho "$*" > "${findMarker}"\nexit 0\n`);
    // gosu records "<user> <cmd...>" then runs the command, so the entrypoint's exec chain still
    // completes and the script's own exit code reflects the delegated command.
    writeFake('gosu', `#!/usr/bin/env bash\necho "$*" > "${gosuMarker}"\nshift\nexec "$@"\n`);
  });

  afterEach(() => {
    rmSync(fakeBin, { recursive: true, force: true });
  });

  function runAs(uid: string, args: string[]): string {
    // A fake `id` forces the uid branch deterministically, without the test needing to be root.
    writeFake('id', `#!/usr/bin/env bash\nif [ "$1" = "-u" ]; then echo "${uid}"; fi\nexit 0\n`);
    return execFileSync('bash', [ENTRYPOINT, ...args], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: 'utf-8',
    });
  }

  it('as root: realigns /app ownership to node then drops to node via gosu before running the command', () => {
    const output = runAs('0', ['echo', 'started']);

    expect(existsSync(findMarker)).toBe(true);
    const findArgs = readFileSync(findMarker, 'utf-8');
    expect(findArgs).toContain('/app');
    expect(findArgs).toContain('chown node:node');
    expect(existsSync(gosuMarker)).toBe(true);
    // gosu was handed the target user `node` followed by the actual command.
    expect(readFileSync(gosuMarker, 'utf-8')).toMatch(/^node echo started/);
    expect(output).toContain('started');
  });

  it('as a non-root user: runs the command directly, without realignment or gosu', () => {
    const output = runAs('1000', ['echo', 'direct']);

    expect(existsSync(findMarker)).toBe(false);
    expect(existsSync(gosuMarker)).toBe(false);
    expect(output).toContain('direct');
  });

  it('propagates the command exit code (non-root path)', () => {
    // `id` = non-root so it execs the command directly; `false` exits 1.
    expect(() => runAs('1000', ['false'])).toThrowError();
  });
});
