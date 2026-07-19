import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for issue #71: a fresh VPS deploy following the README's old
 * `npm install && npm start` instructions required Node/npm and `gh` on the host, even though
 * the `harness` container already bundles both (see Dockerfile). There is no Docker daemon
 * available in the test sandbox to actually run the bootstrap, so this asserts the script is
 * present, executable, and wired to the right commands instead.
 */
describe('setup.sh', () => {
  const scriptPath = join(import.meta.dirname, '../setup.sh');
  const script = readFileSync(scriptPath, 'utf-8');

  it('is executable', () => {
    const mode = statSync(scriptPath).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('installs Docker automatically when missing', () => {
    expect(script).toMatch(/get\.docker\.com/);
  });

  it('bootstraps .env from .env.example when missing', () => {
    expect(script).toMatch(/cp \.env\.example \.env/);
  });

  it('starts the harness service via docker compose', () => {
    expect(script).toMatch(/docker compose up -d --build harness/);
  });
});
