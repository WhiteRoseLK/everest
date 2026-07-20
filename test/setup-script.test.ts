import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Regression test for issue #71: a fresh VPS deploy following the README's old
 * `npm install && npm start` instructions required Node/npm and `gh` on the host, even though
 * the `harness` container already bundles both (see Dockerfile). There is no Docker daemon
 * available in the test sandbox to actually run the bootstrap, so this asserts the script is
 * present, executable, and wired to the right commands instead.
 *
 * The script deliberately does not install Docker itself (explicit product decision, not left
 * out by oversight) - Docker is a documented prerequisite (see README) and the script just
 * checks for it with a clear error pointing back to that section.
 */
describe('setup.sh', () => {
  const scriptPath = join(import.meta.dirname, '../setup.sh');
  const script = readFileSync(scriptPath, 'utf-8');

  it('is executable', () => {
    const mode = statSync(scriptPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('does not attempt to install Docker itself', () => {
    expect(script).not.toMatch(/get\.docker\.com/);
    expect(script).not.toMatch(/apt-get install/);
  });

  it('checks for Docker and points to the README prerequisites when missing', () => {
    expect(script).toMatch(/command -v docker/);
    expect(script).toMatch(/Prérequis/);
  });

  it('checks for the docker compose plugin', () => {
    expect(script).toMatch(/docker compose version/);
  });

  it('bootstraps .env from .env.example when missing', () => {
    expect(script).toMatch(/cp \.env\.example \.env/);
  });

  it('starts the harness service via docker compose', () => {
    expect(script).toMatch(/docker compose .*up -d --build harness/);
  });

  it('refers to the running product as Everest, not "harnais", in its own output', () => {
    expect(script).toMatch(/Everest est démarré/);
    expect(script).not.toMatch(/Harnais démarré/);
  });

  /**
   * Regression test: the operator asked for a one-command way to talk to Everest (`everest`)
   * without needing Node on the host, since the host's only prerequisite is Docker (see README).
   * setup.sh installs a shell alias that routes through the container instead.
   */
  it('installs an `everest` shell alias that runs the CLI inside the container as the node user', () => {
    expect(script).toMatch(/alias everest=/);
    // `-u node`: the container starts as root (its entrypoint realigns /app ownership before
    // dropping to node - issue #84), so the alias must exec as node, not root.
    expect(script).toMatch(/docker compose .*exec -u node harness node bin\/everest\.js/);
  });

  it('is idempotent about the alias: skips re-adding it if already up to date', () => {
    expect(script).toMatch(/grep -qF "alias everest=" "\$rc_file"/);
    expect(script).toMatch(/déjà à jour/);
  });

  /**
   * Regression test for issue #95: after #84 changed the alias definition (added `-u node`),
   * hosts that had already run setup.sh kept the stale alias forever, since `ensure_alias` used
   * to only check whether *an* `alias everest=` line existed, not whether it matched the current
   * definition. Runs `ensure_alias` for real (the script is made sourceable via the
   * `BASH_SOURCE`/`$0` guard at the bottom) against a temp rc file seeded with an old-style alias.
   */
  describe('ensure_alias (executed)', () => {
    function runEnsureAlias(rcFileContent: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'setup-alias-test-'));
      const rcFile = join(dir, 'rcfile');
      writeFileSync(rcFile, rcFileContent);
      execFileSync(
        'bash',
        ['-c', `source "${scriptPath}"; shell_rc_file() { echo "${rcFile}"; }; ensure_alias`],
        { encoding: 'utf-8' },
      );
      return readFileSync(rcFile, 'utf-8');
    }

    it('replaces a stale alias (missing -u node) with the current definition', () => {
      const before = [
        '# some existing rc content',
        `alias everest='docker compose --project-directory "/old/path" exec harness node bin/everest.js'`,
        '',
      ].join('\n');

      const after = runEnsureAlias(before);

      expect(after).not.toMatch(/exec harness node bin\/everest\.js/);
      expect(after).toMatch(/exec -u node harness node bin\/everest\.js/);
      // The unrelated pre-existing content is preserved, not wiped out.
      expect(after).toMatch(/# some existing rc content/);
      // Only one alias line remains, not both old and new stacked.
      expect(after.match(/alias everest=/g)?.length).toBe(1);
    });

    it('leaves an already up-to-date alias untouched', () => {
      const before = runEnsureAlias('');
      const after = runEnsureAlias(before);

      expect(after).toBe(before);
    });
  });
});
