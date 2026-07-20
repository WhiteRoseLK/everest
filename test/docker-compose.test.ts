import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for issue #63: Claude Code's onboarding/config state (~/.claude, theme
 * choice, etc.) must survive `harness` container *recreation* (image rebuild, `docker compose
 * down`/`up`), not just a restart. That requires a named volume mounted on the `node` user's
 * home directory in `docker-compose.yml`, since the container's own filesystem is discarded on
 * recreation. There is no Docker daemon available in the test sandbox to actually spin up the
 * service, so this asserts the compose file is wired correctly instead.
 */
describe('docker-compose.yml', () => {
  const composeFile = readFileSync(join(import.meta.dirname, '../docker-compose.yml'), 'utf-8');

  it('mounts a named volume on the node user home directory for the harness service', () => {
    expect(composeFile).toMatch(/^\s*- claude_home:\/home\/node\s*$/m);
  });

  it('declares the named volume at the top level so it survives `docker compose down`', () => {
    expect(composeFile).toMatch(/^volumes:\s*$/m);
    expect(composeFile).toMatch(/^\s{2}claude_home:\s*$/m);
  });

  /**
   * Regression test for issue #75: '.:/app' bind-mounts the host repo checkout over the image's
   * /app, replacing its ownership too - so if the host checkout isn't owned by uid 1000 (the
   * 'node' user), writes to .harness/ (e.g. saveLastCatchupAt in src/catchup.ts) fail with
   * EACCES. A named volume mounted on /app/.harness, seeded from the image at build time
   * (see Dockerfile), keeps that path's ownership independent of the host bind mount.
   */
  it('mounts a named volume on .harness so it is writable regardless of host checkout ownership', () => {
    expect(composeFile).toMatch(/^\s*- harness_state:\/app\/\.harness\s*$/m);
  });

  it('declares the harness_state named volume at the top level', () => {
    expect(composeFile).toMatch(/^\s{2}harness_state:\s*$/m);
  });
});

/**
 * Regression test for issue #84: under rootless Docker the bind-mounted repo (`.:/app`) is owned,
 * inside the container, by root - so the non-root `node` user the harness runs as can't write
 * `/app/.git`, and every git operation fails with EACCES, stalling the loop. The container must
 * therefore start as root and realign `/app`'s ownership onto `node` via an entrypoint before
 * dropping privileges (with gosu). No Docker daemon is available in the sandbox, so this asserts
 * the Dockerfile/entrypoint are wired correctly instead of spinning up the container - the runtime
 * branching behavior is covered by test/entrypoint.test.ts.
 */
describe('Dockerfile + docker-entrypoint.sh (rootless ownership realignment)', () => {
  const dir = join(import.meta.dirname, '..');
  const dockerfile = readFileSync(join(dir, 'Dockerfile'), 'utf-8');
  const entrypoint = readFileSync(join(dir, 'docker-entrypoint.sh'), 'utf-8');

  it('installs gosu (used to drop from root to node after the chown)', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bgosu\b/);
  });

  it('pins HOME to /home/node so gosu / exec -u node still find git/claude config there', () => {
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/node\s*$/m);
  });

  it('wires the entrypoint script and ends up back as root so it can chown at runtime', () => {
    expect(dockerfile).toMatch(/ENTRYPOINT\s+\[.*docker-entrypoint\.sh.*\]/);
    // The final USER directive before the entrypoint must be root, otherwise the entrypoint
    // couldn't chown the bind mount. Grab the last `USER` line and assert it's root.
    const userDirectives = dockerfile.match(/^USER\s+(\S+)/gm) ?? [];
    expect(userDirectives.at(-1)).toBe('USER root');
  });

  it('the entrypoint chowns /app to node then execs via gosu node, only when running as root', () => {
    expect(entrypoint).toMatch(/id -u/);
    expect(entrypoint).toContain('chown node:node');
    expect(entrypoint).toMatch(/exec gosu node "\$@"/);
    // -xdev keeps the chown on the bind mount's own filesystem, skipping the volumes mounted over
    // subpaths of /app (node_modules, .harness) which are already node-owned and potentially large.
    expect(entrypoint).toContain('-xdev');
  });
});
