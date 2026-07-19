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
});
