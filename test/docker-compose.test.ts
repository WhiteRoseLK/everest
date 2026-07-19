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
