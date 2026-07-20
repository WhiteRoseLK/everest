import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Exercises the `.claude/hooks/*.sh` PreToolUse hooks directly, feeding them the same JSON shape
 * Claude Code writes to their stdin (`{"tool_name": ..., "tool_input": {...}}`), rather than going
 * through a full Claude Code session (issue #85).
 *
 * Fake secret values below are built via string concatenation rather than written as literals -
 * otherwise this very file, once saved to disk via the Write tool, would trip the hook it's
 * testing.
 */
const BLOCK_SECRETS = join(import.meta.dirname, '../.claude/hooks/block-secrets.sh');
const ENFORCE_QUALITY = join(
  import.meta.dirname,
  '../.claude/hooks/enforce-quality-before-commit.sh',
);
const FAKE_GITHUB_TOKEN = ['gh', 'p_', '1234567890abcdef'].join('');
const FAKE_ANTHROPIC_KEY = ['sk-', 'ant-', 'abcdefghijklmnopqrstuvwx'].join('');
const FAKE_AWS_KEY = ['AK', 'IAABCDEFGHIJKLMNOP'].join('');

/** Runs a hook script with the given JSON piped to stdin, returning its exit code and stderr. */
function runHook(
  script: string,
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string } {
  const result = spawnSync('bash', [script], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env,
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

describe('block-secrets.sh', () => {
  it('blocks a Bash command containing a likely secret', () => {
    const { status, stderr } = runHook(BLOCK_SECRETS, {
      tool_name: 'Bash',
      tool_input: { command: `echo ${FAKE_AWS_KEY}` },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('BLOCKED');
  });

  it('allows a Bash command with no secret pattern', () => {
    const { status } = runHook(BLOCK_SECRETS, {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    });
    expect(status).toBe(0);
  });

  it('blocks a secret written via the Write tool (previously unchecked - issue #85)', () => {
    const { status, stderr } = runHook(BLOCK_SECRETS, {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.ts', content: `const token = "${FAKE_GITHUB_TOKEN}";` },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('BLOCKED');
  });

  it('allows a Write with no secret pattern', () => {
    const { status } = runHook(BLOCK_SECRETS, {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.ts', content: 'export const x = 1;' },
    });
    expect(status).toBe(0);
  });

  it('blocks a secret introduced via the Edit tool new_string', () => {
    const { status, stderr } = runHook(BLOCK_SECRETS, {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/tmp/x.ts',
        old_string: 'const token = "";',
        new_string: `const token = "${FAKE_ANTHROPIC_KEY}";`,
      },
    });
    expect(status).toBe(2);
    expect(stderr).toContain('BLOCKED');
  });

  it('does not flag a secret pattern that only appears in old_string (not newly introduced)', () => {
    const { status } = runHook(BLOCK_SECRETS, {
      tool_name: 'Edit',
      tool_input: {
        file_path: '/tmp/x.ts',
        old_string: `const token = "${FAKE_ANTHROPIC_KEY}";`,
        new_string: 'const token = "";',
      },
    });
    expect(status).toBe(0);
  });

  it('ignores tools it does not cover (e.g. Read)', () => {
    const { status } = runHook(BLOCK_SECRETS, {
      tool_name: 'Read',
      tool_input: { file_path: `/tmp/${FAKE_AWS_KEY}` },
    });
    expect(status).toBe(0);
  });
});

describe('enforce-quality-before-commit.sh', () => {
  let fakeBin: string;
  let projectDir: string;
  let npmMarker: string;

  /** Writes a fake `npm` on PATH that records each invocation and exits with the given code. */
  function writeFakeNpm(exitCode: number): void {
    const path = join(fakeBin, 'npm');
    writeFileSync(path, `#!/usr/bin/env bash\necho "$*" >> "${npmMarker}"\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
  }

  beforeEach(() => {
    fakeBin = mkdtempSync(join(tmpdir(), 'everest-hooks-'));
    projectDir = mkdtempSync(join(tmpdir(), 'everest-hooks-project-'));
    npmMarker = join(fakeBin, 'npm.marker');
    writeFileSync(npmMarker, '');
    writeFakeNpm(0);
  });

  afterEach(() => {
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function runWithCommand(command: string): { status: number; stderr: string } {
    return runHook(
      ENFORCE_QUALITY,
      { tool_name: 'Bash', tool_input: { command } },
      {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CLAUDE_PROJECT_DIR: projectDir,
      },
    );
  }

  it('runs lint/test for a plain git commit', () => {
    const { status } = runWithCommand('git commit -m "x"');
    expect(status).toBe(0);
    expect(readFileSync(npmMarker, 'utf-8')).toContain('run lint');
  });

  it('runs lint/test for git commit chained after another command (previously bypassable)', () => {
    const { status } = runWithCommand('cd sub && git commit -m "x"');
    expect(status).toBe(0);
    expect(readFileSync(npmMarker, 'utf-8')).toContain('run lint');
  });

  it('runs lint/test for a git commit prefixed with an env assignment (previously bypassable)', () => {
    const { status } = runWithCommand('env FOO=bar git commit -m "x"');
    expect(status).toBe(0);
    expect(readFileSync(npmMarker, 'utf-8')).toContain('run lint');
  });

  it('runs lint/test for `git -C <path> commit` (previously bypassable)', () => {
    const { status } = runWithCommand('git -C . commit -m "x"');
    expect(status).toBe(0);
    expect(readFileSync(npmMarker, 'utf-8')).toContain('run lint');
  });

  it('blocks the commit if lint fails', () => {
    writeFakeNpm(1);
    const { status, stderr } = runWithCommand('git commit -m "x"');
    expect(status).toBe(2);
    expect(stderr).toContain('LINT FAILED');
  });

  it('does not run lint/test for an unrelated command that merely mentions "git commit" in a string', () => {
    const { status } = runWithCommand('echo "please run git commit later"');
    expect(status).toBe(0);
    expect(existsSync(npmMarker)).toBe(true);
    expect(readFileSync(npmMarker, 'utf-8')).toBe('');
  });

  it('does not run lint/test for an unrelated git command', () => {
    const { status } = runWithCommand('git status');
    expect(status).toBe(0);
    expect(readFileSync(npmMarker, 'utf-8')).toBe('');
  });
});
