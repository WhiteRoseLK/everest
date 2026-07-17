#!/usr/bin/env node
// Thin launcher for the `everest` CLI (see src/cli.ts). The project has no build step yet
// (`npm start` also runs its entry point directly via tsx), so this wrapper shells out to the
// locally installed `tsx` binary instead of requiring a `dist/` compile step just for the CLI.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'src', 'cli.ts');
const tsxBin = join(here, '..', 'node_modules', '.bin', 'tsx');

const result = spawnSync(tsxBin, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
